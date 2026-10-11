# Spicetify Mix Tools

![preview](docs/preview.png)

DJ-style playlist tools for the Spotify desktop client, via [Spicetify](https://spicetify.app).

It sorts a playlist for mixing — **by BPM (tempo)**, or **by musical key on the Camelot
wheel with BPM ascending inside each key** — and shows how long a mixed playlist really
plays once its transitions are taken into account.

A **BPM** button is added to the playlist action bar (between "Search in playlist" and the
sort/view button). Clicking it offers two destinations, each of which opens a submenu with
the two sort modes:

- **Reorder this playlist** — sorts the tracks in place. Preserves each track's
  "date added". Only works on playlists you own.
- **Sort into new playlist** — creates a new `"<name> (BPM)"` or `"<name> (Key)"` playlist
  and leaves the original untouched (works on any playlist).

Sort modes:

- **by BPM** — tempo, slowest to fastest.
- **by key + BPM** — Camelot order `1A, 1B, 2A, 2B … 12A, 12B`, then tempo ascending within
  each key. Relative minor/major pairs share a number (8A = A minor, 8B = C major), so this
  ordering keeps them adjacent and consecutive tracks are almost always harmonically
  mixable.

Tracks without the data the chosen mode needs (local files, podcasts, unavailable or
un-analyzed tracks) are moved to the end rather than being sorted into a wrong position,
and the count is reported.

> **Note:** the BPM and key values are read from the playlist's own **BPM** and **Key**
> columns, so the relevant column must be visible before sorting. If it isn't, enable it via
> the playlist's column/view settings (the "..." / column header menu). With the column
> hidden there is no data to read, and the extension says so rather than guessing.

## Mixed playtime

Spotify's header playtime adds up full track lengths, even on a playlist with **mix** mode
on, where transitions cut into intros and outros and overlap tracks. On mixed playlists the
extension shows the real length next to it, in the same format:

> 57 songs, 3 hr 43 min • 2 hr 4 min mixed ⓘ

It's calculated from the transitions you hand-edited in Spotify's mix editor. Any pair
without a hand-edited transition uses Spotify's automatic one. The ⓘ button opens a
breakdown:

- **Back to back**: the full length Spotify shows.
- **Intros skipped**: the start of each track, before the point where it's mixed in.
- **Outros skipped**: the end of each track, after its transition finishes.
- **Transition overlap**: time two tracks play at once.
- **Mixed**: what's left, with how many of the transitions are hand-edited.

The value refreshes when tracks are added or removed, and whenever you navigate back to the
playlist (e.g. after editing transitions).

## Development

```sh
npm install
npm run watch      # rebuild on change into the Spicetify Extensions folder
# or
npm run build:local  # minified build into ./dist
npm run typecheck
npm run lint
```

## Install (local)

```sh
npm run build:local
# copy dist/mix-tools.js to the Spicetify Extensions folder:
#   macOS/Linux: ~/.config/spicetify/Extensions
#   Windows:     %appdata%\spicetify\Extensions
spicetify config extensions mix-tools.js
spicetify apply
```
