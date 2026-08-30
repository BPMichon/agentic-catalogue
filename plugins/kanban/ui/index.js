/**
 * The board.
 *
 * ONE plain ES module, served as-is into `<iframe sandbox="allow-scripts">` with
 * no allow-same-origin. No bundler, no imports — not even a relative one, since
 * only this entry file is reachable from the frame. See docs/PluginApps.md; the
 * short version is that the following fail SILENTLY here, with no exception:
 * confirm/prompt/alert, fetch, localStorage, window.parent, a submitting form,
 * and downloading a Blob.
 *
 * THE FRAME CANNOT REACH THE BOARD'S SERVER, and that shapes everything below.
 * The frame's CSP is `connect-src 'none'` (shells/desktop/plugin-protocol.ts), so
 * `fetch("http://127.0.0.1:7777/api/state")` from here does nothing at all — not
 * an error, nothing. Every byte of board data therefore arrives through
 * `api.invoke`, which is also why the server's SSE `change` stream is unusable
 * from this side and this polls instead. The poll is `kanban.state`, which is
 * flagged non-mutating precisely so it does not write a run record every three
 * seconds.
 *
 * DRAFTS LIVE IN MODULE STATE, NOT IN THE DOM. A poll can re-render at any
 * moment, and a half-typed card title held only in an `<input>` would vanish when
 * it did. So `composing` and `editing` hold the text and the DOM is drawn from
 * them — which is what makes it safe for the poll to be unconditional rather than
 * paused whenever something has focus.
 */

/** How often to ask for the board again. `serve` pushes to git on its own clock. */
const POLL_MS = 3000;

/** Fields a card editor offers, in the order the front matter uses them. */
const FIELDS = [
	{ key: "title", label: "Title", kind: "line" },
	{ key: "category", label: "Category", kind: "line" },
	{ key: "assignee", label: "Assignee", kind: "line" },
	{ key: "priority", label: "Priority", kind: "line" },
	{ key: "labels", label: "Labels", kind: "line" },
	{ key: "due", label: "Due", kind: "line" },
	{ key: "estimate", label: "Estimate", kind: "line" },
	{ key: "body", label: "Description", kind: "text" },
];

export async function mount(root, api) {
	/** The last answer from `kanban.state`. Null until the first one arrives. */
	let board = null;
	/** A message to show above the board — the last failure, or nothing. */
	let notice = "";
	/** True while a write is in flight, so a second click cannot double-post. */
	let busy = false;
	/** `{ status, category, title }` for the cell whose composer is open. */
	let composing = null;
	/**
	 * The name being typed into "+ Category", or null when it is not open.
	 *
	 * NULL RATHER THAN "" FOR CLOSED, because "" is a legitimate thing to have
	 * typed — an open box someone has just cleared — and the two need to draw
	 * differently. Module state for the same reason as `composing`: the poll can
	 * re-render at any moment and would empty an `<input>` mid-word.
	 */
	let naming = null;
	/** `{ from, to }` while a row's name is being edited, or null. */
	let renaming = null;
	/** The row whose delete is waiting to be confirmed, or null. */
	let deleting = null;
	/**
	 * Rows that are collapsed.
	 *
	 * MODULE STATE, AND DELIBERATELY NOT PERSISTED. Which rows someone has folded
	 * is a view preference, not board data: writing it to `kanban.json` would push
	 * one person's folded rows onto everybody else's board through git. There is
	 * nowhere private to put it either — `localStorage` fails silently in this
	 * sandbox — and a plugin setting would spend a run record on every click. So
	 * it lives as long as the tab does, which is what a view preference is worth.
	 */
	const folded = new Set();
	/** `{ id, fields, base, conflicts }` for the card being edited. */
	let editing = null;
	/** The card id being dragged. dataTransfer is not trustworthy in this sandbox. */
	let dragging = null;
	/**
	 * True while the source form is open over a board that is already configured.
	 *
	 * A FLAG RATHER THAN A DOCTORED `board`, because `board` is replaced wholesale
	 * every three seconds — setting `configured: false` on it showed the form and
	 * then had the next poll snatch it away mid-sentence.
	 */
	let reconfiguring = false;

	root.innerHTML = `
		<div class="kb">
			<div class="kb-bar"></div>
			<div class="kb-body">
				<div class="kb-board"></div>
				<div class="kb-side"></div>
			</div>
		</div>
		<style>${CSS}</style>`;

	const bar = root.querySelector(".kb-bar");
	const columns = root.querySelector(".kb-board");
	const side = root.querySelector(".kb-side");

	// ---------- talking to the plugin --------------------------------------

	/**
	 * Ask for the board.
	 *
	 * Never throws. A failed poll leaves the last good board on screen with the
	 * reason above it, because blanking a board someone is reading is a worse
	 * answer to a transient error than showing a stale one and saying so.
	 */
	async function refresh() {
		try {
			board = await call("kanban.state", {});
		} catch (error) {
			notice = error.message;
		}
		drawBar();
		drawBoard();
	}

	/** One action, unwrapped. `invoke` answers `{ result, runId }`. */
	async function call(action, args) {
		const answer = await api.invoke(action, args);
		return answer && "result" in answer ? answer.result : answer;
	}

	/**
	 * A write, then a refresh.
	 *
	 * Serialised on `busy` rather than queued: two moves of the same card racing
	 * each other would both succeed and the loser would be invisible. A dropped
	 * click while the last one is still committing is the honest outcome, and the
	 * board is redrawn either way.
	 */
	async function mutate(action, args) {
		if (busy) return null;
		busy = true;
		notice = "";
		drawBar();
		try {
			return await call(action, args);
		} catch (error) {
			// A kernel refusal is a multi-line message naming every blocker. Shown as
			// written — the half a paraphrase loses is the half that says what to fix.
			notice = error.message;
			return null;
		} finally {
			busy = false;
			await refresh();
		}
	}

	// ---------- the bar ----------------------------------------------------

	function drawBar() {
		if (!board) {
			bar.innerHTML = `<span class="kb-muted">Reading the board…</span>`;
			return;
		}

		const bits = [];
		if (board.configured) {
			bits.push(`<span class="kb-src" title="${esc(board.remote || board.dir)}">${esc(short(board.remote) || board.dir)}</span>`);
			if (board.head) bits.push(`<span class="kb-mono kb-muted">${esc(String(board.head).slice(0, 8))}</span>`);
			bits.push(
				board.running
					? `<span class="kb-dot kb-ok"></span><span class="kb-muted">syncing</span>`
					: `<span class="kb-dot kb-bad"></span><button data-act="serve">Start board</button>`,
			);
			bits.push(`<button data-act="source" class="kb-ghost">Change source</button>`);
		}
		if (busy) bits.push(`<span class="kb-muted">working…</span>`);

		bar.innerHTML = `<div class="kb-row">${bits.join("")}</div>${
			notice ? `<pre class="kb-notice">${esc(notice)}</pre>` : ""
		}`;

		on(bar, "serve", () => mutate("kanban.serve", {}));
		on(bar, "source", () => {
			reconfiguring = true;
			drawBoard();
		});
	}

	// ---------- setup ------------------------------------------------------

	/**
	 * The form that sets the board's git source.
	 *
	 * THIS IS THE "SET THE GITHUB LINK" COMMAND. Not a palette entry: the palette
	 * cannot invoke actions and has nowhere to put a text field, which is stated at
	 * length in desktop/src/chrome/CommandPalette.tsx. A setup screen in the app
	 * that needs the setting is a better place for it anyway.
	 */
	function drawSetup() {
		// Drawn ONCE and then left alone. The three fields here hold what someone is
		// typing, and a three-second poll that re-rendered the form would empty them
		// under the cursor. Nothing about this view changes on its own, so the poll
		// has nothing to add by redrawing it.
		if (columns.dataset.view === "setup") return;
		columns.dataset.view = "setup";

		columns.innerHTML = `
			<div class="kb-setup">
				<h1>Point this project at a board</h1>
				<p class="kb-muted">
					A board is a git repository holding one markdown file per card. Give a GitHub URL and it
					will be cloned; give a folder that is already a clone and it will be used where it is.
				</p>
				<label>Repository
					<input id="kb-url" placeholder="https://github.com/you/board.git" value="${esc(board.remote || "")}">
				</label>
				<label>Folder <span class="kb-muted">— project-relative</span>
					<input id="kb-dir" placeholder=".AgenticProject/board" value="${esc(board.dir || "")}">
				</label>
				<label>Port
					<input id="kb-port" type="number" min="1024" max="65535" placeholder="7777" value="${esc(board.port || "")}">
				</label>
				<div class="kb-row">
					<button data-act="connect" class="kb-primary">Connect</button>
					${reconfiguring ? `<button data-act="cancel" class="kb-ghost">Cancel</button>` : ""}
				</div>
				<p class="kb-muted kb-small">
					Needs git-kanban on PATH: <code>npm i -g github:BPMichon/GitKanban</code>.
					A private repository clones with whatever credentials git already has — no prompt can be
					shown from here, so a clone needing one fails instead of hanging.
				</p>
			</div>`;

		on(columns, "cancel", () => {
			reconfiguring = false;
			refresh();
		});
		on(columns, "connect", async () => {
			const url = columns.querySelector("#kb-url").value.trim();
			const dir = columns.querySelector("#kb-dir").value.trim();
			const port = Number(columns.querySelector("#kb-port").value);

			const args = {};
			if (url) args.url = url;
			if (dir) args.dir = dir;
			if (Number.isInteger(port) && port >= 1024) args.port = port;

			const connected = await mutate("kanban.connect", args);
			if (!connected) return; // The form stays up, with the reason above it.
			reconfiguring = false;
			// Connecting and then having to press Start is two steps for one intent.
			await mutate("kanban.serve", {});
		});
	}

	// ---------- the board --------------------------------------------------

	function drawBoard() {
		if (!board) return;
		if (!board.configured || reconfiguring) return drawSetup();

		if (!board.running) {
			columns.dataset.view = "waiting";
			columns.innerHTML = `
				<div class="kb-setup">
					<h1>The board is not being served yet</h1>
					<p class="kb-muted">
						${esc(board.dir)} is ready. Starting it runs <code>kanban serve</code>, which commits every
						change and pushes and pulls every ten seconds. It stops when this window closes.
					</p>
					${board.problem ? `<pre class="kb-notice">${esc(board.problem)}</pre>` : ""}
					<div class="kb-row"><button data-act="serve" class="kb-primary">Start board</button></div>
				</div>`;
			on(columns, "serve", () => mutate("kanban.serve", {}));
			return;
		}

		const cards = board.cards || [];
		const statuses = board.columns || [];
		const lanes = lanesOf(cards);

		// A poll that changed nothing must not redraw, because redrawing moves the
		// caret out of the composer someone is typing into. The signature covers
		// everything the board draws from, so a real change still lands immediately —
		// and losing focus to a card someone else genuinely moved is fair.
		// WHICH CELL HAS A COMPOSER, NOT WHAT IS IN IT, and `naming !== null` rather
		// than `naming`: both drafts are mutated on every keystroke, so including
		// their text would make the signature differ on every poll and reintroduce
		// exactly the redraw this exists to prevent. Only what the markup depends on
		// belongs here; the text is restored from module state whenever it is drawn.
		const signature = JSON.stringify([
			statuses,
			lanes,
			cards,
			composing && [composing.status, composing.category],
			naming !== null,
			[...folded].sort(),
			renaming && renaming.from,
			deleting,
			editing && editing.id,
		]);
		if (columns.dataset.view === "board" && columns.dataset.sig === signature) return;
		columns.dataset.view = "board";
		columns.dataset.sig = signature;

		// A BOARD WITH NO ROWS DRAWS NO ROW AXIS. No label column, no "(none)" —
		// which is the board exactly as it was before rows existed, so nobody has to
		// opt out of a feature they never asked for. The empty-string lane is both
		// that single unlabelled row and the "(none)" row below a labelled board, so
		// there is one cell renderer rather than two code paths that must agree.
		const labelled = lanes.length > 0;
		const rows = labelled ? [...lanes, ""] : [""];

		columns.innerHTML = `
			<div class="kb-grid" style="grid-template-columns: ${labelled ? "170px " : ""}repeat(${statuses.length}, 260px)">
				${labelled ? `<div class="kb-corner"></div>` : ""}
				${statuses
					.map(
						(status) => `<div class="kb-colhead">
							<span>${esc(status)}</span>
							<span class="kb-count">${cards.filter((entry) => entry.status === status).length}</span>
						</div>`,
					)
					.join("")}
				${rows.map((lane) => laneRow(lane, statuses, cards, labelled)).join("")}
				${newLane()}
			</div>`;

		wireBoard();
		drawSide();
	}

	/**
	 * The rows to draw.
	 *
	 * REGISTERED ROWS FIRST, IN THE BOARD'S ORDER, then any category a card claims
	 * that the board does not list. The server hands a card's category back
	 * uncoerced — unlike its status, which is snapped to a real column — so a row
	 * removed on another machine, or one that arrived on a card before the list
	 * did, still has somewhere to draw its cards. An untidy extra row is a much
	 * smaller problem than a card nobody can see.
	 */
	function lanesOf(cards) {
		const lanes = [];
		const seen = new Set();
		for (const name of [...(board.categories || []).map((entry) => String(entry).trim()), ...cards.map(catOf)]) {
			if (!name || seen.has(name)) continue;
			seen.add(name);
			lanes.push(name);
		}
		return lanes;
	}

	/** One row: its label, then one cell per column — or, folded, a row of counts. */
	function laneRow(lane, statuses, cards, labelled) {
		const mine = cards.filter((entry) => catOf(entry) === lane);
		const at = (status) => mine.filter((entry) => entry.status === status);
		if (!labelled) return statuses.map((status) => cell(status, lane, at(status))).join("");

		// A FOLDED ROW KEEPS ITS CELLS, holding a count instead of cards, rather
		// than collapsing to one strip across the board. The counts stay under the
		// columns they belong to, so a folded row still answers "where is that work"
		// — and the grid keeps one item per track, so nothing below it shifts.
		// It is not a drop target: with no cards shown there is no position to drop
		// into, and a silent append is not what dropping on a row would mean.
		const body = folded.has(lane)
			? statuses.map((status) => `<div class="kb-shut">${at(status).length || ""}</div>`).join("")
			: statuses.map((status) => cell(status, lane, at(status))).join("");

		return laneLabel(lane, mine.length) + body;
	}

	/**
	 * A row's label: fold, name, count, and the way to rename or remove it.
	 *
	 * The name is a button rather than a span so that renaming is reachable by
	 * keyboard and announced as an action; "(none)" is not one, because it is the
	 * absence of a row rather than a row, and has no name to change or remove.
	 */
	function laneLabel(lane, count) {
		if (renaming && renaming.from === lane) {
			return `<div class="kb-lane-label">
				<div class="kb-composer">
					<input data-lane-rename value="${esc(renaming.to)}" aria-label="New name for ${esc(lane)}">
					<div class="kb-row">
						<button data-act="save-rename" class="kb-primary">Rename</button>
						<button data-act="cancel-rename" class="kb-ghost">Cancel</button>
					</div>
				</div>
			</div>`;
		}

		const shut = folded.has(lane);
		return `<div class="kb-lane-label${lane ? "" : " kb-lane-none"}">
			<div class="kb-lane-head">
				<button data-act="fold" data-lane="${esc(lane)}" class="kb-fold" aria-expanded="${shut ? "false" : "true"}"
					title="${shut ? "Expand" : "Collapse"} ${lane ? esc(lane) : "(none)"}">${shut ? "▸" : "▾"}</button>
				${
					lane
						? `<button data-act="rename" data-lane="${esc(lane)}" class="kb-lane-name" title="Rename ${esc(lane)}">${esc(lane)}</button>`
						: `<span class="kb-lane-name">(none)</span>`
				}
				<span class="kb-count">${count}</span>
			</div>
			${lane ? laneTools(lane, count) : ""}
		</div>`;
	}

	/**
	 * Remove a row, with the question asked in place.
	 *
	 * INLINE AND NOT `confirm()`, which does nothing at all in this sandbox — it
	 * returns without showing anything, so a plain confirm would silently mean
	 * "no" and the button would look broken. The count is in the question because
	 * "delete" over a row of work should say what happens to the work: the cards
	 * are kept and moved to (none), never removed.
	 */
	function laneTools(lane, count) {
		if (deleting !== lane) {
			return `<div class="kb-lane-tools">
				<button data-act="ask-delete" data-lane="${esc(lane)}" class="kb-ghost kb-small">Delete</button>
			</div>`;
		}
		return `<div class="kb-lane-confirm">
			<span class="kb-muted">${count ? `Move ${count} card${count === 1 ? "" : "s"} to (none)?` : "Remove this empty row?"}</span>
			<div class="kb-row">
				<button data-act="do-delete" data-lane="${esc(lane)}" class="kb-danger kb-small">Delete</button>
				<button data-act="cancel-delete" class="kb-ghost kb-small">Cancel</button>
			</div>
		</div>`;
	}

	/** One column-and-row cell: a drop target, and a way to add a card into it. */
	function cell(status, lane, cards) {
		const composer =
			composing && composing.status === status && composing.category === lane
				? `<div class="kb-composer">
						<textarea data-compose rows="2" placeholder="Card title">${esc(composing.title)}</textarea>
						<div class="kb-row">
							<button data-act="add" class="kb-primary">Add</button>
							<button data-act="cancel-add" class="kb-ghost">Cancel</button>
						</div>
					</div>`
				: `<button data-act="compose" data-status="${esc(status)}" data-lane="${esc(lane)}" class="kb-add kb-newcard">+ Card</button>`;

		return `<div class="kb-cell">
			<div class="kb-drop" data-column="${esc(status)}" data-category="${esc(lane)}">
				${cards.map(card).join("")}
			</div>
			${composer}
		</div>`;
	}

	/**
	 * "+ Category", under the last row.
	 *
	 * Drawn even on a board with no rows at all — that is the board on which it
	 * matters most, since it is the only way to get the first one.
	 */
	function newLane() {
		const inner =
			naming === null
				? `<button data-act="new-lane" class="kb-add">+ Category</button>`
				: `<div class="kb-composer">
						<input data-lane-name value="${esc(naming)}" placeholder="Category name">
						<div class="kb-row">
							<button data-act="save-lane" class="kb-primary">Add</button>
							<button data-act="cancel-lane" class="kb-ghost">Cancel</button>
						</div>
					</div>`;
		return `<div class="kb-newlane">${inner}</div>`;
	}

	function card(entry) {
		const extra = entry.extra || {};
		const alts = Object.keys(entry.alts || {});
		const tags = [];
		if (extra.priority) tags.push(`<span class="kb-tag kb-p-${esc(slug(extra.priority))}">${esc(extra.priority)}</span>`);
		if (extra.assignee) tags.push(`<span class="kb-tag">${esc(extra.assignee)}</span>`);
		for (const label of String(extra.labels || "").split(",").map((s) => s.trim()).filter(Boolean)) {
			tags.push(`<span class="kb-tag kb-label">${esc(label)}</span>`);
		}

		return `<article class="kb-card${editing && editing.id === entry.id ? " kb-open" : ""}"
				draggable="true" data-card="${esc(entry.id)}">
			<div class="kb-title">${esc(entry.title)}</div>
			${tags.length ? `<div class="kb-tags">${tags.join("")}</div>` : ""}
			<div class="kb-foot">
				<span class="kb-mono kb-muted">${esc(entry.id)}</span>
				${alts.length ? `<span class="kb-warnpill" title="concurrent edits waiting for a decision">⚠ ${esc(alts.join(", "))}</span>` : ""}
			</div>
		</article>`;
	}

	/**
	 * Drag and drop, natively.
	 *
	 * Drop ON A CARD inserts before it; drop on the column's empty space appends.
	 * Those two are the whole of the server's ordering API (`beforeId`, or neither),
	 * and the fractional rank between two neighbours is computed there — this side
	 * never learns the rank format, which is what keeps two clients from disagreeing
	 * about it.
	 *
	 * The dragged id lives in a module variable rather than in `dataTransfer`.
	 * Whether dataTransfer survives an opaque-origin sandbox is not something worth
	 * betting the only interaction on, and a variable works everywhere.
	 */
	function wireBoard() {
		for (const node of columns.querySelectorAll("[data-card]")) {
			node.addEventListener("dragstart", () => {
				dragging = node.dataset.card;
				node.classList.add("kb-dragging");
			});
			node.addEventListener("dragend", () => {
				dragging = null;
				node.classList.remove("kb-dragging");
			});
			node.addEventListener("click", () => openCard(node.dataset.card));
		}

		for (const drop of columns.querySelectorAll(".kb-drop")) {
			drop.addEventListener("dragover", (event) => {
				event.preventDefault();
				drop.classList.add("kb-over");
			});
			drop.addEventListener("dragleave", () => drop.classList.remove("kb-over"));
			drop.addEventListener("drop", (event) => {
				event.preventDefault();
				drop.classList.remove("kb-over");
				if (!dragging) return;

				const over = event.target.closest("[data-card]");
				// BOTH AXES IN ONE CALL. A cell knows its column and its row, so a
				// diagonal drag is one move and one commit rather than a move followed
				// by an edit that could fail on its own. `category` is always sent, and
				// the "(none)" row sends `""`, which the server reads as "clear it" —
				// omitting the key instead would mean "leave it alone", and a card
				// could never be dragged back out of a row.
				const args = {
					id: dragging,
					status: drop.dataset.column,
					category: drop.dataset.category || "",
				};
				if (over && over.dataset.card !== dragging) args.beforeId = over.dataset.card;
				dragging = null;
				mutate("kanban.move", args);
			});
		}

		on(columns, "compose", (node) => {
			composing = { status: node.dataset.status, category: node.dataset.lane || "", title: "" };
			drawBoard();
			const field = columns.querySelector("[data-compose]");
			if (field) field.focus();
		});
		on(columns, "cancel-add", () => {
			composing = null;
			drawBoard();
		});
		on(columns, "add", async () => {
			const draft = composing;
			const title = (draft && draft.title.trim()) || "";
			if (!title) return;
			composing = null;
			// The cell carries the row, so a card added into one is already in it.
			// `category` is omitted rather than sent empty for the "(none)" row: this
			// goes straight into the front matter, and "" would write a blank line.
			const args = { title, status: draft.status };
			if (draft.category) args.category = draft.category;
			await mutate("kanban.add", args);
		});

		const field = columns.querySelector("[data-compose]");
		if (field) {
			// Kept in module state on every keystroke, so a poll landing mid-sentence
			// redraws the composer with the sentence still in it.
			field.addEventListener("input", () => {
				if (composing) composing.title = field.value;
			});
			field.addEventListener("keydown", (event) => {
				if (event.key === "Enter" && !event.shiftKey) {
					event.preventDefault();
					const button = columns.querySelector('[data-act="add"]');
					if (button) button.click();
				}
				if (event.key === "Escape") {
					composing = null;
					drawBoard();
				}
			});
		}

		// ---- "+ Category", the same shape as the card composer above ----

		on(columns, "new-lane", () => {
			naming = "";
			drawBoard();
			const box = columns.querySelector("[data-lane-name]");
			if (box) box.focus();
		});
		on(columns, "cancel-lane", () => {
			naming = null;
			drawBoard();
		});
		on(columns, "save-lane", async () => {
			const name = String(naming ?? "").trim();
			naming = null;
			const existing = (board.categories || []).map((entry) => String(entry).trim()).filter(Boolean);
			// A row that is already there is a no-op, not an error. This button cannot
			// know what somebody else added between two polls, and the endpoint takes
			// the whole list — so the safe answer to "it exists" is to have wanted
			// that, and simply redraw.
			if (!name || existing.includes(name)) return drawBoard();
			await mutate("kanban.categories", { categories: [...existing, name] });
		});

		// ---- folding, renaming and removing a row ----

		on(columns, "fold", (node) => {
			const lane = node.dataset.lane;
			if (folded.has(lane)) folded.delete(lane);
			else folded.add(lane);
			drawBoard();
		});

		on(columns, "rename", (node) => {
			// Seeded with the current name, and selected, so the common edit is a
			// small correction and the common replacement is one keystroke.
			renaming = { from: node.dataset.lane, to: node.dataset.lane };
			drawBoard();
			const field = columns.querySelector("[data-lane-rename]");
			if (field) {
				field.focus();
				field.select();
			}
		});
		on(columns, "cancel-rename", () => {
			renaming = null;
			drawBoard();
		});
		on(columns, "save-rename", async () => {
			const draft = renaming;
			renaming = null;
			const to = String((draft && draft.to) || "").trim();
			if (!draft || !to || to === draft.from) return drawBoard();
			// Fold state follows the name it was set on, or a folded row would spring
			// open the moment it was renamed.
			if (folded.delete(draft.from)) folded.add(to);
			await mutate("kanban.rename-category", { from: draft.from, to });
		});

		on(columns, "ask-delete", (node) => {
			deleting = node.dataset.lane;
			drawBoard();
		});
		on(columns, "cancel-delete", () => {
			deleting = null;
			drawBoard();
		});
		on(columns, "do-delete", async (node) => {
			const lane = node.dataset.lane;
			deleting = null;
			folded.delete(lane);
			await mutate("kanban.remove-category", { name: lane });
		});

		const rename = columns.querySelector("[data-lane-rename]");
		if (rename) {
			rename.addEventListener("input", () => {
				if (renaming) renaming.to = rename.value;
			});
			rename.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					const button = columns.querySelector('[data-act="save-rename"]');
					if (button) button.click();
				}
				if (event.key === "Escape") {
					renaming = null;
					drawBoard();
				}
			});
		}

		const box = columns.querySelector("[data-lane-name]");
		if (box) {
			box.addEventListener("input", () => {
				if (naming !== null) naming = box.value;
			});
			box.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					const button = columns.querySelector('[data-act="save-lane"]');
					if (button) button.click();
				}
				if (event.key === "Escape") {
					naming = null;
					drawBoard();
				}
			});
		}
	}

	// ---------- one card ---------------------------------------------------

	function openCard(id) {
		const found = (board.cards || []).find((entry) => entry.id === id);
		if (!found) return;
		editing = { id, fields: valuesOf(found), base: valuesOf(found), conflicts: [], alts: found.alts || {} };
		drawBoard();
	}

	/** A card's editable fields, flattened the way the server takes them. */
	function valuesOf(entry) {
		const values = { title: entry.title || "", body: entry.body || "" };
		for (const field of FIELDS) {
			if (field.key === "title" || field.key === "body") continue;
			values[field.key] = (entry.extra || {})[field.key] || "";
		}
		return values;
	}

	/**
	 * The editor.
	 *
	 * Drawn separately from the board and only when the open card CHANGES, so a
	 * three-second poll cannot move the caret out from under someone typing.
	 * `editing.fields` is still the source of truth, so nothing is lost if it does
	 * get redrawn.
	 */
	function drawSide() {
		if (!editing) {
			side.innerHTML = "";
			side.classList.remove("kb-shown");
			return;
		}
		if (side.dataset.card === editing.id && !editing.dirtyRedraw) return;

		side.dataset.card = editing.id;
		editing.dirtyRedraw = false;
		side.classList.add("kb-shown");

		const alts = Object.entries(editing.alts || {})
			.map(
				([key, values]) => `<div class="kb-alt">
					<div><strong>${esc(key)}</strong> — someone else set this at the same time.</div>
					<div class="kb-row">
						<span class="kb-muted">theirs:</span> <code>${esc(values.join(" | "))}</code>
						<button data-act="theirs" data-field="${esc(key)}" data-value="${esc(values[0])}">Use theirs</button>
						<button data-act="mine" data-field="${esc(key)}" class="kb-ghost">Keep mine</button>
					</div>
				</div>`,
			)
			.join("");

		const conflicts = (editing.conflicts || [])
			.map(
				(clash) => `<div class="kb-alt">
					<div><strong>${esc(clash.field)}</strong> was changed by someone else while this was open.</div>
					<div class="kb-row">
						<span class="kb-muted">theirs:</span> <code>${esc(clash.theirs)}</code>
						<button data-act="take" data-field="${esc(clash.field)}" data-value="${esc(clash.theirs)}">Take theirs</button>
						<button data-act="force" data-field="${esc(clash.field)}" data-value="${esc(clash.yours)}">Keep mine</button>
					</div>
				</div>`,
			)
			.join("");

		side.innerHTML = `
			<header class="kb-row">
				<span class="kb-mono kb-muted">${esc(editing.id)}</span>
				<button data-act="close" class="kb-ghost">Close</button>
			</header>
			${alts}${conflicts}
			${FIELDS.map(
				(field) => `<label>${esc(field.label)}
					${
						field.kind === "text"
							? `<textarea data-field="${field.key}" rows="10">${esc(editing.fields[field.key])}</textarea>`
							: `<input data-field="${field.key}" value="${esc(editing.fields[field.key])}">`
					}
				</label>`,
			).join("")}
			<div class="kb-row">
				<button data-act="save" class="kb-primary">Save</button>
				<button data-act="delete" class="kb-danger">Delete</button>
			</div>`;

		for (const input of side.querySelectorAll("[data-field]")) {
			if (!input.dataset.act) {
				input.addEventListener("input", () => {
					editing.fields[input.dataset.field] = input.value;
				});
			}
		}

		on(side, "close", () => {
			editing = null;
			side.dataset.card = "";
			drawSide();
			drawBoard();
		});

		on(side, "save", () => save({}));

		// Resolving an alt is a save that NAMES the field — the server drops the
		// alternative for any field mentioned in a request, either way. So both
		// buttons are one call with a different value, and neither needs a
		// resolve endpoint.
		on(side, "theirs", (node) => save({ [node.dataset.field]: node.dataset.value }));
		on(side, "mine", (node) => save({ [node.dataset.field]: editing.fields[node.dataset.field] }));

		// A refused save carries the other side's value. Taking it means adopting
		// theirs as the new base; keeping mine means basing on theirs and writing
		// over it. Either way the next save has a base the server agrees with.
		on(side, "take", (node) => {
			editing.fields[node.dataset.field] = node.dataset.value;
			editing.base[node.dataset.field] = node.dataset.value;
			editing.conflicts = [];
			editing.dirtyRedraw = true;
			drawSide();
		});
		on(side, "force", (node) => {
			editing.base[node.dataset.field] = node.dataset.value;
			editing.conflicts = [];
			editing.dirtyRedraw = true;
			drawSide();
		});

		on(side, "delete", async () => {
			const id = editing.id;
			editing = null;
			side.dataset.card = "";
			await mutate("kanban.remove", { id });
		});
	}

	async function save(extra) {
		const id = editing.id;
		const fields = { ...editing.fields, ...extra };
		const base = { ...editing.base };
		const answer = await mutate("kanban.edit", { id, fields, base });
		if (!answer) return;

		if (answer.ok === false) {
			// Reopened on the same card, now carrying what the other side wrote.
			editing = { id, fields, base, conflicts: answer.conflicts || [], alts: {}, dirtyRedraw: true };
			notice = "This card was edited elsewhere. Choose a value for each field below.";
			drawBar();
			drawSide();
			return;
		}
		editing = null;
		side.dataset.card = "";
		drawSide();
	}

	// ---------- go ---------------------------------------------------------

	/** Delegated click handling, by `data-act`. One listener per container, per draw. */
	function on(container, act, handler) {
		for (const node of container.querySelectorAll(`[data-act="${act}"]`)) {
			node.addEventListener("click", () => handler(node));
		}
	}

	await refresh();
	// `mount` is never torn down while the tab is open (desktop/src/plugins/
	// PluginFrame.tsx), so this interval lives as long as the frame and needs no
	// clearing. A poll that overlaps a write is harmless: the write refreshes too.
	setInterval(() => {
		if (!busy) refresh();
	}, POLL_MS);
}

// ---------- plumbing --------------------------------------------------------

function esc(value) {
	return String(value == null ? "" : value).replace(
		/[&<>"']/g,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
	);
}

/**
 * A card's row.
 *
 * TRIMMED, because " design" and "design" are the same row to a person and a
 * stray space would silently split one into two — and the field is free text
 * typed into the editor, so that is a matter of when, not whether.
 */
function catOf(entry) {
	return String((entry.extra || {}).category || "").trim();
}

/** A class-name-safe form of a free-text priority, for the colour swatch. */
function slug(value) {
	return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** `https://github.com/you/board.git` → `you/board`, for a bar that has to fit. */
function short(remote) {
	if (!remote) return "";
	const match = /([^/:]+\/[^/]+?)(\.git)?$/.exec(String(remote));
	return match ? match[1] : String(remote);
}

const CSS = `
.kb { position: absolute; inset: 0; display: flex; flex-direction: column; }
.kb-bar { flex: none; padding: 10px 14px; border-bottom: 1px solid var(--ap-line); }
.kb-body { flex: 1; min-height: 0; display: flex; }
.kb-board { flex: 1; min-width: 0; overflow: auto; }
.kb-side {
	flex: none; width: 0; overflow: auto; border-left: 1px solid var(--ap-line);
	padding: 0; display: flex; flex-direction: column; gap: 10px;
}
.kb-side.kb-shown { width: 340px; padding: 14px; }

.kb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kb-muted { color: var(--ap-muted); }
.kb-small { font-size: 12px; }
.kb-mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11.5px; }
.kb-src { font-weight: 600; }
.kb-dot { width: 7px; height: 7px; border-radius: 999px; display: inline-block; }
.kb-ok { background: var(--ap-ok, #3a9d5d); }
.kb-bad { background: var(--ap-bad, #c8493f); }
.kb-notice {
	margin: 8px 0 0; padding: 8px 10px; white-space: pre-wrap; font-size: 12px;
	border: 1px solid var(--ap-line); border-radius: var(--ap-radius);
	background: rgb(from var(--ap-bad, #c8493f) r g b / 0.08);
}

button.kb-primary { border-color: var(--ap-accent); color: var(--ap-accent); }
button.kb-danger { border-color: var(--ap-bad, #c8493f); color: var(--ap-bad, #c8493f); }
button.kb-ghost { border-color: transparent; color: var(--ap-muted); }
button.kb-ghost:hover { border-color: var(--ap-line); }

.kb-setup { max-width: 34rem; padding: 24px 14px; display: flex; flex-direction: column; gap: 12px; }
.kb-setup h1 { font-size: 17px; margin: 0; }
.kb-setup p { margin: 0; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ap-muted); }
label input, label textarea { color: var(--ap-fg); font-size: 13.5px; }
code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; }

/*
 * The board is a grid, not a row of columns, because the two axes have to line
 * up: a row's cells must sit under the right column headers, and a tall card
 * must push its whole row down rather than just its own column. A max-content
 * width with a min-width floor lets the grid be as wide as its columns need while
 * still filling a window wider than they are. The column template is set inline
 * because the number of columns is only known at draw time.
 */
.kb-grid { display: grid; gap: 8px 12px; padding: 14px; align-content: start; width: max-content; min-width: 100%; }

/*
 * The two headers stay put while the board scrolls under them. The box shadow
 * is not decoration: it paints the grid gap in the same opaque colour, and
 * without it cards slide visibly through the gutter beside a sticky label.
 */
.kb-colhead {
	position: sticky; top: 0; z-index: 2;
	background: var(--ap-solid); box-shadow: 0 -14px 0 var(--ap-solid), 0 8px 0 var(--ap-solid);
	display: flex; justify-content: space-between; align-items: center; gap: 8px;
	font-weight: 600; padding: 2px 8px 6px;
}
.kb-lane-label {
	position: sticky; left: 0; z-index: 1;
	background: var(--ap-solid); box-shadow: -14px 0 0 var(--ap-solid), 12px 0 0 var(--ap-solid);
	display: flex; flex-direction: column; gap: 2px; justify-content: flex-start;
	font-weight: 600; padding-top: 8px; overflow-wrap: anywhere;
}
.kb-lane-none { font-weight: 400; color: var(--ap-muted); }
.kb-lane-head { display: flex; align-items: baseline; gap: 6px; }
.kb-fold { border: none; padding: 0; width: 14px; flex: none; color: var(--ap-muted); line-height: 1.4; }
/*
 * A button that has to read as the row's title: the name IS the rename control,
 * so it drops every button affordance except the one that says it can be edited.
 */
.kb-lane-name {
	border: none; padding: 0; font: inherit; font-weight: inherit; color: inherit;
	text-align: left; flex: 1; min-width: 0; overflow-wrap: anywhere;
}
button.kb-lane-name { cursor: text; }
button.kb-lane-name:hover { text-decoration: underline dotted; text-underline-offset: 2px; }
/* Held back until the row is pointed at or tabbed into, like "+ Card". */
.kb-lane-tools { opacity: 0; }
.kb-lane-label:hover .kb-lane-tools, .kb-lane-label:focus-within .kb-lane-tools { opacity: 1; }
.kb-lane-confirm { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
/*
 * A folded row keeps one item per column so the counts stay under the columns
 * they describe and nothing below the row shifts sideways.
 */
.kb-shut {
	min-height: 20px; display: flex; align-items: center; justify-content: center;
	font-size: 12px; color: var(--ap-muted);
	border-bottom: 1px solid var(--ap-line); border-radius: 0;
}
/* Over both, so neither scrolls out from under the other at the origin. */
.kb-corner { position: sticky; top: 0; left: 0; z-index: 3; background: var(--ap-solid); box-shadow: -14px 0 0 var(--ap-solid); }

.kb-cell {
	display: flex; flex-direction: column; gap: 8px;
	background: color-mix(in srgb, var(--ap-fg, #000) 3%, transparent);
	border: 1px solid var(--ap-line); border-radius: var(--ap-radius); padding: 8px;
}
/*
 * One "+ Card" per cell would be five times as many dashed buttons as before, so
 * it is held in reserve until the pointer is in the cell. Reserved rather than
 * removed — opacity, not display — so revealing it shifts nothing, and
 * focus-within keeps it reachable by keyboard, where there is no hover.
 */
.kb-newcard { opacity: 0; }
.kb-cell:hover .kb-newcard, .kb-cell:focus-within .kb-newcard { opacity: 1; }
.kb-newlane { grid-column: 1 / -1; max-width: 240px; padding-top: 2px; }

.kb-count { color: var(--ap-muted); font-weight: 400; }
.kb-drop { display: flex; flex-direction: column; gap: 8px; min-height: 48px; border-radius: 8px; }
.kb-drop.kb-over { outline: 2px dashed var(--ap-accent); outline-offset: 2px; }

.kb-card {
	background: var(--ap-solid); border: 1px solid var(--ap-line);
	border-radius: 8px; padding: 8px 9px; cursor: grab;
	display: flex; flex-direction: column; gap: 6px;
}
.kb-card:hover { border-color: var(--ap-accent); }
.kb-card.kb-open { border-color: var(--ap-accent); box-shadow: 0 0 0 1px var(--ap-accent) inset; }
.kb-card.kb-dragging { opacity: 0.4; }
.kb-title { font-weight: 500; }
.kb-tags { display: flex; gap: 4px; flex-wrap: wrap; }
.kb-tag {
	font-size: 11px; padding: 1px 6px; border-radius: 999px;
	border: 1px solid var(--ap-line); color: var(--ap-muted);
}
.kb-p-high, .kb-p-urgent, .kb-p-critical { border-color: var(--ap-bad, #c8493f); color: var(--ap-bad, #c8493f); }
.kb-p-medium, .kb-p-normal { border-color: var(--ap-warn, #b8860b); color: var(--ap-warn, #b8860b); }
.kb-foot { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.kb-warnpill { font-size: 11px; color: var(--ap-warn, #b8860b); }
.kb-add { border-style: dashed; color: var(--ap-muted); }
.kb-composer { display: flex; flex-direction: column; gap: 6px; }
.kb-composer textarea { resize: vertical; }

.kb-alt {
	border: 1px solid var(--ap-warn, #b8860b); border-radius: var(--ap-radius);
	padding: 8px; font-size: 12px; display: flex; flex-direction: column; gap: 6px;
}
`;
