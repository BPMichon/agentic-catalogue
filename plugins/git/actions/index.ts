/**
 * Reading git history, for any repository the project declares.
 *
 * This is a BUILTIN plugin (shells/host.ts:120) claiming `projectKinds: ["*"]`,
 * so it loads for every project. That is deliberate: a project's repositories are
 * already declared in its manifest, and nothing about reading their history is
 * domain-specific. There is no per-project copy to keep in step.
 *
 * COPY THE IMPORT LIST EXACTLY: `node:*` and nothing else. `zod` arrives as
 * `ctx.z`. That is what lets this folder live outside the kernel repository, in a
 * catalogue with no `node_modules` and no build step.
 *
 * BOTH ACTIONS ARE `mutating: false`, AND THAT IS A CLAIM WORTH DEFENDING.
 * The house rule is that spawning a subprocess is enough to make an action
 * mutating. The rule exists
 * because a subprocess is an UNBOUNDED effect — and the exception here is that
 * this one is not:
 *
 *   - the argv is a fixed literal. No part of it comes from the caller. The only
 *     caller-supplied value is a repository ID, which selects a cwd from an
 *     already-validated list and never reaches the command line.
 *   - `--no-optional-locks` stops git taking the index lock to refresh it
 *     opportunistically, which is the one way a read command writes. (This is why
 *     `git status` would NOT be acceptable here and `git log` is.)
 *
 * Getting this wrong in the "safe" direction is not free: a mutating action
 * writes a run record per call (shells/api.ts:694), so every repository switch
 * would queue a run for a human to approve in Runs — and a plugin UI cannot
 * approve its own run. The visualiser would be unusable. So the flag is honest
 * rather than merely cautious: keep the argv fixed and it stays true.
 */

import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import fs from "node:fs/promises";
// Both `import type`, so type stripping erases them before Node resolves anything
// — they cost nothing at runtime and exist so an editor can autocomplete `ctx` and
// the context an action receives. A portability check in the kernel repo skips
// type-only imports for exactly this reason; a runtime `../../../kernel` import
// would fail it, and would fail for real in a project that is not this repository.
import type { ActionContext } from "../../../kernel/domain/action.ts";
import type { PluginContext } from "../../../kernel/domain/plugin-context.ts";

/** One entry of the manifest's `repositories`, which is all this plugin reads. */
interface DeclaredRepo {
	readonly id: string;
	readonly path: string;
}

/** Where a project keeps its manifest, relative to the project root. */
const PROJECT_DIR = ".AgenticProject";

/**
 * Field and record separators for `git log --format`.
 *
 * ASCII unit/record separators rather than a printable delimiter, because a
 * commit subject can contain any printable character. `%s` is single-line — git
 * strips newlines from a subject — so a record cannot be split by a message that
 * happens to wrap.
 *
 * ponytail: a subject containing a literal \x1e would still split its own row.
 * That takes deliberate abuse to produce and costs one garbled line, so it is
 * named rather than defended against.
 */
const FIELD = "\x1f";
const RECORD = "\x1e";

/** Rows returned at most. The UI is told when it bit, so it can say so. */
const CAP = 2000;

export function register(ctx: PluginContext): void {
	const { z } = ctx;

	/**
	 * The repository picker's data. Read-only and cheap — the UI calls this on
	 * mount, before it knows what to draw.
	 */
	ctx.action({
		id: "git.repos",
		summary: "List the repositories this project declares, and whether each is a git repository on disk.",
		mutating: false,
		args: z.object({}).strict(),
		async run(_args, context) {
			const declared = await declaredRepos(context);

			// `present` is surfaced rather than filtered so the UI can grey out a
			// declared repository that is not on disk. Dropping it silently would
			// make a stale manifest look like a shorter project.
			const repos = await Promise.all(
				declared.map(async (repo) => ({
					id: repo.id,
					path: repo.path,
					present: await isGitRepo(context.resolve(repo.path)),
				})),
			);

			const missing = repos.filter((repo) => !repo.present).length;
			context.log(`${repos.length} declared repositor${repos.length === 1 ? "y" : "ies"}, ${missing} not on disk.`);
			return { count: repos.length, repos };
		},
	});

	/**
	 * One repository's history, in the shape the graph needs.
	 *
	 * ONE git invocation supplies all of it. `%D` carries branch names, tags AND
	 * `HEAD -> branch`, so a detached HEAD needs no second call to detect.
	 */
	ctx.action({
		id: "git.log",
		summary: "Read a declared repository's commit graph — commits, parents and ref names, newest first.",
		mutating: false,
		args: z
			.object({
				// A repository ID, never a path. See resolveRepo below for why.
				repoId: z.string().min(1),
			})
			.strict(),
		async run(args, context) {
			const cwd = await resolveRepo(context, args.repoId);

			const raw = await git(
				[
					"--no-optional-locks",
					"log",
					// Every ref, not just HEAD — a graph showing one branch is a list.
					"--all",
					// Topological, not date: it keeps a branch's commits contiguous,
					// which is the difference between readable lanes and a plait.
					"--topo-order",
					// One more than the cap, so truncation is detected by overfetching
					// rather than by a second `rev-list --count` over the same history.
					`--max-count=${CAP + 1}`,
					`--format=%H${FIELD}%P${FIELD}%an${FIELD}%aI${FIELD}%D${FIELD}%s${RECORD}`,
				],
				cwd,
			);

			const all = raw
				.split(RECORD)
				// git separates entries with a newline of its own, so every record
				// after the first arrives with one attached.
				.map((record) => record.trim())
				.filter((record) => record.length > 0)
				.map((record) => {
					const [sha, parents, author, date, refs, subject = ""] = record.split(FIELD);
					return {
						sha,
						// Empty for a root commit; two or more for a merge.
						parents: parents ? parents.split(" ").filter(Boolean) : [],
						author,
						date,
						// "HEAD -> main, origin/main, tag: v1" — split as written and let
						// the UI decide what a ref looks like.
						refs: refs ? refs.split(", ").filter(Boolean) : [],
						subject,
					};
				});

			const truncated = all.length > CAP;
			const commits = truncated ? all.slice(0, CAP) : all;

			context.log(`${args.repoId}: ${commits.length} commit(s)${truncated ? ` (capped at ${CAP})` : ""}.`);
			return { repoId: args.repoId, truncated, count: commits.length, commits };
		},
	});
}

/**
 * The project's declared repositories.
 *
 * Read from the manifest rather than detected on disk. The declared list is the
 * authoritative one — `agentic init` populates it (shells/host.ts:424-455) and it
 * is what the agent is told to trust (adapters/workers/agent-dir-harness.ts:382)
 * — and it keeps each path verbatim, which is why a typo'd-but-real directory
 * name resolves correctly instead of being "corrected" into a missing one.
 *
 * The action context is four members (kernel/domain/action.ts:55-76) and does not
 * carry the manifest, so this parses it. That is six lines here versus a new field
 * on ProjectView, its copy in the renderer's types, and the drift guard that
 * checks the two agree.
 *
 * ponytail: reads the declared list, so a repository cloned but not yet in
 * project.json will not appear until `agentic init` runs again. Scan for `.git`
 * on disk instead if that ever becomes the annoying half.
 */
async function declaredRepos(context: ActionContext): Promise<DeclaredRepo[]> {
	const file = context.resolve(`${PROJECT_DIR}/project.json`);

	let raw;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch {
		throw new Error(`Could not read ${PROJECT_DIR}/project.json — this does not look like an Agentic project.`);
	}

	let manifest;
	try {
		manifest = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${PROJECT_DIR}/project.json is not valid JSON: ${String(error)}`);
	}

	const repositories: unknown = manifest?.repositories;
	if (!Array.isArray(repositories)) return [];
	return repositories
		.filter((repo): repo is DeclaredRepo => Boolean(repo) && typeof repo.id === "string" && typeof repo.path === "string")
		.map((repo) => ({ id: repo.id, path: repo.path }));
}

/**
 * A repository ID to an absolute directory.
 *
 * THE UI SENDS AN ID, NEVER A PATH, and that is the whole containment story: the
 * ID is looked up in a list the kernel already validated, and only the path found
 * there is resolved. `context.resolve` then refuses anything escaping the project
 * root anyway (kernel/runtime/engine.ts:604-611), so a manifest with `../..` in it
 * fails here rather than reading the drive.
 */
async function resolveRepo(context: ActionContext, repoId: string): Promise<string> {
	const repos = await declaredRepos(context);
	const repo = repos.find((candidate) => candidate.id === repoId);
	if (!repo) {
		const known = repos.map((candidate) => candidate.id).join(", ");
		throw new Error(`This project declares no repository ${JSON.stringify(repoId)}.\nDeclared: ${known || "none"}.`);
	}

	const dir = context.resolve(repo.path);
	if (!(await isGitRepo(dir))) {
		throw new Error(
			`${repo.id} is declared at ${repo.path}, but there is no git repository there.\n` +
				"Clone it, or remove it from project.json's repositories.",
		);
	}
	return dir;
}

/**
 * Is there a git repository at `dir`?
 *
 * `.git` is a directory in a normal clone and a FILE holding `gitdir: …` in a
 * worktree or submodule. Both are real repositories, so this checks for either
 * rather than for a directory.
 */
async function isGitRepo(dir: string): Promise<boolean> {
	try {
		await fs.stat(`${dir}/.git`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Run git and return its stdout.
 *
 * The shape — including the synchronous-throw catch, because `execFile` can throw
 * rather than call back — is the one every plugin in this system uses. Its `.cmd` half is not reproduced: that trap is npm/Azure-CLI batch shims
 * and Node's CVE-2024-27980 mitigation, whereas `git` is a real executable on
 * every platform and needs no shell. Not passing `shell` is the safer default
 * anyway, since nothing here should ever be parsed by one.
 */
function git(args: readonly string[], cwd: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		// stdout/stderr are optional because the catch below calls this with only
		// the error, when execFile threw instead of calling back.
		const done = (error: ExecFileException | null, stdout = "", stderr = "") => {
			if (!error) return resolve(stdout);

			const message = String(stderr || error.message);

			if (error.code === "ENOENT") {
				return reject(new Error("git is not installed, or not on PATH for this process."));
			}
			// An empty repository is not a failure — it is a repository with nothing
			// to draw yet, and the UI says so more gracefully than an error does.
			if (/does not have any commits yet|bad default revision|unknown revision/i.test(message)) {
				return resolve("");
			}
			if (/not a git repository/i.test(message)) {
				return reject(new Error(`${cwd} is not a git repository.`));
			}
			// git's own stderr names the problem better than a paraphrase would.
			reject(new Error(`git ${args.join(" ")} failed:\n${message.trim()}`));
		};

		try {
			execFile(
				"git",
				args,
				{
					cwd,
					windowsHide: true,
					// 2000 commits of metadata is well under a megabyte; this is headroom
					// for a history with long ref decorations, not an expectation.
					maxBuffer: 16 * 1024 * 1024,
					timeout: 15_000,
				},
				done,
			);
		} catch (error) {
			// `catch` binds `unknown`, and a synchronous throw from execFile is an
			// Error in practice — but narrowing rather than asserting keeps a thrown
			// string from arriving at `done` as a fake Error.
			done(error instanceof Error ? error : new Error(String(error)));
		}
	});
}
