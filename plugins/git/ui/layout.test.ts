/**
 * The git plugin's lane assignment.
 *
 * WHY THIS TEST EXISTS AT ALL, given that plugins are otherwise checked only
 * structurally: a wrong lane does not throw. It draws a graph that looks entirely
 * plausible and describes history that never happened, and no amount of "it
 * rendered" catches that. It is the one piece of real algorithm in a plugin whose
 * other half is `git log` and a `<select>`.
 *
 * The lane-leak case below is not hypothetical. The first version of this
 * algorithm freed only the lane a commit was drawn in, and on this repository's
 * own `alm` it asked for 506 lanes where git draws 10 — because branches sharing
 * a base all wait for the same commit, and every duplicate leaked.
 *
 * It lives beside the plugin because the plugin does: this catalogue runs its own
 * `node --test`, so moving out of the kernel repository cost no coverage.
 *
 * It imports the UI entry directly, which is possible because `layout` is pure —
 * no DOM, no `api`, no browser globals. That is a property worth keeping: if this
 * import ever needs a shim, the function has grown something it should not have.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Beside the module it tests, now that the plugin owns its own coverage rather
// than borrowing the kernel repo’s test runner.
const entry = pathToFileURL(path.join(import.meta.dirname, "index.js")).href;
const { layout } = (await import(entry)) as {
	layout: (rows: readonly { sha: string; parents: readonly string[] }[]) => {
		placed: { commit: { sha: string }; row: number; lane: number; overflow: boolean }[];
		edges: { from: number; to: number; lane: number; toLane: number }[];
		width: number;
	};
};

/** Commits arrive newest-first, which is the order `git log` emits. */
const log = (...rows: readonly [string, ...string[]][]) => rows.map(([sha, ...parents]) => ({ sha, parents }));

const laneOf = (result: ReturnType<typeof layout>, sha: string) =>
	result.placed.find((entry) => entry.commit.sha === sha)?.lane;

test("a linear history occupies one lane", () => {
	const result = layout(log(["c", "b"], ["b", "a"], ["a"]));

	assert.deepEqual(
		result.placed.map((entry) => entry.lane),
		[0, 0, 0],
		"nothing branches, so nothing should move across",
	);
	assert.equal(result.width, 1);
});

test("a merge puts its second parent in a new lane, and the first keeps the merge's own", () => {
	//   m        row 0, lane 0
	//   |\
	//   | f      row 1, lane 1   (the merged-in branch)
	//   b |      row 2, lane 0   (first parent, inherits m's lane)
	//   |/
	//   a        row 3, lane 0
	const result = layout(log(["m", "b", "f"], ["f", "a"], ["b", "a"], ["a"]));

	assert.equal(laneOf(result, "m"), 0);
	assert.equal(laneOf(result, "f"), 1, "the second parent forks");
	assert.equal(laneOf(result, "b"), 0, "the first parent inherits the merge's lane");
	assert.equal(laneOf(result, "a"), 0);
	assert.equal(result.width, 2);

	// The rejoin: on the row above `a`, lane 1 must bend into lane 0 rather than
	// carrying on straight down a lane nothing occupies afterwards.
	const rejoin = result.edges.filter((edge) => edge.to === 3 && edge.lane === 1);
	assert.equal(rejoin.length, 1);
	assert.equal(rejoin[0]?.toLane, 0, "the merged branch must visibly rejoin the mainline");
});

test("lanes waiting on the SAME commit are all released when it is drawn", () => {
	// The regression. Two tips share `base`, so two lanes wait for it. Releasing
	// only one leaves the other reserved forever, and `z` is then pushed into a
	// third lane it has no business occupying.
	//
	//   x  y      rows 0,1 — lanes 0 and 1, both waiting for base
	//   |/
	//   base      row 2 — BOTH lanes converge here
	//   |  z      row 3 — z must REUSE lane 1, not open lane 2
	//   |/
	//   older     row 4
	const result = layout(log(["x", "base"], ["y", "base"], ["base", "older"], ["z", "older"], ["older"]));

	assert.equal(result.width, 2, "a leaked lane shows up here as a third column");
	assert.equal(laneOf(result, "z"), 1, "the freed lane must be available again");

	// Both waiting lanes converge on `base`'s row, and one of them has to bend.
	const into = result.edges.filter((edge) => edge.to === 2);
	assert.equal(into.length, 2);
	assert.deepEqual(
		into.map((edge) => [edge.lane, edge.toLane]).sort(),
		[
			[0, 0],
			[1, 0],
		],
	);
});

test("exactly one segment is emitted per occupied lane per row", () => {
	// The other regression: an earlier version drew both a per-row segment AND a
	// long edge from each merge down to its distant parent, so every merge was
	// drawn twice. 43,000 paths for 1,827 commits.
	const result = layout(log(["m", "b", "f"], ["f", "a"], ["b", "a"], ["a"]));

	const seen = new Set<string>();
	for (const edge of result.edges) {
		const key = `${edge.from}:${edge.lane}`;
		assert.ok(!seen.has(key), `lane ${edge.lane} was drawn twice leaving row ${edge.from}`);
		seen.add(key);
		// Every segment spans exactly one row, so nothing overlaps by construction.
		assert.equal(edge.to, edge.from + 1, "a segment must span one row");
	}
});

test("nothing is drawn below the last row", () => {
	// What truncation looks like: `a` names a parent the log never delivered. The
	// lane simply ends — the count banner carries the "there is more" message, and
	// an edge to a row that does not exist would draw into empty space.
	const result = layout(log(["b", "a"], ["a", "beyond-the-cap"]));

	assert.equal(result.placed.length, 2);
	assert.ok(
		result.edges.every((edge) => edge.to < result.placed.length),
		"no segment may point past the last row",
	);
});

test("the lane cap holds, and the commits it displaces are flagged rather than misdrawn", () => {
	// 50 independent tips, all sharing one root, against a cap of 32. The excess
	// must be marked `overflow` — a graph that quietly drew them in a lane that was
	// not theirs would be worse than one that admits it ran out.
	const tips = Array.from({ length: 50 }, (_, i) => [`tip${i}`, "root"] as [string, ...string[]]);
	const result = layout(log(...tips, ["root"]));

	assert.equal(result.width, 32, "the column must stop widening at the cap");
	assert.ok(
		result.placed.every((entry) => entry.lane < 32),
		"no commit may be placed in a lane the SVG will not draw",
	);
	assert.ok(
		result.placed.some((entry) => entry.overflow),
		"the commits past the cap must say so",
	);
	// And the ones that fit must NOT be flagged.
	assert.equal(laneOf(result, "tip0"), 0);
	assert.equal(result.placed.find((entry) => entry.commit.sha === "tip0")?.overflow, false);
});

test("an empty log lays out without incident", () => {
	// The empty-repository case reaches this function, not just the empty state.
	const result = layout([]);
	assert.deepEqual(result.placed, []);
	assert.deepEqual(result.edges, []);
	assert.equal(result.width, 1);
});
