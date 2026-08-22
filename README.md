# agentic-catalogue

General-purpose plugins for [Agentic Project](https://github.com/BPMichon/AgenticProject).
Nothing here knows about any particular domain — that is the whole entry
requirement.

```powershell
agentic catalogue add https://github.com/BPMichon/agentic-catalogue.git
agentic plugin search
agentic plugin install git
```

| Plugin | What it does |
|---|---|
| `git` | Draws the commit graph of any repository the project declares, in its own desktop tab |
| `updates` | Lists software on this machine with a newer version available, via winget. Never installs anything |

Both declare `appliesTo.projectKinds: ["*"]`, so they load in every project.

## Why these two and not the others

The kernel repository ships `sample-docs`, `example-panel`, `example-dock` and
`reference-notes`. None belong here: they are teaching material for the tutorial
and the `create-plugin` task, and a fresh clone has to work before any catalogue
is configured. A plugin earns a place here by being useful in a project someone
else owns.

`git` used to ship inside the kernel repository, which quietly made "the studio
knows no domain" untrue — a commit-graph viewer is a domain, just a very common
one. Moving it out is what made that claim honest.

## Writing one

A plugin is a folder with a `plugin.json`. Actions import `node:*` and their own
files and nothing else — `zod` arrives as `ctx.z`, so a plugin needs no
`node_modules` and no build step. See
[docs/PluginApps.md](https://github.com/BPMichon/AgenticProject/blob/main/docs/PluginApps.md)
and the `create-plugin` task.

To add one here: drop the folder in `plugins/`, add an entry to
`catalogue.json`, and open a pull request. An entry's `id` must match the `id`
in the plugin's own manifest — installs are refused otherwise, deliberately,
because `installed` outranks `builtin` and a mismatched entry could shadow a
plugin someone already trusts.

## Tests

```sh
npm test
```

No dependencies and no install step — plugins ship their own tests and this runs
them with `node --test`. `git`'s lane assignment is the one real algorithm in
here and is covered: a wrong lane does not throw, it draws a plausible graph of
history that never happened.
