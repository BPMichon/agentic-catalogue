# Working on the Kanban plugin

Read this before changing anything here. It holds the facts that are not derivable
from a quick read of the code, and the ones that cost time when they were not
written down.

The general rules for extending a published plugin — which copy is the source, how
a release moves — are in the kernel repository:
[docs/PluginLifecycle.md](https://github.com/BPMichon/AgenticProject/blob/main/docs/PluginLifecycle.md)
and `tasks/extend-plugin/`.

## This plugin spans two repositories

| | |
|---|---|
| **this folder** | the plugin: `actions/index.ts` (subprocess and HTTP plumbing), `ui/index.js` (the board), `plugin.json`. |
| **[BPMichon/GitKanban](https://github.com/BPMichon/GitKanban)** | the store, the CRDT, the merge driver, and the HTTP server the plugin talks to. |

`requires/git-kanban` beside an installed copy is **machine-managed**. It is
cloned and then hard-reset to the `ref` in `plugin.json` on every install and
update, so an edit made in there is discarded — usually on somebody else's machine
rather than while you are watching. To change git-kanban: change it in its own
repository, push, **tag**, then move `requires[].ref` here to that tag. Never a
branch.

This plugin **owns no part of the card format.** A card is a CRDT — fractional
ranks, hybrid logical clocks, an append-only body log — and `kanban serve` is the
only writer. A second writer that parsed the front matter itself would corrupt the
board the first time two people edited one card. If a change needs the card format
to know something new, it belongs upstream, not here.

## Adding a card field is a three-place edit

In this order, because the first one is the real gate:

1. **`EXTRA_KEYS` in `git-kanban/src/server.ts`.** A key that is not in this list
   is **dropped in silence** — the POST succeeds, the PATCH succeeds, and the
   value never lands. This is the trap; everything else fails loudly.
2. **The zod schema in `actions/index.ts`**, so the action accepts the argument at
   all.
3. **`FIELDS` in `ui/index.js`**, so the card editor offers it. There is a second
   `FIELDS` in `server.ts` derived from `EXTRA_KEYS` — that one is the three-way
   merge and alt resolution, and it needs no edit.

Miss (1) and the field silently does nothing. Miss (2) and the action rejects it.
Miss (3) and nobody can type it.

## Ranks are one sequence per column, deliberately

Not per cell. A reader that draws swimlanes **filters** that one column sequence
per cell. This is why `move` computes a rank against the whole target column
rather than against the cards in the row it is landing in: a rank taken between two
neighbours in the column still sorts correctly inside a cell, and one sequence
means dragging a card between rows does not renumber it.

`beforeId` / `afterId` are passed straight through from the UI. Do not compute a
rank on this side — that would mean this plugin learning the rank format, which is
the thing it must not do.

On `move`, `category` **absent** means "leave the row alone" and **empty** means
"remove the row". An old client that does not know about rows must not clear one.

## The UI sandbox — silent refusals, not errors

`ui/index.js` runs in a frame with no `allow-modals`, no network and no storage.
These do not throw; they do nothing, which is far worse to debug:

- **`confirm()` / `prompt()` / `alert()`** return immediately. The button looks
  dead. Confirm inline instead — there is already a pattern for it in the file.
- **`fetch()`** does nothing at all, including to `127.0.0.1:7777`. The board
  arrives only through `api.invoke("kanban.state")`.
- **`localStorage`** fails silently. There is nowhere private to keep anything.
- **`window.parent`** is unreachable.

**Drafts live in module state, never in the DOM.** The board is re-polled every
`POLL_MS` (3s) and a re-render would empty an `<input>` mid-word. Anything being
typed — the composer, `naming`, `renaming` — is a module-scoped variable mutated on
every keystroke, and the poll's change-signature deliberately excludes their text so
a keystroke does not itself trigger a redraw.

**Never hardcode a colour.** The frame is themed; a hardcoded colour is perfect in
light mode and unreadable in dark. That is the single most likely thing to be wrong
with a change here.

## Running the tests

Two suites, in two repositories, and a change to a field or a rank touches both:

```sh
# this repo — the plugin's own logic (URL trust boundary, ignore lines)
npm test          # node --test --experimental-strip-types "plugins/**/*.test.ts"

# git-kanban — the store, the clock, the merge, the sync
npm test          # in requires/git-kanban or your own clone of it
```

`assertCloneable` in `actions/index.ts` is a **trust boundary**, not plumbing: its
argument becomes an argv entry of `git clone`, and git reads a leading dash as an
option (`--upload-pack=<cmd>` runs a command). If you touch it, its tests are the
point of the suite.

## Action ids

Lowercase dotted names with hyphens: `kanban.rename-category`. A camelCase id is
accepted by every editor and every test here and then **rejected at load time** by
the kernel's manifest schema, so the plugin disappears for the user and not for
you. Any new id has to land in three places: the `action()` call in
`actions/index.ts`, `permissions.actions`, and `ui.actions` if a page calls it.
