/**
 * Fetches the per-track values Spotify shows in a playlist's BPM and Key columns (the ones
 * its mix/automix feature uses), straight from the client's metadata service:
 *
 * - `bpm` — the octave-corrected tempo, deliberately not the raw `audio-features` value,
 *   which is half/double-off for many tracks.
 * - `key.camelotKey.value` — a ready-made Camelot code such as `'9B'`.
 *
 * Both come from the `AUDIO_ATTRIBUTES_V2` metadata extension, the same data the columns
 * render. Fetching it directly needs no scrolling, works whether or not the columns are
 * shown, and doesn't depend on the tracklist's DOM.
 */

import { chunk } from '../utils/chunk';
import { asCamelotCode, type CamelotCode } from './camelot';
import { itemSpeed } from './mix';
import type { PlaylistItem } from './playlist';

/** `ExtensionKind.AUDIO_ATTRIBUTES_V2` in the client's metadata protobufs. */
const AUDIO_ATTRIBUTES_V2 = 222;

/** Tracks per metadata request. */
const BATCH = 100;

/** What we know about one track. Either field is null when Spotify has no value for it. */
export interface TrackData {
   bpm: number | null;
   camelotKey: CamelotCode | null;
}

/** The decoded extension, as the client hands it back. Narrow before use. */
interface AudioAttributes {
   bpm?: unknown;
   key?: { camelotKey?: { value?: unknown } };
}

interface MetadataExtensionsAPI {
   /** Takes `[uri, ...extensionKinds]` tuples; resolves to `{ [uri]: { [kind]: data | null } }`. */
   fetch(...requests: [string, ...number[]][]): Promise<Record<string, Record<number, unknown>>>;
}

/**
 * The client's metadata-extensions service. Several Platform APIs hold the same instance;
 * these are tried in order, so one disappearing in a client update isn't fatal.
 */
function getMetadataExtensionsAPI(): MetadataExtensionsAPI {
   const platform = Spicetify.Platform;
   const api = platform.PlaylistAPI?._metadataExtensionsAPI
      ?? platform.RecentsAPI?.metadataExtensionsAPI
      ?? platform.PlaylistMixingAPI?._metadataExtensionsAPI;
   if (typeof api?.fetch !== 'function') throw new Error('No metadata extensions API found');
   return api;
}

/**
 * BPM and Camelot key for every track in `items`, keyed by track uri. Tracks Spotify has no
 * attributes for (local files, podcasts, unanalyzed tracks) are absent from the map.
 *
 * The BPM is the one the BPM column shows: the track's tempo times its row's speed, rounded.
 * @param onProgress optional callback (done, total)
 */
export async function getTrackData(
   items: PlaylistItem[],
   onProgress?: (done: number, total: number) => void,
): Promise<Map<string, TrackData>> {
   const api = getMetadataExtensionsAPI();
   const uris = [...new Set(items.map((item) => item.uri).filter((uri) => uri.startsWith('spotify:track:')))];
   const attributes = new Map<string, AudioAttributes>();

   let done = 0;
   for (const batch of chunk(uris, BATCH)) {
      const response = await api.fetch(...batch.map((uri): [string, number] => [uri, AUDIO_ATTRIBUTES_V2]));
      for (const uri of batch) {
         const data = response?.[uri]?.[AUDIO_ATTRIBUTES_V2];
         if (data && typeof data === 'object') attributes.set(uri, data as AudioAttributes);
      }
      done += batch.length;
      onProgress?.(done, uris.length);
   }

   const map = new Map<string, TrackData>();
   for (const item of items) {
      const data = attributes.get(item.uri);
      if (!data || map.has(item.uri)) continue;

      const bpm = typeof data.bpm === 'number' && Number.isFinite(data.bpm) && data.bpm > 0
         ? Math.round(data.bpm * itemSpeed(item))
         : null;
      const camelotKey = asCamelotCode(data.key?.camelotKey?.value);
      if (bpm !== null || camelotKey !== null) map.set(item.uri, { bpm, camelotKey });
   }
   return map;
}
