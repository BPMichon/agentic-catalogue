/**
 * The git graph.
 *
 * ONE plain ES module, served as-is into `<iframe sandbox="allow-scripts">` with
 * no allow-same-origin. No bundler, no imports — not even a relative one, since
 * only this entry file is reachable from the frame. See docs/PluginApps.md; the
 * short version is that the following fail SILENTLY here, with no exception:
 * confirm/prompt/alert, fetch, localStorage, window.parent, a submitting form,
 * and downloading a Blob.
 *
 * Two consequences shape the code below:
 *
 *   - THERE IS NO PERSISTENCE. The selected repository cannot be remembered
 *     across a frame reload. `mount` runs once and is never torn down, so the
 *     selection lives exactly as long as the tab, and that is the whole promise.
 *   - THERE IS NO CLIPBOARD I WOULD TRUST. Whether navigator.clipboard works from
 *     an opaque origin is not something this was able to establish, and
 *     execCommand("copy") is no better a bet — both fail silently if they fail.
 *     So there is no copy button; SHAs are selectable text instead. A dead button
 *     is worse than no button.
 */

/** Row height and lane pitch, in px. The SVG and the text rows share both. */
const ROW_H = 26;
const LANE_W = 14;
const DOT_R = 3.5;

/**
 * Lanes drawn before the graph stops widening.
 *
 * A column that grows without bound eventually owns the whole tab, so there has
 * to be a limit. Past it, commits pin to the last lane and are marked — visibly
 * lossy, which is the point, because silently drawing them in a lane that is not
 * theirs would not be.
 *
 * 32 IS MEASURED, NOT GUESSED. Against the repositories this was built for, the
 * widest real history needed 27 (`dynamics`); `alm` needs 9 and `terraform` 12.
 * At 24 the first of those lost a commit to the cap. Raise it if a project ever
 * legitimately needs more — the column is only ever as wide as `width`, so the
 * cost of headroom is nothing until it is used.
 */
const MAX_LANES = 32;

/**
 * Assign every commit a lane, and describe the edges between them.
 *
 * One sweep, newest first. `lanes[i]` holds the SHA that lane i is currently
 * waiting to draw — the commit some already-drawn child named as a parent.
 *
 * Per row: the commit takes the lane already waiting for it, or the leftmost free
 * lane if none is — which is what a branch tip looks like. Its FIRST parent then
 * inherits that lane, so a straight line of history stays in one column; every
 * other parent is a merge and takes a lane of its own.
 *
 * TWO THINGS HERE WERE LEARNED THE HARD WAY, both from real history rather than
 * from reasoning about it:
 *
 * 1. SEVERAL LANES CAN WAIT FOR THE SAME COMMIT. Branches that share a base all
 *    name it as a parent, and they converge on the row where it is finally drawn.
 *    Releasing only the lane the commit is drawn in leaks every duplicate, and the
 *    leak compounds: on this repository's own `alm` it wanted 506 lanes where git
 *    itself draws 10. `incoming` is that fix — all of them are released.
 *
 * 2. EXACTLY ONE SEGMENT PER OCCUPIED LANE PER ROW. An earlier version also drew
 *    a long edge from a merge straight down to a distant parent, which the
 *    per-row segments had already covered — 43,000 overlapping paths for 1,827
 *    commits. So the outgoing pass looks ONE ROW AHEAD to see whether a lane is
 *    about to converge, and bends that single segment instead of adding another.
 *
 * O(rows × lanes): every inner scan is over the lane array, never the log.
 *
 * EXPORTED, AND NOT ONLY FOR `mount`. This is the one piece of real algorithm in
 * the plugin, and a wrong lane does not throw — it draws a graph that looks
 * plausible and is wrong, which is the worst way for this to fail. It is pure and
 * touches no DOM precisely so ui/layout.test.ts can run it under plain node.
 */
export function layout(rows) {
	const lanes = [];
	const placed = [];
	const edges = [];
	let width = 1;

	/** The lane already waiting for `sha`, or a newly reserved one. */
	const claim = (sha) => {
		const waiting = lanes.indexOf(sha);
		if (waiting !== -1) return waiting;
		const free = lanes.indexOf(null);
		if (free !== -1) {
			lanes[free] = sha;
			return free;
		}
		if (lanes.length < MAX_LANES) {
			lanes.push(sha);
			return lanes.length - 1;
		}
		// Out of lanes. Pin to the last one rather than inventing a column.
		return MAX_LANES - 1;
	};

	/** Which lane the commit at `row` will be drawn in, given the lanes as they are. */
	const laneFor = (sha) => {
		const waiting = lanes.indexOf(sha);
		return waiting === -1 ? -1 : waiting;
	};

	rows.forEach((commit, row) => {
		// Every lane waiting for this commit converges on this row.
		const incoming = [];
		for (let i = 0; i < lanes.length; i += 1) {
			if (lanes[i] === commit.sha) incoming.push(i);
		}

		const lane = incoming.length > 0 ? incoming[0] : claim(commit.sha);
		// `claim` parks the SHA in whatever lane it returns — EXCEPT when it ran out
		// and pinned this commit to the last one. A lane not holding this commit is
		// exactly the signal that the cap bit on this row.
		const overflow = incoming.length === 0 && lanes[lane] !== commit.sha;

		// Release all of them, not just `lane`. See note 1 above.
		for (const i of incoming) lanes[i] = null;
		lanes[lane] = null;

		commit.parents.forEach((parent, index) => {
			if (index === 0) lanes[lane] = parent;
			else claim(parent);
		});

		placed.push({ commit, row, lane, overflow });
		width = Math.max(width, lanes.length);

		// One segment per occupied lane, from this row to the next. A lane whose
		// awaited commit is the NEXT row bends into that commit's lane here rather
		// than being drawn straight and corrected later. See note 2 above.
		//
		// Nothing is drawn below the last row: lanes still waiting there are parents
		// the log never delivered, and the count banner is what says there is more.
		const next = rows[row + 1];
		if (next === undefined) return;

		const nextLane = laneFor(next.sha);
		for (let i = 0; i < lanes.length; i += 1) {
			if (!lanes[i]) continue;
			const converging = lanes[i] === next.sha && nextLane !== -1;
			edges.push({ from: row, to: row + 1, lane: i, toLane: converging ? nextLane : i });
		}
	});

	return { placed, edges, width: Math.min(width, MAX_LANES) };
}

export async function mount(root, api) {
	let repos = [];
	let repoId = "";
	let commits = [];
	let truncated = false;
	let filter = "";
	let selected = "";
	let status = "";
	let error = "";

	// Every load carries a token, and a reply holding a stale one is dropped.
	// Without this, clicking through three repositories renders whichever call
	// happens to answer last rather than the one that is selected.
	let token = 0;

	const esc = (value) =>
		String(value).replace(
			/[&<>"']/g,
			(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
		);

	// ---------------------------------------------------------------- the graph

	/**
	 * Lane colours.
	 *
	 * The token set has no categorical palette — it has one accent and a few
	 * status colours — so these are derived. `oklch` keeps perceived lightness
	 * even across hues, which is what stops a yellow lane vanishing while a blue
	 * one shouts, and one lightness reads on both themes. This is Electron, so
	 * Chromium's oklch support is a given.
	 */
	const laneColor = (lane) => `oklch(66% 0.15 ${(lane * 47) % 360})`;

	function svg(placed, edges, width) {
		const x = (lane) => lane * LANE_W + LANE_W / 2;
		const y = (row) => row * ROW_H + ROW_H / 2;

		// ONE <path> PER LANE, not per segment. A lane's segments all share a colour,
		// and `d` takes as many subpaths as you like — so a 2000-row graph is ~24
		// elements rather than the ~20,000 that one-element-per-segment produced.
		const byLane = new Map();
		for (const edge of edges) {
			const x1 = x(edge.lane);
			const x2 = x(edge.toLane);
			const y1 = y(edge.from);
			const y2 = y(edge.to);
			const d =
				x1 === x2
					? `M${x1} ${y1}V${y2}`
					: // A curve rather than a diagonal: the bend reads as "this branch moved
						// across", where a straight line reads as a crossing.
						`M${x1} ${y1}C${x1} ${y1 + ROW_H * 0.6} ${x2} ${y2 - ROW_H * 0.6} ${x2} ${y2}`;
			// Keyed on the destination lane, so a bend takes the colour of the lane it
			// joins and a branch reads as one continuous colour.
			byLane.set(edge.toLane, (byLane.get(edge.toLane) ?? "") + d);
		}

		const paths = [...byLane]
			.map(([lane, d]) => `<path d="${d}" fill="none" stroke="${laneColor(lane)}" stroke-width="1.6"/>`)
			.join("");

		const dots = placed
			.map(
				(entry) =>
					`<circle cx="${x(entry.lane)}" cy="${y(entry.row)}" r="${
						entry.commit.parents.length > 1 ? DOT_R + 1 : DOT_R
					}" fill="${laneColor(entry.lane)}" stroke="var(--ap-solid, #fff)" stroke-width="1.5"${
						entry.overflow ? ' opacity="0.45"' : ""
					}/>`,
			)
			.join("");

		const height = placed.length * ROW_H;
		return `<svg width="${width * LANE_W}" height="${height}" viewBox="0 0 ${
			width * LANE_W
		} ${height}" aria-hidden="true">${paths}${dots}</svg>`;
	}

	// --------------------------------------------------------------- rendering

	// Built ONCE. The rows are replaced on every redraw; these are not, because
	// re-creating the filter input would destroy the element being typed into and
	// take focus with it.
	root.innerHTML = `
		<div class="bar">
			<select id="repo" aria-label="Repository"></select>
			<input id="filter" type="search" placeholder="Filter subject, author or SHA…" aria-label="Filter commits">
			<span id="status" class="muted"></span>
		</div>
		<div id="body" class="body"></div>`;

	const repoEl = root.querySelector("#repo");
	const filterEl = root.querySelector("#filter");
	const statusEl = root.querySelector("#status");
	const bodyEl = root.querySelector("#body");

	function visible() {
		const needle = filter.trim().toLowerCase();
		if (!needle) return commits;
		return commits.filter(
			(commit) =>
				commit.subject.toLowerCase().includes(needle) ||
				commit.author.toLowerCase().includes(needle) ||
				commit.sha.startsWith(needle),
		);
	}

	function refName(ref) {
		// "HEAD -> main" is two facts in one string; the arrow is noise once HEAD
		// is styled differently anyway.
		if (ref.startsWith("HEAD -> ")) return { label: ref.slice(8), kind: "head" };
		if (ref === "HEAD") return { label: "HEAD", kind: "head" };
		if (ref.startsWith("tag: ")) return { label: ref.slice(5), kind: "tag" };
		return { label: ref, kind: "ref" };
	}

	function renderStatus() {
		statusEl.textContent = status;
		statusEl.className = error ? "bad" : "muted";
	}

	function renderRows() {
		renderStatus();

		if (error) {
			// Rendered as written, on purpose. A kernel refusal is multi-line and the
			// half a paraphrase drops is the half naming what to fix.
			bodyEl.innerHTML = `<pre class="error">${esc(error)}</pre>`;
			return;
		}
		if (!repoId) {
			bodyEl.innerHTML = `<p class="empty">${
				repos.length ? "Choose a repository." : "This project declares no repositories."
			}</p>`;
			return;
		}

		const rows = visible();
		if (rows.length === 0) {
			bodyEl.innerHTML = `<p class="empty">${
				commits.length ? "No commit matches that filter." : "No commits yet."
			}</p>`;
			return;
		}

		const { placed, edges, width } = layout(rows);

		const list = placed
			.map(({ commit, overflow }) => {
				const refs = commit.refs
					.map(refName)
					.map((ref) => `<span class="ref ${ref.kind}">${esc(ref.label)}</span>`)
					.join("");
				return `<div class="row${commit.sha === selected ? " on" : ""}" data-sha="${esc(commit.sha)}" role="button" tabindex="0">
					<code class="sha">${esc(commit.sha.slice(0, 8))}</code>
					<span class="subject">${overflow ? '<span class="over" title="Beyond the lane limit">⋯</span>' : ""}${refs}${esc(commit.subject)}</span>
					<span class="who">${esc(commit.author)}</span>
					<time datetime="${esc(commit.date)}">${esc(when(commit.date))}</time>
				</div>`;
			})
			.join("");

		bodyEl.innerHTML = `
			${truncated ? `<p class="note">Showing the most recent ${commits.length} commits. Older history is not drawn.</p>` : ""}
			<div class="graph" style="--graph-w:${width * LANE_W}px">
				<div class="lanes">${svg(placed, edges, width)}</div>
				<div class="rows">${list}</div>
			</div>
			${selected ? detail(commits.find((commit) => commit.sha === selected)) : ""}`;

		for (const row of bodyEl.querySelectorAll(".row")) {
			const pick = () => {
				selected = selected === row.dataset.sha ? "" : row.dataset.sha;
				renderRows();
			};
			row.addEventListener("click", pick);
			row.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					pick();
				}
			});
		}
	}

	function detail(commit) {
		if (!commit) return "";
		return `<div class="detail">
			<code class="full">${esc(commit.sha)}</code>
			<p>${esc(commit.subject)}</p>
			<p class="muted">${esc(commit.author)} · ${esc(new Date(commit.date).toLocaleString())}</p>
			<p class="muted">${
				commit.parents.length
					? `${commit.parents.length > 1 ? "Merge of" : "Parent"} ${commit.parents
							.map((parent) => `<code>${esc(parent.slice(0, 8))}</code>`)
							.join(" ")}`
					: "Root commit — no parents."
			}</p>
		</div>`;
	}

	function when(iso) {
		const then = new Date(iso).getTime();
		if (Number.isNaN(then)) return "";
		const days = Math.floor((Date.now() - then) / 86_400_000);
		if (days < 1) return "today";
		if (days < 2) return "yesterday";
		if (days < 31) return `${days}d ago`;
		if (days < 365) return `${Math.floor(days / 30)}mo ago`;
		return `${Math.floor(days / 365)}y ago`;
	}

	// ------------------------------------------------------------------ loading

	async function load(id) {
		const mine = ++token;
		repoId = id;
		commits = [];
		truncated = false;
		selected = "";
		error = "";
		status = id ? `Reading ${id}…` : "";
		renderRows();
		if (!id) return;

		try {
			const { result } = await api.invoke("git.log", { repoId: id });
			if (mine !== token) return;
			commits = result.commits;
			truncated = result.truncated;
			status = `${result.count} commit${result.count === 1 ? "" : "s"}${truncated ? ", capped" : ""}`;
		} catch (failure) {
			if (mine !== token) return;
			error = failure.message;
			status = "failed";
		}
		renderRows();
	}

	// Model on input, redraw the rows only — never the input itself.
	filterEl.addEventListener("input", (event) => {
		filter = event.target.value;
		selected = "";
		renderRows();
	});
	repoEl.addEventListener("change", (event) => void load(event.target.value));

	root.insertAdjacentHTML(
		"beforebegin",
		`<style>
			/* The frame is the OPAQUE tier: the shell may be translucent over the
			   wallpaper, this page is not. Every token carries a fallback because the
			   web shell sends none of them, and a hardcoded palette is the single most
			   likely thing to be wrong with a plugin app. */
			* { box-sizing: border-box; }
			body { margin: 0; color: var(--ap-fg, #16181d); background: var(--ap-solid, #fff);
			       color-scheme: var(--ap-color-scheme, light);
			       font: 12.5px/1.45 system-ui, sans-serif; }
			.bar { position: sticky; top: 0; z-index: 1; display: flex; gap: 8px; align-items: center;
			       padding: 8px 12px; background: var(--ap-solid, #fff);
			       border-bottom: 1px solid var(--ap-line, #e2e5ea); }
			select, input { color: inherit; background: transparent; font: inherit; padding: 3px 6px;
			                border: 1px solid var(--ap-line, #e2e5ea); border-radius: var(--ap-radius, 4px); }
			input { flex: 1; min-width: 0; }
			select { max-width: 240px; }
			.muted { color: var(--ap-muted, #5c6370); font-size: 11.5px; white-space: nowrap; }
			.bad { color: var(--ap-bad, #b4232a); font-size: 11.5px; }
			.empty, .note { color: var(--ap-muted, #5c6370); padding: 12px; margin: 0; }
			.note { border-bottom: 1px solid var(--ap-line, #e2e5ea); }
			.error { color: var(--ap-bad, #b4232a); padding: 12px; margin: 0;
			         white-space: pre-line; font: inherit; }

			/* The SVG and the rows are two columns of one grid, so a row's dot and its
			   text cannot drift apart — they share ROW_H and nothing else aligns them. */
			.graph { display: grid; grid-template-columns: var(--graph-w) 1fr; align-items: start; }
			.lanes { padding-left: 8px; }
			.lanes svg { display: block; }
			.row { display: grid; grid-template-columns: 66px 1fr auto 76px; gap: 10px; align-items: center;
			       height: ${ROW_H}px; padding: 0 12px 0 4px; cursor: pointer; }
			.row:hover { background: color-mix(in srgb, var(--ap-fg, #000) 5%, transparent); }
			.row.on { background: color-mix(in srgb, var(--ap-accent, #3b6ef5) 14%, transparent); }
			.sha { color: var(--ap-muted, #5c6370); font: 11px ui-monospace, monospace; }
			.subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.who, time { color: var(--ap-muted, #5c6370); font-size: 11px; white-space: nowrap;
			             overflow: hidden; text-overflow: ellipsis; }
			time { text-align: right; }
			.over { color: var(--ap-warn, #a06800); margin-right: 4px; }

			.ref { display: inline-block; margin-right: 4px; padding: 0 4px; border-radius: 3px;
			       font-size: 10.5px; vertical-align: 1px;
			       border: 1px solid color-mix(in srgb, currentColor 35%, transparent); }
			.ref.head { color: var(--ap-accent, #3b6ef5); font-weight: 600; }
			.ref.tag { color: var(--ap-warn, #a06800); }
			.ref.ref { color: var(--ap-muted, #5c6370); }

			.detail { position: sticky; bottom: 0; padding: 10px 12px; background: var(--ap-solid, #fff);
			          border-top: 1px solid var(--ap-line, #e2e5ea); }
			.detail p { margin: 3px 0; }
			/* Selectable, because there is no copy button that can be trusted here. */
			.full { font: 11.5px ui-monospace, monospace; user-select: all; }
			code { font: 11.5px ui-monospace, monospace; }
		</style>`,
	);

	// mount() is async and the frame shows a placeholder until it settles; if this
	// throws, the frame prints the message in place of the UI rather than blanking.
	try {
		const { result } = await api.invoke("git.repos", {});
		repos = result.repos;
	} catch (failure) {
		error = failure.message;
		status = "failed";
		renderRows();
		return;
	}

	repoEl.innerHTML =
		`<option value="">${repos.length ? "Choose a repository…" : "No repositories"}</option>` +
		repos
			.map(
				(repo) =>
					`<option value="${esc(repo.id)}"${repo.present ? "" : " disabled"}>${esc(repo.id)}${
						repo.present ? "" : " (not on disk)"
					}</option>`,
			)
			.join("");

	// One usable repository is not a choice worth making.
	const usable = repos.filter((repo) => repo.present);
	if (usable.length === 1) {
		repoEl.value = usable[0].id;
		await load(usable[0].id);
	} else {
		status = `${usable.length} repositor${usable.length === 1 ? "y" : "ies"}`;
		renderRows();
	}
}
