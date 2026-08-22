# Git Graph

Draws the commit history of any repository this project declares, as a branch
graph in its own desktop tab.

This is a **builtin** plugin claiming `projectKinds: ["*"]`, so it loads for every
project rather than being copied into each one. There is nothing domain-specific
about reading git history, and a project's repositories are already declared in
its manifest.

## Actions

| Action | | |
|---|---|---|
| `git.repos` | read | The declared repositories, each flagged with whether it is a git repository on disk. |
| `git.log` | read | One repository's commits, parents and ref names, newest first, capped at 2000. |

Both are `mutating: false`. That is a claim, not a convenience — see the comment
at the top of `actions/index.ts`. The short version: the argv is a fixed literal
with no caller input, and `--no-optional-locks` stops git writing the index the
way a read command otherwise can. Add a git command that writes and the flag
becomes a lie, so keep the argv fixed.

## The interface

`ui/index.js` opens as a tab from the sidebar's **Apps** section, or from the app
launcher in the top panel. It is one plain ES module in a sandboxed frame with an
opaque origin, which rules out two things worth knowing about:

- **The selected repository is not remembered across a reload.** There is no
  `localStorage` in an opaque origin. `mount` runs once, so the choice lives as
  long as the tab.
- **There is no copy-SHA button.** Whether the clipboard is reachable from this
  frame was never established, and it would fail silently either way. SHAs are
  selectable text instead.

## Ceilings

Deliberate, and named where they are taken:

- **2000 commits.** Detected by overfetching one, so the UI can say the history
  was cut rather than quietly showing a shorter project.
- **32 lanes.** Past that, commits pin to the last lane and are marked with `⋯`.
  Visibly lossy, which beats drawing them in a lane that isn't theirs. The number
  is measured against real history here — the widest needed 27 — not guessed.
- **The declared list.** A repository cloned but not yet added to `project.json`
  will not appear until `agentic init` runs again.

## If you change the lane algorithm

`layout()` is exported and covered by `ui/layout.test.ts`, run by `npm test` in
this catalogue. Two of
those cases are regressions from real repositories, and both failure modes are
invisible on a small synthetic history:

- **Releasing only one lane** when several are waiting on the same commit. Every
  branch sharing a base names it as a parent, so the duplicates leak. `alm` asked
  for 506 lanes where git draws 10.
- **Drawing a merge's long edge as well as** the per-row segments that already
  cover it: 43,000 overlapping SVG paths for 1,827 commits.

Neither throws. Both render something that looks like a graph.
