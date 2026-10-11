/**
 * Reads the per-track values Spotify shows in the playlist's own BPM and Key columns
 * (the ones its mix/automix feature uses):
 *
 * - `item.bpm` — the octave-corrected tempo, deliberately not the raw `audio-features`
 *   value, which is half/double-off for many tracks.
 * - `item.key.camelotKey` — a ready-made Camelot code such as `'9B'`.
 *
 * Neither is returned by PlaylistAPI.getContents, and neither is kept in memory for the
 * whole playlist — only for the ~25 virtualized rows currently rendered. So we scroll the
 * list once and harvest each window's values into a `uri -> data` map.
 */

import { asCamelotCode, type CamelotCode } from './camelot';

const ROW_SELECTOR = '.main-trackList-trackListRow';
const LIST_SELECTOR = '.main-trackList-trackList, .main-trackList-indexable';

const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What one rendered row gives us. Either field is null when Spotify didn't render it. */
export interface RowData {
   bpm: number | null;
   camelotKey: CamelotCode | null;
}

/**
 * A track row's React props. Every field is `unknown` because the shape is undocumented
 * and changes between client versions — narrow before use.
 */
interface RowItem {
   uri?: unknown;
   bpm?: unknown;
   key?: unknown;
}

interface Fiber {
   return: Fiber | null;
   memoizedProps?: { item?: RowItem };
}

function getFiber(el: Element): Fiber | null {
   const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
   return key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null;
}

/** Whether this fiber's `item` is the track object we're after. */
function isTrackItem(item: RowItem | undefined): item is RowItem & { uri: string } {
   return !!item && typeof item.uri === 'string' && item.uri.startsWith('spotify:track:');
}

/**
 * Pull the Camelot code out of a row's `key` prop, which Spotify shapes as
 * `{ standardKey, mode, camelotKey, color }`.
 */
function readCamelotKey(item: RowItem): CamelotCode | null {
   const key = item.key;
   if (!key || typeof key !== 'object') return null;
   return asCamelotCode((key as { camelotKey?: unknown }).camelotKey);
}

/** Read `{ uri, data }` from a rendered row by walking up its React fiber props. */
function readRow(rowEl: Element): { uri: string; data: RowData } | null {
   let fiber = getFiber(rowEl);
   for (let i = 0; i < 30 && fiber; i++, fiber = fiber.return) {
      const item = fiber.memoizedProps?.item;
      if (!isTrackItem(item)) continue;

      const bpm = typeof item.bpm === 'number' && Number.isFinite(item.bpm) ? item.bpm : null;
      const camelotKey = readCamelotKey(item);

      // Keep walking when this `item` carried neither value — an ancestor fiber may hold
      // the real row object. (Requiring a BPM here is what the BPM-only version did; the
      // looser test means a track with a key but no BPM isn't discarded outright.)
      if (bpm !== null || camelotKey !== null) return { uri: item.uri, data: { bpm, camelotKey } };
   }
   return null;
}

/** Nearest scrollable ancestor of the tracklist, preferring an explicit overflow. */
function getScrollContainer(el: Element | null): HTMLElement {
   let node = el?.parentElement ?? null;
   let fallback: HTMLElement | null = null;
   while (node) {
      if (node.scrollHeight > node.clientHeight + 4) {
         const overflowY = getComputedStyle(node).overflowY;
         if (overflowY === 'auto' || overflowY === 'scroll') return node;
         if (!fallback) fallback = node;
      }
      node = node.parentElement;
   }
   return fallback ?? (document.scrollingElement as HTMLElement) ?? document.body;
}

/**
 * Scroll the current tracklist top-to-bottom, harvesting Spotify's column BPM and key for
 * every track. Returns a Map keyed by track uri. Tracks whose values never render (e.g.
 * local files) are simply absent from the map.
 *
 * One pass serves every sort mode: BPM and key live on the same props object, so there is
 * nothing to gain from scrolling twice.
 * @param totalCount expected number of tracks, used to stop early once all are seen
 * @param onProgress optional callback (found, total)
 */
export async function harvestColumnData(
   totalCount: number,
   onProgress?: (found: number, total: number) => void,
): Promise<Map<string, RowData>> {
   const list = document.querySelector(LIST_SELECTOR);
   const scroller = getScrollContainer(list);
   const map = new Map<string, RowData>();

   const readVisible = () => {
      document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
         const read = readRow(row);
         if (!read) return;

         // Merge rather than overwrite: overlapping scroll windows can re-read a row
         // mid-render, and a second pass that only has the BPM must not drop the key.
         const previous = map.get(read.uri);
         map.set(read.uri, {
            bpm: read.data.bpm ?? previous?.bpm ?? null,
            camelotKey: read.data.camelotKey ?? previous?.camelotKey ?? null,
         });
      });
   };

   const savedScroll = scroller.scrollTop;
   scroller.scrollTop = 0;
   await raf();
   await delay(100);

   let lastSize = -1;
   let stagnant = 0;

   // Advance ~a viewport at a time; overlap keeps rows from slipping between windows.
   for (let step = 0; step < 1000; step++) {
      readVisible();
      onProgress?.(map.size, totalCount);

      if (map.size >= totalCount) break;

      if (map.size === lastSize) stagnant++;
      else {
         stagnant = 0;
         lastSize = map.size;
      }

      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      if (atBottom && stagnant >= 2) break;
      if (stagnant >= 10) break; // safety net if the list can't be scrolled further

      scroller.scrollTop += Math.max(200, scroller.clientHeight * 0.85);
      await raf();
      await delay(90);
   }

   readVisible();
   scroller.scrollTop = savedScroll;
   return map;
}

/**
 * Dump the raw React props of the first rendered track row, unfiltered.
 *
 * Exposed on `window.mixTools` because re-discovering this shape in DevTools is the first
 * thing needed whenever a Spotify update breaks harvesting — see TECHNICAL.md.
 */
export function inspectRowItem(): RowItem | null {
   const row = document.querySelector(ROW_SELECTOR);
   if (!row) return null;

   let fiber = getFiber(row);
   for (let i = 0; i < 30 && fiber; i++, fiber = fiber.return) {
      const item = fiber.memoizedProps?.item;
      if (isTrackItem(item)) return item;
   }
   return null;
}
