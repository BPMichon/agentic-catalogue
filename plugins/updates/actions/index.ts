/**
 * What on this machine is out of date.
 *
 * Checks only. Nothing here installs, upgrades or elevates — the UI reports what
 * needs doing and prints the command, and a human runs it in a terminal they can
 * see. That is why the whole plugin gets away with one action.
 *
 * COPY THE IMPORT LIST EXACTLY: `node:*` and nothing else. `zod` arrives as
 * `ctx.z`, and this folder lives inside a project with no node_modules.
 *
 * `mutating: false` IS A CLAIM, and here is its defence — the same one the
 * built-in git plugin makes (plugins/git/actions/index.ts:12-29):
 *
 *   - the argv is a fixed literal. No part of it comes from the caller; this
 *     action takes no arguments at all.
 *   - `winget upgrade` with no package operand LISTS. The subcommand that
 *     installs is the same word with a package name after it, which nothing here
 *     can put there.
 *   - it does refresh the source index cache, which is a write in the same sense
 *     that any read-through cache is. Nothing on this machine changes version.
 *
 * Getting this "safely" wrong is not free: a mutating action writes a run record
 * per call, so every Re-check would queue a run for a human to approve in Runs —
 * and a plugin UI cannot approve its own run. The button would be dead.
 */

import { execFile } from "node:child_process";

/**
 * Seconds before winget is given up on. It talks to the network to compare
 * against its sources, and a cold source refresh on a slow line is genuinely
 * slow — this is the "something is wrong" threshold, not the expected duration.
 */
const TIMEOUT_MS = 180_000;

export function register(ctx) {
	const { z } = ctx;

	ctx.action({
		id: "updates.check",
		summary: "List software on this machine with a newer version available, via winget.",
		mutating: false,
		args: z.object({}).strict(),
		async run(_args, context) {
			// `--include-unknown` is the difference between a useful answer and a
			// tidy one: without it winget silently omits every package whose
			// installed version it cannot read, which on a real machine is dozens of
			// them. `--disable-interactivity` stops it drawing progress spinners into
			// stdout and waiting on prompts we cannot answer.
			const { stdout, code } = await winget(["upgrade", "--include-unknown", "--disable-interactivity"]);

			const packages = parseUpgrades(stdout);

			// winget exits non-zero for "nothing matched", which for `upgrade` means
			// "nothing to upgrade" — a result, not a failure. Only an empty parse of a
			// non-zero run is worth reporting, and even then as a note rather than a
			// throw, because the UI would rather show the message than nothing.
			const notes = [];
			if (packages.length === 0 && code !== 0 && !/No installed package found/i.test(stdout)) {
				notes.push(`winget exited ${code} and produced no table. Its output was:\n${stdout.trim()}`);
			}

			const store = packages.filter((entry) => entry.source === "msstore").length;
			context.log(`${packages.length} update(s) available${store ? `, ${store} from the Microsoft Store` : ""}.`);

			return { count: packages.length, packages, notes };
		},
	});
}

/**
 * winget's table, as rows.
 *
 * EXPORTED FOR THE TEST, which is the only reason it is not a closure —
 * parse.test.mjs feeds it captured output, because the interesting cases (a
 * second table, a truncated name) are ones this machine may not have today.
 *
 * Column POSITIONS come from the header line rather than splitting on runs of
 * whitespace, because a package name contains spaces ("1Password CLI") and an
 * empty Source column is invisible to any split. winget pads every column to a
 * fixed width and rules it off with dashes, so the header is a reliable ruler.
 *
 * ponytail: byte offsets, so a name containing double-width characters (CJK)
 * shifts its own row's later columns. Measure display width instead if that ever
 * shows up. Likewise the header names are the English ones — a machine running
 * winget in another locale parses to zero rows rather than to wrong ones.
 */
export function parseUpgrades(stdout) {
	const lines = stdout
		.split(/\r?\n/)
		// winget redraws progress in place with carriage returns even when stdout is
		// a pipe; only the text after the last one is the finished line.
		.map((line) => line.slice(line.lastIndexOf("\r") + 1).replace(/\[[0-9;]*[A-Za-z]/g, ""));

	const rows = [];
	// winget prints a SECOND table for packages it found an upgrade for but
	// cannot upgrade in bulk (pinned, or an unknown installed version). Those are
	// the ones that need a human, so they are kept and flagged rather than
	// dropped with the heading that explains them.
	let explicit = false;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (/require explicit targeting/i.test(line)) explicit = true;

		// A rule of dashes means the line above it was a header. That is the only
		// signal used to find a table, so an extra paragraph between tables costs
		// nothing.
		if (!/^-{5,}\s*$/.test(line)) continue;
		const header = lines[index - 1];
		if (!header || !/\bId\b/.test(header)) continue;

		const columns = headerColumns(header);
		if (!columns.some((column) => column.key === "id")) continue;

		for (index += 1; index < lines.length; index += 1) {
			const row = lines[index];
			// A table ends at the first blank line; what follows is the summary
			// ("N upgrades available.") or the next table's heading.
			if (!row.trim()) break;

			const cell = (key) => {
				const column = columns.find((candidate) => candidate.key === key);
				if (!column) return "";
				// Slicing past the end of a short row yields "", which is exactly what
				// an empty trailing Source column should read as.
				return row.slice(column.start, column.end).trim();
			};

			const id = cell("id");
			if (!id) continue;

			rows.push({
				name: cell("name") || id,
				id,
				version: cell("version"),
				available: cell("available"),
				// Blank for anything winget knows about only from the local ARP/MSIX
				// registry. Reported as written; the UI decides how to label it.
				source: cell("source"),
				explicit,
			});
		}
	}

	return rows;
}

/** Header labels to the character range each column occupies. */
function headerColumns(header) {
	// Every label winget can print in these tables. Located by indexOf rather
	// than by splitting, so an unexpected extra column is skipped instead of
	// shifting everything after it.
	const found = [];
	for (const label of ["Name", "Id", "Version", "Available", "Source"]) {
		const start = header.indexOf(label);
		if (start !== -1) found.push({ key: label.toLowerCase(), start });
	}

	found.sort((a, b) => a.start - b.start);
	return found.map((column, index) => ({
		...column,
		// The last column runs to the end of the line, however long the row is.
		end: index + 1 < found.length ? found[index + 1].start : Number.MAX_SAFE_INTEGER,
	}));
}

/**
 * Run winget and return its stdout and exit code.
 *
 * Resolves on a non-zero exit instead of rejecting, because winget uses exit
 * codes to say "nothing matched" and the caller wants that as data. Only a
 * failure to RUN it is an error.
 */
function winget(args) {
	return new Promise((resolve, reject) => {
		const done = (error, stdout = "", stderr = "") => {
			if (error && error.code === "ENOENT") {
				return reject(
					new Error(
						"winget is not on PATH for this process.\n" +
							"It ships as App Installer from the Microsoft Store; check `winget --version` in a terminal.",
					),
				);
			}
			if (error && error.killed) {
				return reject(new Error(`winget did not finish within ${TIMEOUT_MS / 1000}s.`));
			}
			// An ExecFileException from a completed process carries the exit code;
			// a clean exit means zero.
			const code = error && typeof error.code === "number" ? error.code : 0;
			// stderr is folded in rather than discarded: winget writes some of its
			// explanations there, and the UI shows whatever it is given.
			resolve({ stdout: stdout || stderr, code });
		};

		try {
			execFile(
				"winget",
				args,
				{
					windowsHide: true,
					// A few hundred rows of table. Headroom, not an expectation.
					maxBuffer: 16 * 1024 * 1024,
					timeout: TIMEOUT_MS,
				},
				done,
			);
		} catch (error) {
			// execFile can throw synchronously. Narrowing rather than asserting keeps
			// a thrown string from arriving at `done` pretending to be an Error.
			done(error instanceof Error ? error : new Error(String(error)));
		}
	});
}
