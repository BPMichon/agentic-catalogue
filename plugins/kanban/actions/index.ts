/**
 * A kanban board that lives in a git repository.
 *
 * The board itself is `git-kanban` — one markdown file per card, a hybrid logical
 * clock for ordering, a git merge driver for concurrent edits. None of that is
 * reimplemented here, and the reason is worth stating: a card is a CRDT with
 * invariants (fractional ranks, `clock` stamps, an append-only body log), so a
 * second writer that "just parses the front matter" would corrupt a board the
 * first time two people edited it. So this plugin OWNS NO FORMAT. It runs
 * `kanban serve` and talks to the local HTTP API that serve exposes, which is the
 * entry point git-kanban's own README nominates for exactly this.
 *
 * WHY THE NODE PACKAGE IS NOT AN IMPORT, and how it gets here anyway. §8.2
 * confines a plugin to `node:` builtins and its own folder, because a plugin
 * folder is a git clone dropped into a project with no `node_modules` — so
 * `import "git-kanban"` is unavailable and always will be. It arrives as a
 * DECLARED REQUIREMENT instead: `requires` in plugin.json names its repository,
 * the installer clones it to `requires/git-kanban` beside this file, and this
 * module spawns it. Nothing from it runs at install time, because a clone
 * executes nothing.
 *
 * THE ALTERNATIVE WAS A MACHINE PREREQUISITE — `npm i -g github:BPMichon/GitKanban`
 * before first use — and it was wrong for a reason specific to this tool: the
 * repository is PRIVATE, so the prerequisite silently needed its own access grant.
 * Someone without it got a plugin that installed cleanly and then failed at first
 * use, with the real cause two layers from the message. A requirement moves that
 * failure to the install, where it aborts instead of half-succeeding.
 *
 * IT IS RUN FROM SOURCE, with no build step. git-kanban has zero runtime
 * dependencies and Node 22.18+ strips types unprompted, so `node src/cli.ts` is
 * the whole of it — no `npm install`, no `dist/`, no `node_modules`. That also
 * removes the trap this plugin hit while it was a PATH prerequisite: an npm-linked
 * install runs `dist/`, which no git operation ever updates, so a fix could be
 * committed, pushed and tagged while the thing actually executing stayed stale.
 *
 * COPY THE IMPORT LIST EXACTLY: `node:*` and nothing else. `zod` arrives as
 * `ctx.z`. `fetch` and `AbortSignal.timeout` are Node globals, so calling the
 * board's API needs no dependency at all.
 *
 * MUTATING FLAGS ARE HONEST HERE. `kanban.state` reads — `GET /api/state` is a
 * directory of file reads plus `git rev-parse` — so it is false, and that matters
 * because the UI polls it and a mutating action writes a run record per call
 * (shells/api.ts). Everything else commits to a git repository and is flagged
 * accordingly. A card move producing a run record is not noise; it is the same
 * event the board is about to push to its remote.
 */

import { execFile, spawn } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
// Both `import type`, so type stripping erases them before Node resolves
// anything. They exist so an editor can autocomplete `ctx`; a runtime import of
// the kernel would fail here, and fail worse in a project that is not the kernel
// repository. Same convention as plugins/git/actions/index.ts.
import type { ActionContext } from "../../../kernel/domain/action.ts";
import type { PluginContext } from "../../../kernel/domain/plugin-context.ts";

/**
 * The required CLI, found relative to THIS MODULE.
 *
 * `import.meta.url` rather than a configured path, because a plugin folder can be
 * anywhere — builtin, installed under Studio Home, or project-local (§8.1) — and
 * `requires/` is a sibling of `actions/` in all three. The loader imports this
 * file as `file://…/actions/index.ts?v=<mtime>` to defeat the ESM cache, and URL
 * resolution drops that query, so the join lands where the clone actually is.
 */
const CLI = fileURLToPath(new URL("../requires/git-kanban/src/cli.ts", import.meta.url));

/**
 * How to run it.
 *
 * `process.execPath` IS NOT ALWAYS NODE. Under the desktop shell this process is
 * Electron, and Electron only behaves as a node interpreter with
 * ELECTRON_RUN_AS_NODE set — without it, `execPath script.js` opens a window.
 * Plain node ignores the variable, so one spawn shape covers the CLI shell and
 * the desktop both.
 *
 * This also replaced a `kanban.cmd` + `shell: true` dance that existed only
 * because an npm global install is a batch shim on Windows. Spawning an absolute
 * script path with a known interpreter needs no shell on any platform, which is
 * one less thing that can be quoted wrongly.
 */
const RUN_AS_NODE = { ELECTRON_RUN_AS_NODE: "1" } as const;

/**
 * Where a cloned board lands by default.
 *
 * Inside `.AgenticProject` rather than at the project root, because it is local
 * state for this machine — a second clone of somebody else's repository, not part
 * of this project's source. `connect` gitignores it for the same reason.
 */
const DEFAULT_DIR = ".AgenticProject/board";

/** git-kanban's own default. Configurable because a machine can run two boards. */
const DEFAULT_PORT = 7777;

/** One API call. Loopback, so a slow answer means something is wrong. */
const API_TIMEOUT_MS = 5_000;

/** A clone can be genuinely slow; the rest of the CLI is not. */
const CLONE_TIMEOUT_MS = 120_000;
const CLI_TIMEOUT_MS = 30_000;

/** How long `serve` gets to bind its port before we call it a failure. */
const START_TIMEOUT_MS = 15_000;

interface Config {
	readonly remote: string | null;
	readonly dir: string;
	readonly port: number;
}

export function register(ctx: PluginContext): void {
	const { z } = ctx;

	/**
	 * Everything the UI needs to draw itself, including the reasons it cannot.
	 *
	 * ONE READ, NOT THREE. The board tab has four states — unconfigured, configured
	 * but not serving, serving, and broken — and a UI that discovered them through
	 * separate calls would flash through two of them on every poll. So the answer
	 * always carries `configured` and `running`, and the card list is simply empty
	 * when either is false.
	 */
	ctx.action({
		id: "kanban.state",
		summary: "Read the configured board: its source, whether its server is up, and every card on it.",
		mutating: false,
		args: z.object({}).strict(),
		async run(_args, context) {
			const config = configOf(context);
			if (!config) return { configured: false, running: false, columns: [], categories: [], cards: [] };

			const base = { configured: true, remote: config.remote, dir: config.dir, port: config.port };

			/*
			 * A BOARD FOLDER THAT IS NOT THERE IS THE UNCONFIGURED STATE, and it used
			 * not to be. `dir` carries a default, so configOf can never answer null and
			 * every project reported itself configured — the tab offered "Start board",
			 * and serve spawned into a folder that does not exist. The settings stay in
			 * the answer so the setup form opens with the remote already filled in.
			 */
			if (!(await exists(context.resolve(config.dir)))) {
				return { ...base, configured: false, running: false, columns: [], categories: [], cards: [] };
			}

			const secret = await token(context.resolve(config.dir));
			// No token file means `serve` has never run in this clone, which is a
			// clearer answer than a refused connection would be.
			if (!secret) return { ...base, running: false, columns: [], categories: [], cards: [] };

			try {
				const state = await request(config, secret, "/state");
				return { ...base, running: true, ...state };
			} catch (error) {
				// A refused connection is the ordinary "not started yet" case, and the
				// UI offers a Start button for it rather than an error.
				return { ...base, running: false, columns: [], categories: [], cards: [], problem: messageOf(error) };
			}
		},
	});

	/**
	 * Point this project at a board, cloning it if it is not here yet.
	 *
	 * THE "SET THE GITHUB LINK" COMMAND. It is an action rather than a palette
	 * entry because the palette deliberately cannot invoke actions and has nowhere
	 * to put a text field (desktop/src/chrome/CommandPalette.tsx) — so the field
	 * lives in this plugin's own interface, which is where someone setting up a
	 * board is already looking.
	 *
	 * Idempotent in every direction: re-running it on an existing clone
	 * reconfigures without touching the working tree, and `kanban init` is itself
	 * idempotent, so pointing at the same repository twice is not an error.
	 */
	ctx.action({
		id: "kanban.connect",
		summary: "Set the git repository this project's board comes from, cloning it if needed.",
		mutating: true,
		args: z
			.object({
				/**
				 * The board's remote. Optional, so an existing local board can be
				 * adopted in place — `{ dir: "." }` makes the project its own board.
				 */
				url: z.string().trim().min(1).optional(),
				/** Project-relative. Containment is enforced by `context.resolve`. */
				dir: z.string().trim().min(1).optional(),
				port: z.number().int().min(1024).max(65535).optional(),
			})
			.strict(),
		async run(args, context) {
			const dir = args.dir ?? DEFAULT_DIR;
			const target = context.resolve(dir);

			if (args.url) assertCloneable(args.url);

			const already = await exists(`${target}/.git`);
			if (!already) {
				if (!args.url) {
					throw new Error(
						`There is no git repository at ${dir}, and no url was given to clone one from.\n` +
							"  Give a GitHub URL, or point dir at a clone that already exists.",
					);
				}
				await fs.mkdir(parentOf(target), { recursive: true });
				// `--` so a URL beginning with a dash can never be read as an option.
				// git is a real executable, so this runs with no shell at all.
				await git(["clone", "--", args.url, target], parentOf(target), CLONE_TIMEOUT_MS);
				context.log(`cloned ${args.url} into ${dir}`);
			} else if (args.url) {
				context.log(`${dir} is already a clone — leaving its remote alone.`);
			}

			// `init` writes kanban.json, tasks/ and the .gitattributes rules that
			// register the merge driver. Re-running it on a live board is how you
			// pick up new rules, so it is always safe and always cheap.
			await kanban(["init"], target);

			const config: Config = {
				remote: args.url ?? (await remoteOf(target)),
				dir,
				port: args.port ?? DEFAULT_PORT,
			};
			// Written through the CONTEXT, so the same values appear on the settings
			// screen and in `agentic plugin config`. This used to be a file of our own
			// that nothing else could see.
			await context.saveSettings({
				dir: config.dir,
				port: config.port,
				// A board with no origin is legitimate, and `saveSettings` treats an
				// absent key as "leave alone" — so a null remote is omitted rather
				// than written as an empty string that would read as configured.
				...(config.remote ? { remote: config.remote } : {}),
			});
			await ignore(context, dir);

			context.log(`board configured at ${dir}, port ${config.port}`);
			return { ...config, cloned: !already };
		},
	});

	/**
	 * Start `kanban serve` for the configured board.
	 *
	 * NOT DETACHED, deliberately. The server commits and pushes every ten seconds,
	 * so a copy that outlived the app would keep writing to a repository nobody is
	 * watching. Tying its lifetime to this process makes "close the app" mean what
	 * it looks like it means; `unref` then keeps it from holding the event loop
	 * open.
	 *
	 * ponytail: no stop action. Closing the app is the stop button, and a second
	 * `serve` on a bound port exits immediately rather than doing damage. Add one
	 * if a long-lived host ever has to switch boards without restarting.
	 */
	ctx.action({
		id: "kanban.serve",
		summary: "Start the board's local server, which also syncs it with its git remote every few seconds.",
		mutating: true,
		args: z.object({}).strict(),
		async run(_args, context) {
			const config = mustConfig(context);
			const target = context.resolve(config.dir);

			// Already up is a success, not a conflict — the UI calls this on mount and
			// a second tab must not report a failure.
			if (await probe(context, config)) return { started: false, running: true, port: config.port };

			// An absolute script path and a validated integer. Nothing user-supplied
			// reaches this argv, and the board's path travels as `cwd` — so no shell
			// is involved and nothing here can be mis-quoted.
			const args = [CLI, "serve", "--port", String(config.port)];

			let stderr = "";
			const child = spawn(process.execPath, args, {
				cwd: target,
				windowsHide: true,
				env: { ...process.env, ...RUN_AS_NODE },
				// stderr is kept because the interesting failures — the port is taken,
				// the board has no remote — are only said there, and a server that
				// exited with its reason discarded is unexplainable. Drained on every
				// chunk so a full pipe can never block the child.
				stdio: ["ignore", "ignore", "pipe"],
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				if (stderr.length < 4000) stderr += String(chunk);
			});

			const died = new Promise<never>((_resolve, reject) => {
				child.on("error", (error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT" && error.code !== "EINVAL") return reject(error);
					void whyNothingRan(target, MISSING_CLI).then((reason) => reject(new Error(reason)));
				});
				child.on("exit", (code) => {
					reject(new Error(`kanban serve exited with code ${code}.${stderr ? `\n${stderr.trim()}` : ""}`));
				});
			});

			// The child must not keep the host alive after the window closes.
			child.unref();

			const deadline = Date.now() + START_TIMEOUT_MS;
			for (;;) {
				// `died` races the poll so a server that fails to bind reports its own
				// reason immediately, instead of timing out fifteen seconds later with
				// nothing to say.
				const up = await Promise.race([probe(context, config), died, wait(250)]);
				if (up) {
					context.log(`kanban serve is up on 127.0.0.1:${config.port}`);
					return { started: true, running: true, port: config.port };
				}
				if (Date.now() > deadline) {
					throw new Error(
						`kanban serve did not answer on 127.0.0.1:${config.port} within ${START_TIMEOUT_MS / 1000}s.` +
							(stderr ? `\n${stderr.trim()}` : ""),
					);
				}
			}
		},
	});

	/**
	 * A new card.
	 *
	 * `beforeId` and `afterId` are passed straight through: the fractional rank
	 * between two neighbours is computed by the server, from the board it has just
	 * read. Computing it here would mean this plugin learning the rank format,
	 * which is the one thing it must not learn.
	 */
	ctx.action({
		id: "kanban.add",
		summary: "Add a card to the board, and commit it.",
		mutating: true,
		args: z
			.object({
				title: z.string().trim().min(1),
				status: z.string().trim().min(1).optional(),
				category: z.string().optional(),
				body: z.string().optional(),
				assignee: z.string().optional(),
				priority: z.string().optional(),
				labels: z.string().optional(),
				beforeId: z.string().optional(),
				afterId: z.string().optional(),
			})
			.strict(),
		async run(args, context) {
			const config = mustConfig(context);
			const card = await write(context, config, "/cards", "POST", args);
			context.log(`added ${(card as { id?: string }).id ?? "a card"}`);
			return card;
		},
	});

	ctx.action({
		id: "kanban.move",
		summary: "Move a card to another column, or reorder it within one.",
		mutating: true,
		args: z
			.object({
				id: z.string().trim().min(1),
				status: z.string().trim().min(1),
				/**
				 * The row the card was dropped on. OPTIONAL, AND EMPTY IS MEANINGFUL:
				 * absent leaves the card's category alone, `""` clears it. Without that
				 * distinction a caller that does not draw rows would wipe one every
				 * time it moved a card between columns.
				 */
				category: z.string().optional(),
				beforeId: z.string().optional(),
				afterId: z.string().optional(),
			})
			.strict(),
		async run(args, context) {
			const config = mustConfig(context);
			const { id, ...rest } = args;
			return write(context, config, `/cards/${encodeURIComponent(id)}/move`, "POST", rest);
		},
	});

	/**
	 * Edit a card's fields.
	 *
	 * `base` IS THE POINT OF THIS SIGNATURE, not an optional extra. It carries the
	 * values the caller loaded, and the server merges field by field against them —
	 * so two people editing different fields of one card both succeed, and only a
	 * genuine same-field clash is refused. Send no `base` and every save is a blind
	 * overwrite of whatever arrived in the meantime.
	 *
	 * A refusal comes back as `{ ok: false, conflicts }` rather than a thrown
	 * error, because the caller needs the other side's values in order to offer a
	 * choice, and a message loses them.
	 */
	ctx.action({
		id: "kanban.edit",
		summary: "Change a card's fields, merging against the values the caller last saw.",
		mutating: true,
		args: z
			.object({
				id: z.string().trim().min(1),
				fields: z.record(z.string(), z.string()),
				base: z.record(z.string(), z.string()).optional(),
			})
			.strict(),
		async run(args, context) {
			const config = mustConfig(context);
			const secret = await mustToken(context, config);

			const { status, body } = await send(config, secret, `/cards/${encodeURIComponent(args.id)}`, "PATCH", {
				...args.fields,
				base: args.base ?? {},
			});

			if (status === 409) {
				const clash = body as { conflicts?: unknown[]; card?: unknown };
				context.log(`${args.id}: someone else changed the same field.`);
				return { ok: false, conflicts: clash.conflicts ?? [], card: clash.card ?? null };
			}
			if (status >= 400) throw new Error(errorIn(body, status));
			return { ok: true, card: body };
		},
	});

	/**
	 * Replace the board's rows.
	 *
	 * THE WHOLE LIST, NOT ONE ROW. `POST /api/categories` is a replacement, so add,
	 * rename, reorder and remove are all the same call and all one commit — which
	 * also makes it idempotent, and means a caller never has to know whether the
	 * row it wants already exists.
	 *
	 * Removing a row does NOT touch the cards that named it. Their `category` is
	 * left alone and the board hands it back uncoerced, so hiding a row cannot
	 * silently reclassify the work that was in it. A caller that draws rows is
	 * expected to show such a card anyway rather than lose it.
	 */
	ctx.action({
		id: "kanban.categories",
		summary: "Replace the board's list of categories, and commit it.",
		mutating: true,
		args: z.object({ categories: z.array(z.string().trim().min(1)) }).strict(),
		async run(args, context) {
			const config = mustConfig(context);
			return write(context, config, "/categories", "POST", args);
		},
	});

	ctx.action({
		id: "kanban.remove",
		summary: "Delete a card from the board, and commit the removal.",
		mutating: true,
		args: z.object({ id: z.string().trim().min(1) }).strict(),
		async run(args, context) {
			const config = mustConfig(context);
			return write(context, config, `/cards/${encodeURIComponent(args.id)}`, "DELETE", undefined);
		},
	});
}

// ---------- the board's API ------------------------------------------------

/** A write, with the "is it even running" error worded once. */
async function write(
	context: ActionContext,
	config: Config,
	path: string,
	method: string,
	payload: unknown,
): Promise<unknown> {
	return request(config, await mustToken(context, config), path, method, payload);
}

/** A call that throws on any non-2xx. */
async function request(
	config: Config,
	secret: string,
	path: string,
	method = "GET",
	payload?: unknown,
): Promise<Record<string, unknown>> {
	const { status, body } = await send(config, secret, path, method, payload);
	if (status >= 400) throw new Error(errorIn(body, status));
	return body as Record<string, unknown>;
}

/**
 * One HTTP call to the board, returning the status alongside the body.
 *
 * 127.0.0.1 RATHER THAN localhost, because localhost can resolve to ::1 first
 * while `serve` binds IPv4 only — which presents as a refused connection against
 * a server that is plainly running.
 *
 * The token is per-clone and lives in `.git/kanban-token`, which is never
 * committed. It is what stops any web page in any browser from reaching this API
 * and writing to the repository, so it is sent on every call, reads included.
 */
async function send(
	config: Config,
	secret: string,
	path: string,
	method: string,
	payload?: unknown,
): Promise<{ status: number; body: unknown }> {
	let response;
	try {
		response = await fetch(`http://127.0.0.1:${config.port}/api${path}`, {
			method,
			headers: { "content-type": "application/json", "x-kanban-token": secret },
			body: payload === undefined ? undefined : JSON.stringify(payload),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(`Could not reach the board on 127.0.0.1:${config.port}: ${messageOf(error)}`);
	}

	const text = await response.text();
	let body: unknown = {};
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			// A non-JSON body means something other than kanban is on the port. Say
			// so with the text, which is the only useful clue there is.
			throw new Error(
				`127.0.0.1:${config.port} answered with something that is not the kanban API:\n${text.slice(0, 200)}`,
			);
		}
	}
	return { status: response.status, body };
}

function errorIn(body: unknown, status: number): string {
	const named = (body as { error?: unknown } | null)?.error;
	return typeof named === "string" ? named : `the board's server returned ${status}`;
}

/** Is the server answering yet? Never throws — both callers are in a wait loop. */
async function probe(context: ActionContext, config: Config): Promise<boolean> {
	const secret = await token(context.resolve(config.dir));
	if (!secret) return false;
	try {
		await request(config, secret, "/state");
		return true;
	} catch {
		return false;
	}
}

/**
 * The board's API token, or null if `serve` has never run in this clone.
 *
 * Read from disk rather than by running `kanban token`, because this is on the
 * polling path: a spawn every few seconds to learn a value that changes once per
 * clone would cost more than everything else here put together. `serve` creates
 * it, so its absence is a reliable "never started".
 */
async function token(dir: string): Promise<string | null> {
	try {
		const value = (await fs.readFile(`${dir}/.git/kanban-token`, "utf8")).trim();
		return value || null;
	} catch {
		return null;
	}
}

async function mustToken(context: ActionContext, config: Config): Promise<string> {
	const secret = await token(context.resolve(config.dir));
	if (!secret) throw new Error("The board's server is not running — start it first.");
	return secret;
}

// ---------- configuration --------------------------------------------------

/**
 * The board this project is pointed at.
 *
 * READ FROM `context.settings`, NOT FROM A FILE OF OUR OWN. This plugin used to
 * write `.AgenticProject/kanban.json` and parse it back, which worked and was the
 * wrong shape: the values were invisible to every screen in the studio, so the
 * only way to see or change them was to open this plugin’s own tab and find the
 * form. Declaring them in plugin.json (§8.17) puts them on the settings screen and
 * in `agentic plugin config` for free, and deletes the parsing.
 *
 * A MISSING `remote` IS THE UNCONFIGURED STATE, and it is a state rather than an
 * error: an unset setting is ABSENT rather than empty (resolveSettings), so this
 * can tell "never configured" from "deliberately blank" and the UI renders a setup
 * form instead of failing to clone "".
 */
function configOf(context: ActionContext): Config | null {
	const dir = typeof context.settings["dir"] === "string" ? context.settings["dir"] : DEFAULT_DIR;
	const port = typeof context.settings["port"] === "number" ? context.settings["port"] : DEFAULT_PORT;
	const remote = typeof context.settings["remote"] === "string" && context.settings["remote"] ? context.settings["remote"] : null;

	// A board needs somewhere to be before anything here can run. `dir` has a
	// default so it is effectively always present; `remote` is what someone has
	// to supply, and until they have there is nothing to report but "unconfigured".
	if (!remote && !dir) return null;
	return { remote, dir, port };
}

function mustConfig(context: ActionContext): Config {
	const config = configOf(context);
	if (!config) throw new Error("No board is configured for this project yet — set its git source first.");
	return config;
}

/**
 * Keep a cloned board out of the project's own history.
 *
 * A clone inside a repository is an embedded repository: git will not commit its
 * contents, but it does report it in every `git status` until it is ignored. This
 * is the same append-what-is-missing shape `kanban init` uses on `.gitattributes`,
 * for the same reason — it has to be safe to run on a file someone else has
 * edited.
 *
 * Silent when the project is not a git repository, and when the line is already
 * there. Matching is a plain line comparison rather than an evaluation of git's
 * ignore rules: a redundant line is harmless, and asking git costs a spawn on
 * every connect.
 */
export function ignoreLine(dir: string): string {
	return `${dir.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
}

async function ignore(context: ActionContext, dir: string): Promise<void> {
	if (!(await exists(context.resolve(".git")))) return;

	const line = ignoreLine(dir);
	const file = context.resolve(".gitignore");
	let existing = "";
	try {
		existing = await fs.readFile(file, "utf8");
	} catch {
		// No .gitignore yet. Creating one holding a single explained rule is the
		// whole of what this has to do.
	}
	if (existing.split(/\r?\n/).some((row) => row.trim() === line)) return;

	const prefix = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
	await fs.writeFile(
		file,
		`${prefix}\n# A kanban board cloned by the kanban plugin. Local state, not source.\n${line}\n`,
		"utf8",
	);
	context.log(`added ${line} to .gitignore`);
}

// ---------- git and the CLI ------------------------------------------------

/**
 * What a missing `requires/git-kanban` means.
 *
 * NOT "you forgot to install something". The installer clones it or abandons the
 * install, so reaching this means the plugin folder was assembled some other way —
 * copied by hand, or a clone of the catalogue used directly as a plugin directory.
 * Reinstalling is the fix, and saying so beats naming a command that is no longer
 * how this tool arrives.
 */
const MISSING_CLI =
	`This plugin's copy of git-kanban is missing.\n  Expected it at ${CLI}\n` +
	"  It is declared in plugin.json as a requirement and cloned at install time, so\n" +
	"  reinstall the plugin — `agentic plugin update kanban`, or install it again.";

/**
 * Which of the two absent things an ENOENT is actually about.
 *
 * NOT the one it reads like. A CWD THAT DOES NOT EXIST RAISES ENOENT TOO, and the
 * message names the EXECUTABLE either way — a board folder nobody has cloned yet
 * arrives here as `spawn node.exe ENOENT`. So this branch answered "your copy of
 * git-kanban is missing" and sent people to reinstall a plugin that was intact,
 * with the actual cause — no board — never mentioned. Ask the filesystem: if the
 * directory is there, the command really is the thing that is not.
 */
export async function whyNothingRan(cwd: string, missing: string): Promise<string> {
	if (await exists(cwd)) return missing;
	return (
		`There is no folder at ${cwd} to run in.` +
		"\n  This project has no board yet — set its repository in the Kanban tab, which" +
		"\n  clones the board and creates the folder."
	);
}

/**
 * Refuse a remote that git would read as an option.
 *
 * THIS IS A TRUST BOUNDARY, and the risk is not the one it looks like. No shell is
 * involved in `git clone`, so quoting is irrelevant — but a URL beginning with a
 * dash becomes an ARGUMENT to git, and `--upload-pack=<command>` runs it. The call
 * site also passes `--`, so this is the second of two independent defences rather
 * than the only one.
 *
 * Printable ASCII only. That rejects whitespace and control characters, and it
 * also rejects an internationalised host — which git can clone and this refuses,
 * because a URL nobody can read is not one to hand a subprocess unchecked.
 */
export function assertCloneable(url: string): void {
	if (!/^(https:\/\/|http:\/\/|ssh:\/\/|git@)/.test(url)) {
		throw new Error(
			`${JSON.stringify(url)} is not a repository URL.\n` +
				"  Expected https://github.com/you/board.git or git@github.com:you/board.git",
		);
	}
	if (!/^[!-~]+$/.test(url)) {
		throw new Error("A repository URL cannot contain spaces, control characters or non-ASCII text.");
	}
}

/** The remote of a clone, so `connect` can record one it was not told. */
async function remoteOf(dir: string): Promise<string | null> {
	try {
		return (await git(["remote", "get-url", "origin"], dir, CLI_TIMEOUT_MS)).trim() || null;
	} catch {
		// A repository with no origin is legitimate — a board that has only ever
		// lived on this machine. Not knowing a remote is not an error.
		return null;
	}
}

function git(args: readonly string[], cwd: string, timeout: number): Promise<string> {
	return run("git", args, cwd, timeout, "git is not installed, or not on PATH for this process.");
}

/**
 * Run the required CLI once, from source.
 *
 * No PATH lookup and no shell: an absolute script path handed to this process's
 * own interpreter. See RUN_AS_NODE for why the environment is set.
 */
function kanban(args: readonly string[], cwd: string): Promise<string> {
	return run(process.execPath, [CLI, ...args], cwd, CLI_TIMEOUT_MS, MISSING_CLI, RUN_AS_NODE);
}

function run(
	command: string,
	args: readonly string[],
	cwd: string,
	timeout: number,
	missing: string,
	extraEnv: Readonly<Record<string, string>> = {},
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		// stdout/stderr are optional because the catch below calls this with only the
		// error, for when execFile throws instead of calling back.
		const done = (error: ExecFileException | null, stdout = "", stderr = "") => {
			if (!error) return resolve(stdout);
			if (error.code === "ENOENT" || error.code === "EINVAL") {
				return void whyNothingRan(cwd, missing).then((reason) => reject(new Error(reason)));
			}
			if (error.killed) return reject(new Error(`${label(command, args)} did not finish within ${timeout / 1000}s.`));
			// The tool's own stderr names the problem better than a paraphrase does —
			// including a private clone that failed for want of credentials.
			reject(new Error(`${label(command, args)} failed:\n${String(stderr || error.message).trim()}`));
		};

		try {
			execFile(
				command,
				args,
				{
					cwd,
					windowsHide: true,
					// No `shell`, on any platform. Both callers pass a real executable —
					// git, or this process's own interpreter — so there is nothing for a
					// shell to resolve and nothing it could mis-quote.
					maxBuffer: 16 * 1024 * 1024,
					timeout,
					// A clone that needs a password must FAIL rather than block on a
					// prompt this process has no terminal to show. git's own message then
					// names the repository, which is the actionable half.
					env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
				},
				done,
			);
		} catch (error) {
			done(error instanceof Error ? (error as ExecFileException) : new Error(String(error)));
		}
	});
}

// ---------- odds and ends --------------------------------------------------

/**
 * Is there anything at this path?
 *
 * Used to detect a repository, and a worktree's `.git` is a FILE holding
 * `gitdir: …` rather than a directory. Both are real repositories, so this checks
 * for either.
 */
async function exists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * A runnable command as something worth reading in an error.
 *
 * `process.execPath` plus an absolute script path is a 200-character line that
 * says nothing about what failed, so the interpreter and the script collapse to
 * the subcommand a person actually asked for — "kanban init", not
 * "C:\\…\\node.exe C:\\…\\requires\\git-kanban\\src\\cli.ts init".
 */
function label(command: string, args: readonly string[]): string {
	return command === process.execPath ? `kanban ${args.slice(1).join(" ")}` : `${command} ${args.join(" ")}`;
}

/** Last path segment removed, without importing node:path for one line. */
function parentOf(target: string): string {
	const at = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
	return at > 0 ? target.slice(0, at) : target;
}

const wait = (ms: number): Promise<false> => new Promise((resolve) => setTimeout(() => resolve(false), ms));

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
