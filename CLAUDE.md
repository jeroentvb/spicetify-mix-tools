# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## The environment (read this first)

This is a **Spicetify** extension. Spicetify is a modding platform for the **Spotify desktop client**,
which is an Electron-like app (Chromium + a big minified React web app). Our extension is a single JS
bundle that Spicetify loads into that web app, where it runs with access to the DOM and to Spotify's
internal `Spicetify.*` / `Spicetify.Platform.*` globals.

- Spicetify docs: https://spicetify.app/docs/customization/extensions
- Spicetify CLI repo: https://github.com/spicetify/cli
- Spicetify can enable Chromium **DevTools** in the client (`spicetify enable-devtools`), which is how
  the running HTML, the React tree, and the JS console are inspected.

### You cannot run or inspect the client yourself

There is no way for you to open Spotify, click the button, or read the console from here. Building
(`npm run build`/`watch`) only produces a bundle; it does **not** exercise the code. So:

- **To learn anything about Spotify's internals** — the shape of a `Platform.*` API, whether a method
  exists on this client version, what a DOM node / testid looks like, what props sit on a row's React
  fiber — **ask the user to run a snippet in the DevTools console and paste the result.** Don't guess
  at undocumented API shapes; confirm them this way.
- **To verify a change actually works**, ask the user to build, reload Spotify (`Ctrl/Cmd+R` in the
  client), and report what happened. There are no automated tests.

Everything about Spotify's internals here was reverse-engineered this way and is version-fragile.

## Commands

```sh
npm run watch        # rebuild on change, output into the local Spicetify Extensions folder
npm run build:local  # minified build into ./dist/sort-bpm.js
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .  (lint:fix to autofix)
```

Note: despite the `.tsx`/React JSX config, the extension builds its UI with **plain DOM APIs** — there
is no React tree of our own. `Spicetify` is an ambient global (typed in `src/types/`, which lint and
your edits should treat as vendored).

## What the code does & where the fragile parts live

`src/app.tsx` `main()` is the entry point spicetify-creator loads. See `README.md` for the user-facing
feature and `TECHNICAL.md` for the reverse-engineering write-up (BPM harvesting via React fiber props,
and the batched in-place reorder that preserves "date added"). **`TECHNICAL.md` is gitignored** — read
it locally; it's the most useful doc in the repo.

When a Spotify update breaks the extension, the version-dependent assumptions are isolated to three
files — start there, and confirm the new reality with a DevTools snippet run by the user:

- `src/constants/selectors.ts` — DOM selectors / testids (action bar, sort button), as ordered
  candidate lists.
- `src/services/bpm-column.ts` — the track-row selectors and the React-fiber prop shape (`item.bpm`)
  that BPM is scraped from.
- `src/services/playlist.ts` — `Spicetify.Platform.PlaylistAPI` method names and the modification
  payload shape used for reordering.
