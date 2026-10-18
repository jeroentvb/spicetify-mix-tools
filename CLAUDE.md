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

### Inspecting the live client via the Chrome DevTools Protocol

The user runs Spotify with `--remote-debugging-port=9222 --remote-allow-origins=*`, so you can inspect
and drive the running client yourself over CDP on `localhost:9222`. Building (`npm run build`/`watch`)
only produces a bundle and does **not** exercise the code, so use the client to confirm things.

- Check it's up: `curl -s http://127.0.0.1:9222/json/version`. If it isn't, ask the user to restart
  Spotify with those flags (on macOS:
  `/Applications/Spotify.app/Contents/MacOS/Spotify --remote-debugging-port=9222 --remote-allow-origins=*`).
- `curl -s http://127.0.0.1:9222/json/list` lists targets. The app is the `page` target whose `url` is
  `https://xpui.app.spotify.com/index.html`. Its `title` shows the current view.
- Evaluate JS in that page with `Runtime.evaluate` over its `webSocketDebuggerUrl`. Node has a global
  `WebSocket`, so a small script in the scratchpad works:

  ```js
  // node cdp.mjs <file-with-js-expression>
  import { readFileSync } from 'node:fs';
  const expression = readFileSync(process.argv[2], 'utf8');
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const t = targets.find((t) => t.type === 'page' && /xpui/.test(t.url));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
     const d = JSON.parse(m.data);
     if (d.id === 1) { console.log(JSON.stringify(d.result?.result?.value ?? d.result, null, 2)); ws.close(); }
  };
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
     params: { expression, returnByValue: true, awaitPromise: true } }));
  ```

  Return plain JSON-serializable values (e.g. `outerHTML.slice(...)`, key lists), not DOM nodes.
- **To learn about Spotify's internals**, such as a `Platform.*` API shape, whether a global still
  exists (`Object.keys(Spicetify)`), a DOM node or testid, or a track's BPM/key data
  (`await window.mixTools.getTrackData(items)`), query the client this way instead of guessing.
- **To verify a change**, run `npm run build` (it writes into the Spicetify Extensions folder), reload
  the client by evaluating `location.reload()`, wait a few seconds, then query the DOM or
  `window.mixTools`. The button is injected asynchronously, so a check made right after load can miss it.
- `window.mixTools` is set only once `main()` has finished starting up. If it's missing but the
  extension's `<style>` tag is present, `main()` is stuck in its startup wait loop.
- Reading state and reloading are fine. Ask before doing anything that changes the user's data, such as
  running a sort/reorder or creating playlists through the UI or `PlaylistAPI`.
- The client UI is in **Dutch**, so `aria-label` selectors with English text don't match. Prefer testids
  and class names.

There are no automated tests. Everything about Spotify's internals here was reverse-engineered and is
version-fragile.

## Commands

```sh
npm run watch        # rebuild on change, output into the local Spicetify Extensions folder
npm run build:local  # minified build into ./dist/mix-tools.js
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .  (lint:fix to autofix)
```

The UI (`src/components/*.tsx`) is **React**, using Spotify's own copy: spicetify-creator maps `react` /
`react-dom` imports onto `Spicetify.React` / `Spicetify.ReactDOM` (React 18, so `@types/react@18`). We
don't own Spotify's tree, so `inject.tsx` / `mix-time.tsx` create small host elements in Spotify's DOM
and render a separate root into each via `src/utils/mount.ts`. Menus and popups are portaled to
`<body>`. `Spicetify` is an ambient global (typed in `src/types/`, which lint and your edits should
treat as vendored).

## What the code does & where the fragile parts live

`src/app.tsx` `main()` is the entry point spicetify-creator loads. See `README.md` for the user-facing
feature and `TECHNICAL.md` for the reverse-engineering write-up (BPM harvesting via React fiber props,
and the batched in-place reorder that preserves "date added"). **`TECHNICAL.md` is gitignored** — read
it locally; it's the most useful doc in the repo.

When a Spotify update breaks the extension, the version-dependent assumptions are isolated to four
files — start there, and confirm the new reality by querying the live client over CDP:

- `src/constants/selectors.ts` — DOM selectors / testids (action bar, sort button), as ordered
  candidate lists.
- `src/services/audio-attributes.ts` — where BPM and musical key come from: the client's
  metadata-extensions service (`Platform.PlaylistAPI._metadataExtensionsAPI.fetch`), extension
  kind `AUDIO_ATTRIBUTES_V2` (222), shaped `{ bpm, key: { camelotKey: { value } } }`, times the
  row's `item.speed` format-list attribute. `getTrackData(items)` is on `window.mixTools`.
- `src/services/playlist.ts` — `Spicetify.Platform.PlaylistAPI` method names and the modification
  payload shape used for reordering.
- `src/services/mix.ts` — mix-mode detection and the `Spicetify.Platform.PlaylistMixingAPI`
  transition lookups (`getCustomTransitionForTrackPair` / `getAutoTransitionForTrackPair` and the
  `overlap` shape) behind the mixed-playtime label. `getMixStats(uri)` is on `window.mixTools`.
