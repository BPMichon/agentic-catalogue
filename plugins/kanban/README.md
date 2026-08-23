# Kanban

A kanban board in its own tab, backed by [git-kanban](https://github.com/BPMichon/GitKanban) —
one markdown file per card, no server, no database, and a git repository as the store.

## You need access to one private repository

There is nothing to install by hand. `git-kanban` is declared as a **requirement**:

```json
"requires": [{ "id": "git-kanban", "source": "github:BPMichon/GitKanban", "ref": "v0.1.0" }]
```

`agentic plugin install kanban` clones it to `requires/git-kanban` beside the plugin and
runs it from source — Node 22.18+ strips types unprompted and git-kanban has no runtime
dependencies, so there is no `npm install`, no build, and no `node_modules`.

**`BPMichon/GitKanban` is private.** You need access to it. If you do not have it, the
clone fails and **the install is abandoned** — you get git's own authentication error and
no plugin, rather than a plugin that installs cleanly and dies at first use. That is the
whole reason this is a declared requirement instead of a "run `npm i -g` first" note in a
README: the failure lands where someone can act on it.

Pinned at **v0.1.0** deliberately. Before that tag, deleting a card that never had a
description removed the file and then failed to commit the removal, so the card came back
on the next clone while looking gone locally — and this plugin's Delete button hits that
path directly. `agentic plugin update kanban` is what moves the pin.

## Set the source

Open the **Kanban** tab. With no board configured it asks for one:

| | |
|---|---|
| **Repository** | a GitHub URL. Cloned if the folder is empty; ignored if it already holds a clone |
| **Folder** | project-relative, default `.AgenticProject/board`. `.` makes the project its own board |
| **Port** | default `7777`. Two boards on one machine need two ports |

Connect then runs `kanban init` (idempotent — safe on a live board, and how an older board
picks up new merge rules), records the choice in `.AgenticProject/kanban.json`, and adds
the clone to the project's `.gitignore`. **Change source** in the bar reopens the form.

A private clone uses whatever credentials git already has — a credential helper or an SSH
agent. No prompt can be shown from inside the app, so a clone that needs one fails with
git's own message instead of hanging.

## What running it means

Start runs `kanban serve` in the board's folder. That server commits every change, pushes
and pulls every ten seconds, and is the only writer — this plugin owns no part of the card
format, because a card is a CRDT (fractional ranks, hybrid logical clocks, an append-only
body log) and a second writer that parsed the front matter itself would corrupt the board
the first time two people edited one card.

The server is **not detached**: it stops when the window closes, because a copy that
outlived the app would keep pushing to a repository nobody is watching.

## Concurrent edits

Both halves of git-kanban's conflict story are reachable from the card editor:

- **`⚠ priority` on a card** — someone else set that field at the same time and the losing
  value was kept rather than dropped. Open the card and choose *Use theirs* or *Keep mine*;
  naming the field in a save resolves it either way.
- **A save refused** — the field changed while the card was open. The editor shows both
  values and asks which one wins. Every save carries the values it loaded as `base`, which
  is what lets two people edit different fields of one card and both succeed.

## Actions

| | |
|---|---|
| `kanban.state` | read-only, and the one the UI polls. The board, plus whether it is configured and serving |
| `kanban.connect` | set the git source, cloning if needed |
| `kanban.serve` | start the local server |
| `kanban.add` `kanban.move` `kanban.edit` `kanban.remove` | one card each |

Everything but `kanban.state` is mutating, so each one writes a run record. That is not
noise: a move recorded in Runs is the same event the board is about to push.

## Why it polls

A plugin UI runs in `<iframe sandbox="allow-scripts">` with `connect-src 'none'`, so it
cannot reach `127.0.0.1:7777` itself — and `serve`'s `change` event stream is therefore
unreachable from the frame. Data arrives through `api.invoke` instead, and the board is
re-read every three seconds. `kanban.state` is flagged non-mutating precisely so that poll
does not write a run record every three seconds.
