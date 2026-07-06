import { setButtonBusy } from '../components/bpm-button';
import { harvestColumnBpm } from './bpm-column';
import { getCurrentPlaylistUri } from './current-uri';
import {
   canModify,
   createSortedPlaylist,
   getContents,
   getPlaylistName,
   reorderInPlace,
   sortByBpm,
   type SortDirection,
} from './playlist';

const DIRECTION: SortDirection = 'asc';

function notify(message: string, isError = false): void {
   Spicetify.showNotification(message, isError);
}

/** Shared front half: resolve playlist, load tracks, fetch BPM, sort. */
async function prepare(uri: string) {
   const items = await getContents(uri);
   if (items.length === 0) {
      notify('Sort BPM: this playlist is empty', true);
      return null;
   }

   notify(`Sort BPM: reading BPM for ${items.length} tracks…`);
   setButtonBusy('0%');
   const bpmMap = await harvestColumnBpm(items.length, (found, total) => {
      setButtonBusy(`${Math.min(99, Math.round((found / total) * 100))}%`);
   });
   const result = sortByBpm(items, bpmMap, DIRECTION);

   if (result.sortedCount === 0) {
      notify('Sort BPM: no BPM found — is the BPM column visible on this playlist?', true);
      return null;
   }

   // Support the devtools correctness check (see README verification step).
   console.table(
      result.ordered
         .filter((item) => typeof item.bpm === 'number')
         .map((item) => ({ name: item.name ?? item.uri, bpm: item.bpm })),
   );

   return { items, result };
}

function summary(sortedCount: number, skipped: number): string {
   const base = `Sorted ${sortedCount} tracks by BPM`;
   return skipped > 0 ? `${base} · ${skipped} without BPM moved to end` : base;
}

/** Sort by BPM by reordering the current playlist in place. */
export async function sortReorder(): Promise<void> {
   const uri = getCurrentPlaylistUri();
   if (!uri) return notify('Sort BPM: open a playlist first', true);

   if (!(await canModify(uri))) {
      return notify('Sort BPM: you can only reorder playlists you own', true);
   }

   try {
      const prepared = await prepare(uri);
      if (!prepared) return;

      await reorderInPlace(uri, prepared.result.ordered, (done, total) => {
         setButtonBusy(`${Math.round((done / total) * 100)}%`);
      });
      notify(`Sort BPM: ${summary(prepared.result.sortedCount, prepared.result.skipped.length)}`);
   } catch (err) {
      console.error('Sort BPM reorder failed:', err);
      notify('Sort BPM: failed to reorder playlist (see console)', true);
   } finally {
      setButtonBusy(null);
   }
}

/** Sort by BPM into a brand new playlist, leaving the original untouched. */
export async function sortToNewPlaylist(): Promise<void> {
   const uri = getCurrentPlaylistUri();
   if (!uri) return notify('Sort BPM: open a playlist first', true);

   try {
      const prepared = await prepare(uri);
      if (!prepared) return;

      const name = `${await getPlaylistName(uri)} (BPM)`;
      const newUri = await createSortedPlaylist(uri, prepared.result.ordered, name);

      notify(`Sort BPM: created "${name}" · ${summary(prepared.result.sortedCount, prepared.result.skipped.length)}`);
      Spicetify.Platform.History.push(`/playlist/${newUri.split(':').pop()}`);
   } catch (err) {
      console.error('Sort BPM new-playlist failed:', err);
      notify('Sort BPM: failed to create sorted playlist (see console)', true);
   } finally {
      setButtonBusy(null);
   }
}
