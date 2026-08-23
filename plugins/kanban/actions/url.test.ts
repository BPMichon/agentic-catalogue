/**
 * The two bits of this plugin that are logic rather than plumbing.
 *
 * `assertCloneable` is a trust boundary: its argument becomes an argv entry of
 * `git clone`, and git reads a leading dash as an option — `--upload-pack=<cmd>`
 * runs a command. Everything else here is a subprocess or an HTTP call, which a
 * unit test can only mock into agreeing with itself; this is the part where being
 * wrong is quiet and expensive.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCloneable, ignoreLine } from "./index.ts";

test("a repository URL that git could read as an option is refused", () => {
	for (const hostile of [
		"--upload-pack=calc.exe",
		"-c protocol.ext.allow=always",
		"--config=core.pager=sh",
		"ext::sh -c whoami",
	]) {
		assert.throws(() => assertCloneable(hostile), /not a repository URL/, hostile);
	}
});

test("a URL with whitespace or non-ASCII is refused", () => {
	// The scheme check passes for all three, so this is the second gate doing the
	// work rather than the first one catching them anyway.
	assert.throws(() => assertCloneable("https://github.com/a b/c.git"), /spaces/);
	assert.throws(() => assertCloneable("https://github.com/a\tb.git"), /spaces/);
	assert.throws(() => assertCloneable("https://gіthub.com/you/board.git"), /spaces/); // Cyrillic і
});

test("the URL forms someone actually types are accepted", () => {
	for (const fine of [
		"https://github.com/BPMichon/GitKanban.git",
		"https://github.com/BPMichon/GitKanban",
		"http://gitlab.internal/team/board.git",
		"git@github.com:BPMichon/GitKanban.git",
		"ssh://git@github.com:22/BPMichon/GitKanban.git",
		// A hyphen INSIDE the URL is ordinary and must survive — the check is about
		// a leading dash, and a character class banning hyphens outright would have
		// rejected half of GitHub.
		"https://github.com/some-org/my-board.git",
	]) {
		assert.doesNotThrow(() => assertCloneable(fine), fine);
	}
});

test("the gitignore line is a directory rule, whatever separators it arrives with", () => {
	assert.equal(ignoreLine(".AgenticProject/board"), ".AgenticProject/board/");
	// A path built on Windows, and a trailing slash already there: both must produce
	// the same single line, or `connect` appends a near-duplicate every time it runs.
	assert.equal(ignoreLine(".AgenticProject\\board"), ".AgenticProject/board/");
	assert.equal(ignoreLine(".AgenticProject/board/"), ".AgenticProject/board/");
});
