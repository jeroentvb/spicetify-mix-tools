import { setButtonBusy } from '../components/bpm-button';
import { planAutomix, type BarPreference, type MixTrack } from './automix';
import { getCurrentPlaylistUri } from './current-uri';
import { isMixEnabled, pairKey, resetCustomTransition, saveCustomTransition } from './mix';
import {
   canModify,
   createSortedPlaylist,
   getContents,
   getPlaylistName,
   reorderInPlace,
   type PlaylistItem,
   sortTracks,
   type SortDirection,
   type SortMode,
   type SortResult,
} from './playlist';
import { getTrackData } from './audio-attributes';

const DIRECTION: SortDirection = 'asc';

/** Everything that differs between the sort modes, so the workflow below stays single-copy. */
interface SortModeSpec {
   mode: SortMode;
   /** Notification prefix, e.g. `Mix Tools: …`. */
   prefix: string;
   /** What is being fetched, for the "reading … for N tracks" notice. */
   reading: string;
   /** How the resulting order is described in the success summary. */
   order: string;
   /** What the tracks moved to the end were missing, e.g. `without BPM`. */
   missing: string;
   /** Bracketed suffix for a new playlist's name: `My list (BPM)`. */
   nameSuffix: string;
   /** Shown when not one track had usable data. */
   noData: string;
}

const SPECS: Record<SortMode, SortModeSpec> = {
   bpm: {
      mode: 'bpm',
      prefix: 'Sort BPM',
      reading: 'BPM',
      order: 'by BPM',
      missing: 'without BPM',
      nameSuffix: 'BPM',
      noData: 'Spotify has no BPM for any track in this playlist',
   },
   key: {
      mode: 'key',
      prefix: 'Sort key',
      reading: 'key and BPM',
      order: 'by key + BPM',
      missing: 'without a key',
      nameSuffix: 'Key',
      noData: 'Spotify has no musical key for any track in this playlist',
   },
};

/**
 * Show a toast. Newer Spicetify builds no longer define `Spicetify.showNotification`, and
 * `Spicetify.Snackbar` only exposes `enqueueCustomSnackbar(children, options)` (a headless
 * notistack variant, so we style the element ourselves). Falls back to the console.
 */
function notify(spec: Pick<SortModeSpec, 'prefix'>, message: string, isError = false): void {
   const text = `${spec.prefix}: ${message}`;
   const legacy = (Spicetify as { showNotification?: unknown }).showNotification;
   if (typeof legacy === 'function') {
      legacy(text, isError);
      return;
   }

   const snackbar = (Spicetify as { Snackbar?: { enqueueCustomSnackbar?: unknown } }).Snackbar;
   if (typeof snackbar?.enqueueCustomSnackbar === 'function' && Spicetify.React) {
      const element = Spicetify.React.createElement('div', {
         style: {
            background: isError ? '#e22134' : '#2e77d0',
            color: '#fff',
            padding: '12px 16px',
            borderRadius: '8px',
            fontSize: '14px',
            fontWeight: 600,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
         },
      }, text);
      snackbar.enqueueCustomSnackbar(element, { keyPrefix: 'mix-tools', autoHideDuration: isError ? 6000 : 4000 });
      return;
   }

   (isError ? console.error : console.log)(text);
}

/** Log the resulting order for the devtools correctness check (see TECHNICAL.md). */
function logOrder(spec: SortModeSpec, result: SortResult): void {
   const sorted = result.ordered.slice(0, result.sortedCount);
   console.table(sorted.map((item) => (spec.mode === 'key'
      ? { name: item.name ?? item.uri, key: item.camelotKey, bpm: item.bpm }
      : { name: item.name ?? item.uri, bpm: item.bpm })));
}

/** Shared front half: load tracks, fetch their BPM + key, sort. */
async function prepare(uri: string, spec: SortModeSpec): Promise<SortResult | null> {
   const items = await getContents(uri);
   if (items.length === 0) {
      notify(spec, 'this playlist is empty', true);
      return null;
   }

   notify(spec, `reading ${spec.reading} for ${items.length} tracks…`);
   setButtonBusy('0%');
   const data = await getTrackData(items, (done, total) => {
      setButtonBusy(`${Math.min(99, Math.round((done / total) * 100))}%`);
   });

   const result = sortTracks(items, data, spec.mode, DIRECTION);
   if (result.sortedCount === 0) {
      notify(spec, spec.noData, true);
      return null;
   }

   logOrder(spec, result);
   return result;
}

function summary(spec: SortModeSpec, result: SortResult): string {
   const base = `Sorted ${result.sortedCount} tracks ${spec.order}`;
   return result.skipped.length > 0
      ? `${base} · ${result.skipped.length} ${spec.missing} moved to end`
      : base;
}

/** Reorder the current playlist in place. */
async function runReorder(spec: SortModeSpec): Promise<void> {
   const uri = getCurrentPlaylistUri();
   if (!uri) return notify(spec, 'open a playlist first', true);

   if (!(await canModify(uri))) {
      return notify(spec, 'you can only reorder playlists you own', true);
   }

   try {
      const result = await prepare(uri, spec);
      if (!result) return;

      await reorderInPlace(uri, result.ordered, (done, total) => {
         setButtonBusy(`${Math.round((done / total) * 100)}%`);
      });
      notify(spec, summary(spec, result));
   } catch (err) {
      console.error(`${spec.prefix} reorder failed:`, err);
      notify(spec, 'failed to reorder playlist (see console)', true);
   } finally {
      setButtonBusy(null);
   }
}

/** Sort into a brand new playlist, leaving the original untouched. */
async function runToNewPlaylist(spec: SortModeSpec): Promise<void> {
   const uri = getCurrentPlaylistUri();
   if (!uri) return notify(spec, 'open a playlist first', true);

   try {
      const result = await prepare(uri, spec);
      if (!result) return;

      const name = `${await getPlaylistName(uri)} (${spec.nameSuffix})`;
      const newUri = await createSortedPlaylist(uri, result.ordered, name);

      notify(spec, `created "${name}" · ${summary(spec, result)}`);
      Spicetify.Platform.History.push(`/playlist/${newUri.split(':').pop()}`);
   } catch (err) {
      console.error(`${spec.prefix} new-playlist failed:`, err);
      notify(spec, 'failed to create sorted playlist (see console)', true);
   } finally {
      setButtonBusy(null);
   }
}

/** Reorder the current playlist in place by BPM. */
export function sortReorderByBpm(): Promise<void> {
   return runReorder(SPECS.bpm);
}

/** Reorder the current playlist in place by Camelot key, then BPM within each key. */
export function sortReorderByKey(): Promise<void> {
   return runReorder(SPECS.key);
}

/** Copy the current playlist into a new one sorted by BPM. */
export function sortToNewPlaylistByBpm(): Promise<void> {
   return runToNewPlaylist(SPECS.bpm);
}

/** Copy the current playlist into a new one sorted by Camelot key, then BPM. */
export function sortToNewPlaylistByKey(): Promise<void> {
   return runToNewPlaylist(SPECS.key);
}

const AUTOMIX = { prefix: 'Improved automix' };

/** Show a progress fraction on the button. */
function busyPercent(done: number, total: number): void {
   setButtonBusy(`${Math.min(99, Math.round((done / total) * 100))}%`);
}

/**
 * Load the playlist, read BPM + key, and plan the mix. Tracks without both are left out of
 * the plan and kept at the end, like the sorts do.
 */
async function prepareAutomix(uri: string, preference: BarPreference) {
   const items = await getContents(uri);
   const data = await getTrackData(items, busyPercent);

   const tracks: (PlaylistItem & MixTrack)[] = [];
   const skipped: PlaylistItem[] = [];
   for (const item of items) {
      const found = data.get(item.uri);
      if (found?.bpm != null && found.camelotKey != null) {
         tracks.push({ ...item, bpm: found.bpm, camelotKey: found.camelotKey });
      } else {
         skipped.push(item);
      }
   }

   const plan = await planAutomix(tracks, preference, busyPercent);
   return { plan, skipped };
}

/**
 * The current playlist, if the improved automix can run on it; otherwise null, after
 * telling the user why. Checked before asking for a bar length, not after.
 */
export async function automixTarget(): Promise<string | null> {
   const uri = getCurrentPlaylistUri();
   if (!uri) {
      notify(AUTOMIX, 'open a playlist first', true);
      return null;
   }
   if (!(await canModify(uri))) {
      notify(AUTOMIX, 'you can only mix playlists you own', true);
      return null;
   }
   if (!(await isMixEnabled(uri))) {
      notify(AUTOMIX, 'turn on mixing for this playlist first', true);
      return null;
   }
   return uri;
}

/**
 * Reorder a mixed playlist for harmonic mixing and give every pair a transition of the
 * preferred length. In `'auto'` mode the pairs are left to Spotify's own transitions
 * instead. See `services/automix.ts`.
 */
export async function improvedAutomix(uri: string, preference: BarPreference): Promise<void> {
   try {
      notify(AUTOMIX, 'reading key + BPM and rating transitions…');
      setButtonBusy('0%');
      const { plan, skipped } = await prepareAutomix(uri, preference);
      if (plan.ordered.length < 2) {
         return notify(AUTOMIX, 'not enough tracks with both a key and a BPM', true);
      }

      await reorderInPlace(uri, [...plan.ordered, ...skipped], busyPercent);

      // Read the rows back: a reorder that fell back to re-adding gives them new uids.
      const rows = await getContents(uri);
      const pairs = rows.slice(0, -1).flatMap((a, i) => {
         const b = rows[i + 1];
         const transition = plan.transitions.get(pairKey(a.uri, b.uri));
         return transition ? [{ a, b, transition }] : [];
      });

      let preferred = 0;
      for (let i = 0; i < pairs.length; i++) {
         const { a, b, transition } = pairs[i];
         if (preference === 'auto') {
            // Leave the pair automatic, clearing any hand-edited transition from an earlier run.
            await resetCustomTransition(uri, a, b);
         } else {
            await saveCustomTransition(uri, a, b, transition);
            if (transition.overlap.durationBars === preference) preferred++;
         }
         busyPercent(i + 1, pairs.length);
      }

      const base = preference === 'auto'
         ? `mixed ${plan.ordered.length} tracks with Spotify's own transitions`
         : `mixed ${plan.ordered.length} tracks · ${preferred}× ${preference}-bar, ${pairs.length - preferred}× shorter transitions`;
      notify(AUTOMIX, skipped.length > 0 ? `${base} · ${skipped.length} without key/BPM moved to end` : base);
   } catch (err) {
      console.error('Improved automix failed:', err);
      notify(AUTOMIX, 'failed to mix playlist (see console)', true);
   } finally {
      setButtonBusy(null);
   }
}

/**
 * Plan the improved automix for the current playlist without changing anything, and log
 * the result. A devtools helper on `window.mixTools`.
 */
export async function previewAutomix(preference: BarPreference = 'auto'): Promise<unknown[]> {
   const uri = getCurrentPlaylistUri();
   if (!uri) return [];

   try {
      const { plan } = await prepareAutomix(uri, preference);
      const table = plan.ordered.map((track, i) => {
         const next = plan.ordered[i + 1];
         const transition = next ? plan.transitions.get(pairKey(track.uri, next.uri)) : undefined;
         return { name: track.name, bpm: track.bpm, key: track.camelotKey, bars: transition?.overlap.durationBars ?? null };
      });
      console.table(table);
      return table;
   } finally {
      setButtonBusy(null);
   }
}
