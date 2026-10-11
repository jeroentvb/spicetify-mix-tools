import { chunk } from '../utils/chunk';
import { getContents, type PlaylistItem } from './playlist';

/**
 * Mixed-playtime calculation for playlists with Spotify's "mix" (automix) mode on.
 *
 * Everything here leans on `Spicetify.Platform.PlaylistMixingAPI`, which is undocumented
 * and version-fragile. Reverse-engineered shape (client 1.3.4):
 * - A playlist is mixed when `getMetadata().formatListData.attributes.mix === 'true'`.
 * - `getCustomTransitionForTrackPair(playlistUri, uriA, uriB, { trackAUid })` returns the
 *   hand-edited transition from track A into B, or null. Spotify stores it on track A's row
 *   as the (misleadingly named) `automix.auto_transition_recipe` format-list attribute.
 * - `getAutoTransitionForTrackPair(uriA, uriB)` returns Spotify's own suggestion.
 * Both resolve to `{ overlap: { startAMs, startBMs, durationMs, … } }`: track A starts fading
 * at `startAMs`, track B comes in at `startBMs`, and the two overlap for `durationMs`.
 * Protobuf defaults are omitted, so a missing `startBMs` means 0.
 */

interface Overlap {
   startAMs?: number;
   startBMs?: number;
   durationMs?: number;
}

interface Transition {
   overlap?: Overlap;
}

export interface MixStats {
   /** Sum of full track lengths: what Spotify shows in the header. */
   rawMs: number;
   /** Length of the playlist when played with its transitions. */
   mixedMs: number;
   /** Track starts cut because the next track comes in partway through. */
   introsSkippedMs: number;
   /** Track ends cut because the transition finishes before the track does. */
   outrosSkippedMs: number;
   /** Time two tracks play at once during transitions. */
   overlapMs: number;
   /** Transitions between consecutive tracks. */
   transitions: number;
   /** Of those, how many were hand-edited (the rest use Spotify's automatic one). */
   customTransitions: number;
}

/** Concurrent transition lookups; each custom lookup reads a playlist row. */
const LOOKUP_BATCH = 20;

/** Whether the playlist has Spotify's mix mode on. */
export async function isMixEnabled(uri: string): Promise<boolean> {
   try {
      const meta = await Spicetify.Platform.PlaylistAPI.getMetadata(uri);
      return meta?.formatListData?.attributes?.mix === 'true';
   } catch {
      return false;
   }
}

function durationOf(item: PlaylistItem): number {
   const duration = item.duration as { milliseconds?: number } | number | undefined;
   return (typeof duration === 'number' ? duration : duration?.milliseconds) ?? 0;
}

async function lookupTransition(
   playlistUri: string,
   a: { uri: string; uid: string },
   b: { uri: string },
): Promise<{ overlap: Overlap | null; custom: boolean }> {
   const api = Spicetify.Platform.PlaylistMixingAPI;
   const custom: Transition | null = await api
      .getCustomTransitionForTrackPair(playlistUri, a.uri, b.uri, { trackAUid: a.uid })
      .catch(() => null);
   if (custom?.overlap) return { overlap: custom.overlap, custom: true };

   const auto: Transition | null = await api.getAutoTransitionForTrackPair(a.uri, b.uri).catch(() => null);
   return { overlap: auto?.overlap ?? null, custom: false };
}

/**
 * Walk the playlist as it would play mixed. Track i is heard from where it came in
 * (the previous transition's `startBMs`) until it starts handing over (`startAMs`);
 * the last track plays to its end. A pair with no transition at all (e.g. a local
 * file) is treated as back to back.
 */
export async function getMixStats(uri: string): Promise<MixStats> {
   const items = await getContents(uri);
   const pairs = items.slice(0, -1).map((a, i) => ({ a, b: items[i + 1] }));

   const lookups: Awaited<ReturnType<typeof lookupTransition>>[] = [];
   for (const batch of chunk(pairs, LOOKUP_BATCH)) {
      lookups.push(...await Promise.all(batch.map(({ a, b }) => lookupTransition(uri, a, b))));
   }

   const stats: MixStats = {
      rawMs: 0,
      mixedMs: 0,
      introsSkippedMs: 0,
      outrosSkippedMs: 0,
      overlapMs: 0,
      transitions: lookups.length,
      customTransitions: lookups.filter((l) => l.custom).length,
   };

   let entry = 0;
   items.forEach((item, i) => {
      const length = durationOf(item);
      const overlap = lookups[i]?.overlap;
      // The last track, or one with no usable transition, plays out in full.
      const exit = overlap?.startAMs ?? length;
      const fade = overlap ? overlap.durationMs ?? 0 : 0;

      stats.rawMs += length;
      stats.mixedMs += exit - entry;
      stats.introsSkippedMs += entry;
      stats.outrosSkippedMs += length - exit - fade;
      stats.overlapMs += fade;

      entry = overlap?.startBMs ?? 0;
   });

   return stats;
}
