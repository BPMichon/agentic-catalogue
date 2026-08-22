/**
 * Computer Updater — what is out of date on this machine.
 *
 * One plain ES module, served as-is: no bundler, no imports, no node_modules
 * where this runs. It lives in `<iframe sandbox="allow-scripts">` with no
 * allow-same-origin, so confirm(), fetch(), localStorage and form submits all
 * fail SILENTLY. Nothing here uses them.
 *
 * IT REPORTS, IT DOES NOT UPDATE. The commands are printed for a human to run in
 * a terminal they can see, which is also the only place `--all` can prompt for
 * elevation. A button that upgraded the machine would need a mutating action, a
 * workflow, and an approval in Runs — and would still be a button that rewrites
 * your software from a frame that cannot show you what it is doing.
 */

export async function mount(root, api) {
	// State lives in the module: `mount` runs once, there is no teardown, and
	// switching to Runs and back must not lose a completed scan.
	let packages = [];
	let notes = [];
	let status = "";
	let checking = false;
	let checked = false;

	const esc = (value) =>
		String(value).replace(
			/[&<>"']/g,
			(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
		);

	/**
	 * The three buckets, in the order they need attention.
	 *
	 * `winget` is the bulk-upgradable majority. `msstore` is separated because it
	 * updates through the Store even when winget can see the version. The
	 * remainder are packages winget knows only from the local registry — it can
	 * see they are behind and has nowhere to get the new one, which is a genuinely
	 * different answer and is labelled as one rather than folded in.
	 */
	const GROUPS = [
		{
			key: "winget",
			title: "winget",
			match: (entry) => entry.source === "winget",
			hint: "Upgradable in bulk from a terminal.",
		},
		{
			key: "msstore",
			title: "Microsoft Store",
			match: (entry) => entry.source === "msstore",
			hint: "Update these in the Store — Library → Get updates.",
		},
		{
			key: "other",
			title: "No update source",
			match: (entry) => entry.source !== "winget" && entry.source !== "msstore",
			hint: "winget can see these are behind but has nowhere to get the new version. Update them from the app itself.",
		},
	];

	async function check() {
		checking = true;
		status = "asking winget… this talks to the network and can take a minute.";
		render();
		try {
			const { result } = await api.invoke("updates.check", {});
			packages = result.packages;
			notes = result.notes;
			checked = true;
			status = result.count === 0 ? "Everything winget can see is up to date." : "";
		} catch (error) {
			// A kernel refusal is a multi-line message naming every blocker. Shown as
			// written — the half a paraphrase loses is the half that says what to fix.
			packages = [];
			notes = [];
			checked = false;
			status = error.message;
		}
		checking = false;
		render();
	}

	function row(entry) {
		return `<tr>
			<td>${esc(entry.name)}</td>
			<td class="mono muted">${esc(entry.id)}</td>
			<td class="mono">${esc(entry.version || "unknown")}</td>
			<td class="mono new">${esc(entry.available)}</td>
			<td>${entry.explicit ? '<span class="tag">needs targeting</span>' : ""}</td>
		</tr>`;
	}

	function group(definition) {
		const rows = packages.filter(definition.match);
		if (rows.length === 0) return "";
		return `<section>
			<h2>${esc(definition.title)} <span class="count">${rows.length}</span></h2>
			<p class="muted">${esc(definition.hint)}</p>
			<table>
				<thead><tr><th>Package</th><th>Id</th><th>Installed</th><th>Available</th><th></th></tr></thead>
				<tbody>${rows.map(row).join("")}</tbody>
			</table>
		</section>`;
	}

	/**
	 * What to actually type. Both scopes are listed because they are two different
	 * runs, not a flag on one: a per-user install upgrades unelevated, a
	 * machine-scope install needs an admin terminal, and winget will skip whichever
	 * it cannot touch without telling you it was the elevation that stopped it.
	 */
	function todo() {
		const bulk = packages.filter((entry) => entry.source === "winget" && !entry.explicit).length;
		const explicit = packages.filter((entry) => entry.source === "winget" && entry.explicit);
		if (bulk === 0 && explicit.length === 0) return "";

		const parts = [];
		if (bulk > 0) {
			parts.push(`<h2>What needs doing</h2>
				<p class="muted">Unelevated, for anything installed for you:</p>
				<pre>winget upgrade --all --include-unknown</pre>
				<p class="muted">Then again in an <strong>administrator</strong> terminal, for machine-scope installs:</p>
				<pre>winget upgrade --all --include-unknown</pre>`);
		}
		if (explicit.length > 0) {
			parts.push(`<p class="muted">These are skipped by <code>--all</code> and need naming individually:</p>
				<pre>${explicit.map((entry) => `winget upgrade --id ${esc(entry.id)} --include-unknown`).join("\n")}</pre>`);
		}
		return `<section>${parts.join("")}</section>`;
	}

	function render() {
		root.innerHTML = `
			<header>
				<h1>Computer Updater</h1>
				<button id="check" ${checking ? "disabled" : ""}>${checking ? "Checking…" : checked ? "Re-check" : "Check for updates"}</button>
			</header>
			${checked ? `<p class="summary">${packages.length} update(s) available.</p>` : ""}
			<p class="muted">${esc(status)}</p>
			${notes.map((note) => `<p class="muted warn">${esc(note)}</p>`).join("")}
			${GROUPS.map(group).join("")}
			${todo()}
			${
				checked
					? `<p class="muted foot">Store apps that winget cannot match to a source will not appear here at all —
					   there is no API that lists pending Store updates, so open the Store and hit
					   <em>Get updates</em> to be sure. Windows Update itself is not checked.</p>`
					: ""
			}`;

		root.querySelector("#check").addEventListener("click", check);
	}

	// Theme tokens, always with a fallback: the web shell (`agentic ui`) sends none
	// of them, so the fallbacks are the entire palette there. A hardcoded light
	// palette is the single most likely thing to be wrong with a new plugin app.
	// The frame is the OPAQUE tier — the shell may be translucent, this is not.
	root.insertAdjacentHTML(
		"beforebegin",
		`<style>
			body { color: var(--ap-fg, #16181d); background: var(--ap-solid, #fff);
			       color-scheme: var(--ap-color-scheme, light);
			       font: 13px/1.5 system-ui, sans-serif; margin: 16px; }
			header { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
			h1 { font-size: 16px; margin: 0; flex: 1; }
			h2 { font-size: 13px; margin: 20px 0 2px; display: flex; align-items: baseline; gap: 6px; }
			.count { color: var(--ap-muted, #5c6370); font-weight: normal; }
			.summary { margin: 0; font-size: 13px; }
			.muted { color: var(--ap-muted, #5c6370); font-size: 12px; white-space: pre-line; margin: 2px 0; }
			.warn { color: var(--ap-warn, #9a6b00); }
			.foot { margin-top: 24px; border-top: 1px solid var(--ap-line, #e2e5ea); padding-top: 8px; }
			table { border-collapse: collapse; width: 100%; margin-top: 6px; }
			th { text-align: left; font-weight: 500; color: var(--ap-muted, #5c6370); font-size: 11px;
			     text-transform: uppercase; letter-spacing: .04em; }
			th, td { border-bottom: 1px solid var(--ap-line, #e2e5ea); padding: 4px 8px 4px 0;
			         vertical-align: top; }
			.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
			.new { color: var(--ap-ok, #1a7f37); }
			.tag { border: 1px solid var(--ap-warn, #9a6b00); color: var(--ap-warn, #9a6b00);
			       border-radius: var(--ap-radius, 4px); padding: 0 4px; font-size: 11px; white-space: nowrap; }
			pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px;
			      border: 1px solid var(--ap-line, #e2e5ea); border-radius: var(--ap-radius, 4px);
			      padding: 8px; overflow-x: auto; user-select: all;
			      /* A shade the tokens do not provide, derived so it works in both themes. */
			      background: color-mix(in srgb, var(--ap-fg, #000) 4%, transparent); }
			code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
			button { color: inherit; background: transparent; cursor: pointer; padding: 5px 9px;
			         border: 1px solid var(--ap-line, #e2e5ea); border-radius: var(--ap-radius, 4px); }
			button:hover:not(:disabled) { background: color-mix(in srgb, var(--ap-fg, #000) 6%, transparent); }
			button:disabled { cursor: default; color: var(--ap-muted, #5c6370); }
		</style>`,
	);

	// Not checked on mount. The scan is slow and hits the network, so opening the
	// tab should not commit you to it — the button says what it will do.
	status = "Nothing checked yet.";
	render();
}
