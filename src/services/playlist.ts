import { chunk } from '../utils/chunk';
import { camelotRank, type CamelotCode } from './camelot';
import type { TrackData } from './audio-attributes';

export interface PlaylistItem {
   uri: string;
   uid: string;
   name?: string;
   bpm?: number | null;
   camelotKey?: CamelotCode | null;
   [key: string]: unknown;
}

export type SortDirection = 'asc' | 'desc';

/**
 * What to sort on.
 * - `bpm` — tempo alone.
 * - `key` — Camelot key first (1A, 1B, 2A … 12B), then tempo within each key.
 */
export type SortMode = 'bpm' | 'key';

export interface SortResult {
   /** Full playlist order: sortable tracks first, then the ones we had no data for. */
   ordered: PlaylistItem[];
   /** How many tracks had the data this sort mode needs. */
   sortedCount: number;
   /** Tracks with no usable data (local files, podcasts, unavailable) — kept at the end. */
   skipped: PlaylistItem[];
}

/** Fetch the raw items of a playlist. Each item carries both `uri` and `uid`. */
export async function getContents(uri: string): Promise<PlaylistItem[]> {
   const contents = await Spicetify.Platform.PlaylistAPI.getContents(uri);
   return (contents?.items ?? []) as PlaylistItem[];
}

/** Playlist display name, best-effort. */
export async function getPlaylistName(uri: string): Promise<string> {
   try {
      const meta = await Spicetify.Platform.PlaylistAPI.getMetadata(uri);
      return meta?.name ?? 'Playlist';
   } catch {
      return 'Playlist';
   }
}

/** Whether the current user can modify (reorder) this playlist. */
export async function canModify(uri: string): Promise<boolean> {
   try {
      const meta = await Spicetify.Platform.PlaylistAPI.getMetadata(uri);
      if (typeof meta?.canAdd === 'boolean') return meta.canAdd;
      if (typeof meta?.permissions?.canEdit === 'boolean') return meta.permissions.canEdit;
      if (typeof meta?.isOwnedBySelf === 'boolean') return meta.isOwnedBySelf;
      return true; // Unknown shape — let the attempt proceed and surface any error.
   } catch {
      return true;
   }
}

/**
 * Return the playlist ordered for `mode`, using the `uri -> data` map of Spotify's own
 * BPM and key values (the ones its columns display).
 *
 * Tracks missing the data the mode needs are appended at the end — never silently
 * interleaved into a wrong position. Ties keep the playlist's existing relative order,
 * since Array#sort is stable.
 *
 * `direction` applies to the BPM axis only; the Camelot wheel is always walked upwards,
 * because descending it isn't a meaningful DJ operation the way descending tempo is.
 */
export function sortTracks(
   items: PlaylistItem[],
   data: Map<string, TrackData>,
   mode: SortMode,
   direction: SortDirection,
): SortResult {
   const sortable: { item: PlaylistItem; rank: number; bpm: number }[] = [];
   const skipped: PlaylistItem[] = [];

   for (const item of items) {
      const found = data.get(item.uri);
      const bpm = found?.bpm ?? null;
      const camelotKey = found?.camelotKey ?? null;
      const enriched: PlaylistItem = { ...item, bpm, camelotKey };

      if (mode === 'key' ? camelotKey === null : bpm === null) {
         skipped.push(enriched);
         continue;
      }

      sortable.push({
         item: enriched,
         rank: camelotKey ? camelotRank(camelotKey) : 0,
         // Key mode only: a track with a key but no BPM parks at the end of its key group.
         bpm: bpm ?? Number.POSITIVE_INFINITY,
      });
   }

   const sign = direction === 'asc' ? 1 : -1;
   sortable.sort((a, b) => {
      if (mode === 'key' && a.rank !== b.rank) return a.rank - b.rank;
      // Equality check first: two BPM-less tracks in key mode would otherwise compute
      // Infinity - Infinity = NaN, and a comparator returning NaN leaves order undefined.
      if (a.bpm === b.bpm) return 0;
      return sign * (a.bpm - b.bpm);
   });

   const ordered = [...sortable.map((entry) => entry.item), ...skipped];
   return { ordered, sortedCount: sortable.length, skipped };
}

function sameUids(a: string[], b: string[]): boolean {
   return a.length === b.length && a.every((uid, i) => uid === b[i]);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function applyModify(uri: string, modification: object): Promise<void> {
   const api = Spicetify.Platform.PlaylistAPI;
   if (typeof api._playlistServiceClient?.modify === 'function') {
      const response = await api._playlistServiceClient.modify({ uri, request: modification });
      // The service reports failures in the response rather than by rejecting.
      const status = response?.status?.statusCode;
      if (typeof status === 'number' && (status < 200 || status > 299)) {
         throw new Error(`Playlist modify failed (${status}): ${response.status.reason ?? ''}`);
      }
   } else if (typeof api.applyModification === 'function') {
      await api.applyModification(uri, modification, true);
   } else {
      throw new Error('No compatible PlaylistAPI modification method found');
   }
}

interface BatchMove { rows: string[]; before: string }

/** Max rows per `move` call. */
const MAX_BATCH = 50;

/**
 * Plan a sequence of `move` operations to turn `currentUids` into `targetUids`.
 * Spotify's `move` keeps the moved rows in their *current* relative order, so we
 * only batch tracks already correctly ordered relative to each other (and cap each
 * batch at MAX_BATCH). We grow a correct prefix at the top: each step moves the next
 * run of already-in-order target tracks before the item currently at that position.
 * Simulated locally so all anchors are computed up front.
 */
function planBatchedMoves(currentUids: string[], targetUids: string[]): BatchMove[] {
   const local = [...currentUids];
   const moves: BatchMove[] = [];
   let p = 0;

   while (p < local.length) {
      if (local[p] === targetUids[p]) {
         p++;
         continue;
      }

      const anchor = local[p];
      const batch: string[] = [];
      let lastIdx = -1;

      for (let j = p; j < targetUids.length && batch.length < MAX_BATCH; j++) {
         const idx = local.indexOf(targetUids[j]);
         if (idx > p && idx > lastIdx) {
            batch.push(targetUids[j]);
            lastIdx = idx;
         } else {
            break;
         }
      }

      if (batch.length === 0) { // safety net for unexpected data; shouldn't happen
         p++;
         continue;
      }

      moves.push({ rows: [...batch], before: anchor });

      // Mirror the move locally: remove the batch, reinsert it before the anchor.
      const batchSet = new Set(batch);
      for (let k = local.length - 1; k >= 0; k--) {
         if (batchSet.has(local[k])) local.splice(k, 1);
      }
      local.splice(local.indexOf(anchor), 0, ...batch);
      p += batch.length;
   }

   return moves;
}

/** Max plan-and-move passes before giving up on an in-place reorder. */
const MAX_ROUNDS = 5;

/** How long the playlist order must stay unchanged before we trust a read of it. */
const SETTLE_MS = 700;

/**
 * Read the playlist's row uids once the order has stopped changing. Right after a
 * burst of moves, the client can still be reconciling with the server, and a move
 * that read back fine may be undone a moment later.
 */
async function readSettledUids(uri: string): Promise<string[]> {
   let previous = (await getContents(uri)).map((item) => item.uid);
   for (let i = 0; i < 10; i++) {
      await delay(SETTLE_MS);
      const current = (await getContents(uri)).map((item) => item.uid);
      if (sameUids(previous, current)) return current;
      previous = current;
   }
   return previous;
}

/**
 * Move rows until the playlist matches `targetUids`. Back-to-back moves are
 * occasionally dropped by the client's sync even though each `modify` reports
 * success, so a single pass leaves a few tracks stranded. Each round therefore
 * re-reads the settled order and plans moves from what's really there; the
 * correction rounds after the first are short. Returns whether the order matches.
 */
async function convergeByMoves(
   uri: string,
   targetUids: string[],
   onProgress?: (done: number, total: number) => void,
): Promise<boolean> {
   for (let round = 0; round < MAX_ROUNDS; round++) {
      const currentUids = await readSettledUids(uri);
      if (sameUids(currentUids, targetUids)) return true;

      const moves = planBatchedMoves(currentUids, targetUids);
      for (let i = 0; i < moves.length; i++) {
         await applyModify(uri, { operation: 'move', rows: moves[i].rows, before: moves[i].before });
         onProgress?.(i + 1, moves.length);
      }
   }
   return sameUids(await readSettledUids(uri), targetUids);
}

/**
 * Reorder the playlist in place to match `ordered`, using batched `move` calls
 * (≤ MAX_BATCH rows each). Pure reorder — nothing is removed and "date added" is
 * preserved. Only falls back to remove + re-add (which resets "date added") if the
 * moves can't produce the exact order.
 */
export async function reorderInPlace(
   uri: string,
   ordered: PlaylistItem[],
   onProgress?: (done: number, total: number) => void,
): Promise<void> {
   const targetUids = ordered.map((item) => item.uid);
   if (targetUids.length === 0) return;

   try {
      if (await convergeByMoves(uri, targetUids, onProgress)) return;
   } catch (err) {
      console.warn('Mix Tools: batched move failed; falling back', err);
   }

   console.info('Mix Tools: in-place moves did not fully apply; falling back to remove + re-add');
   await replaceInOrder(uri, ordered);

   // Re-adding in batches can race the same way, so straighten out any strays. The
   // re-added rows have new uids, so map the target order onto them by track uri.
   const readded = await getContents(uri);
   const uidsByUri = new Map<string, string[]>();
   for (const item of readded) uidsByUri.set(item.uri, [...(uidsByUri.get(item.uri) ?? []), item.uid]);
   const readdedTarget = ordered.map((item) => uidsByUri.get(item.uri)?.shift()).filter((uid) => uid !== undefined);

   if (!(await convergeByMoves(uri, readdedTarget, onProgress))) {
      throw new Error('Playlist order did not match after re-adding the tracks');
   }
}

/** Reliable fallback: remove every track, then re-add in the desired order. Resets "date added". */
async function replaceInOrder(uri: string, ordered: PlaylistItem[]): Promise<void> {
   const api = Spicetify.Platform.PlaylistAPI;
   const contents = await getContents(uri);

   for (const batch of chunk(contents.map((item) => ({ uri: item.uri, uid: item.uid })), 100)) {
      await api.remove(uri, batch);
   }
   for (const batch of chunk(ordered.map((item) => item.uri), 100)) {
      await api.add(uri, batch, { after: 'end' });
   }
   if (typeof api.resync === 'function') await api.resync(uri);
}

/**
 * Create a new playlist next to the source and add the sorted tracks to it.
 * The original playlist is left untouched. Returns the new playlist URI.
 */
export async function createSortedPlaylist(sourceUri: string, ordered: PlaylistItem[], name: string): Promise<string> {
   const uris = ordered.map((item) => item.uri);

   const rootlist = Spicetify.Platform.RootlistAPI;
   const created = await rootlist.createPlaylist(name, { after: sourceUri });
   const newUri: string = typeof created === 'string' ? created : created?.uri;
   if (!newUri) throw new Error('Failed to create playlist');

   for (const batch of chunk(uris, 100)) {
      await Spicetify.Platform.PlaylistAPI.add(newUri, batch, { after: 'end' });
   }

   return newUri;
}
