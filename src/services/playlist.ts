import { chunk } from '../utils/chunk';

export interface PlaylistItem {
   uri: string;
   uid: string;
   name?: string;
   bpm?: number | null;
   [key: string]: unknown;
}

export type SortDirection = 'asc' | 'desc';

interface SortResult {
   /** Full playlist order: tracks with tempo (sorted) followed by tracks without. */
   ordered: PlaylistItem[];
   /** How many tracks had a usable BPM. */
   sortedCount: number;
   /** Tracks with no BPM (local files, podcasts, unavailable) — kept at the end. */
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
 * Return the playlist in BPM order using a `uri -> bpm` map (Spotify's displayed
 * column BPM). Tracks without a BPM are appended at the end — never silently
 * interleaved into a wrong position.
 */
export function sortByBpm(items: PlaylistItem[], bpmMap: Map<string, number>, direction: SortDirection): SortResult {
   const withBpm: { item: PlaylistItem; bpm: number }[] = [];
   const skipped: PlaylistItem[] = [];

   for (const item of items) {
      const bpm = bpmMap.get(item.uri);
      if (typeof bpm === 'number' && Number.isFinite(bpm)) {
         withBpm.push({ item: { ...item, bpm }, bpm });
      } else {
         skipped.push({ ...item, bpm: null });
      }
   }

   withBpm.sort((a, b) => (direction === 'asc' ? a.bpm - b.bpm : b.bpm - a.bpm));

   const ordered = [...withBpm.map((x) => x.item), ...skipped];
   return { ordered, sortedCount: withBpm.length, skipped };
}

function sameOrder(items: PlaylistItem[], uids: string[]): boolean {
   return items.length === uids.length && items.every((item, i) => item.uid === uids[i]);
}

async function applyModify(uri: string, modification: object): Promise<void> {
   const api = Spicetify.Platform.PlaylistAPI;
   if (typeof api._playlistServiceClient?.modify === 'function') {
      await api._playlistServiceClient.modify({ uri, request: modification });
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

/**
 * Reorder the playlist in place to match `ordered`, using batched `move` calls
 * (≤ MAX_BATCH rows each). Pure reorder — nothing is removed and "date added" is
 * preserved. Verifies the final order and only falls back to remove + re-add
 * (which resets "date added") if the moves didn't produce the exact order.
 */
export async function reorderInPlace(
   uri: string,
   ordered: PlaylistItem[],
   onProgress?: (done: number, total: number) => void,
): Promise<void> {
   const targetUids = ordered.map((item) => item.uid);
   if (targetUids.length === 0) return;

   const api = Spicetify.Platform.PlaylistAPI;

   try {
      const currentUids = (await getContents(uri)).map((item) => item.uid);
      const moves = planBatchedMoves(currentUids, targetUids);

      for (let i = 0; i < moves.length; i++) {
         await applyModify(uri, { operation: 'move', rows: moves[i].rows, before: moves[i].before });
         onProgress?.(i + 1, moves.length);
      }
      if (typeof api.resync === 'function') await api.resync(uri);
   } catch (err) {
      console.warn('Mix Tools: batched move failed; verifying and maybe falling back', err);
   }

   const after = await getContents(uri);
   if (sameOrder(after, targetUids)) return;

   console.info('Mix Tools: in-place moves did not fully apply; falling back to remove + re-add');
   await replaceInOrder(uri, ordered);
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
