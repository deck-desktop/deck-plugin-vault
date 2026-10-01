# Vault

Browse and edit an Obsidian vault as live-preview markdown, with wikilinks and backlinks.

`[[Links]]` resolve the way Obsidian resolves them - shortest unique name first - and every note
shows what links back to it. Editing is live preview rather than a split pane: the markdown is
styled in place, so there is no source-and-preview pair to keep in sync.

The manifest sets `fullBleed`, so the tab gets the whole window without Deck's usual padding.

## What it exports

| Export | Where it renders |
|---|---|
| `default` | the tab: the file tree and the editor |

## Checks

```sh
node plugins/vault/vault.check.mjs
```

Wikilink parsing, link resolution and backlink collection - the part that decides whether a link
goes to the right note.

## Build

```sh
node plugins/vault/build.mjs
```

See [../README.md](../README.md) for how the build and the shims work.

## Install

Copy `plugin.json` and `plugin.js` into `%APPDATA%\Deck\plugins\vault\` (`Deck-Dev` for a
debug build) and restart Deck.
