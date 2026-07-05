/**
 * Reads Spotify's own displayed BPM (the octave-corrected value shown in the
 * playlist's BPM column, used by its mix/automix feature). This value lives on
 * each rendered row's React props as `item.bpm` and is NOT returned by
 * PlaylistAPI.getContents, nor kept in memory for the whole playlist — only for
 * the ~25 virtualized rows currently rendered. So we scroll the list and harvest
 * each window's values into a `uri -> bpm` map.
 */

const ROW_SELECTOR = '.main-trackList-trackListRow';
const LIST_SELECTOR = '.main-trackList-trackList, .main-trackList-indexable';

const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Fiber {
   return: Fiber | null;
   memoizedProps?: { item?: { uri?: string; bpm?: number } };
}

function getFiber(el: Element): Fiber | null {
   const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
   return key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null;
}

/** Read `{ uri, bpm }` from a rendered row by walking its React fiber props. */
function readRow(rowEl: Element): { uri: string; bpm: number } | null {
   let fiber = getFiber(rowEl);
   for (let i = 0; i < 30 && fiber; i++, fiber = fiber.return) {
      const item = fiber.memoizedProps?.item;
      if (item && typeof item.uri === 'string' && item.uri.startsWith('spotify:track:') && typeof item.bpm === 'number') {
         return { uri: item.uri, bpm: item.bpm };
      }
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
 * Scroll the current tracklist top-to-bottom, harvesting Spotify's column BPM for
 * every track. Returns a Map keyed by track uri. Tracks whose BPM never renders
 * (e.g. local files) are simply absent from the map.
 * @param totalCount expected number of tracks, used to stop early once all are seen
 * @param onProgress optional callback (found, total)
 */
export async function harvestColumnBpm(
   totalCount: number,
   onProgress?: (found: number, total: number) => void,
): Promise<Map<string, number>> {
   const list = document.querySelector(LIST_SELECTOR);
   const scroller = getScrollContainer(list);
   const map = new Map<string, number>();

   const readVisible = () => {
      document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
         const data = readRow(row);
         if (data) map.set(data.uri, data.bpm);
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
