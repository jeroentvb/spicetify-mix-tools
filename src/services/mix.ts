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
 *
 * Behind `getAutoTransitionForTrackPair` sits a backend RPC that returns a whole ranked list
 * of candidates per pair (see `getTransitionCandidates`), which the improved automix uses
 * to choose its own transitions. TECHNICAL.md has the details.
 */

interface Overlap {
   startAMs?: number;
   startBMs?: number;
   durationMs?: number;
}

interface Transition {
   overlap?: Overlap;
   preset?: Preset;
}

/** A transition style (EQ / filter / volume curves), by Spotify's numeric id. */
interface Preset {
   id?: number;
   type?: number;
}

/** One of the backend's ranked transitions for a track pair. */
export interface TransitionCandidate {
   overlap: Overlap & { durationBars?: number; isBeatmatched?: boolean };
   computedScore: number;
   /** Best first. Every preset fits the overlap; the top one is what Spotify would pick. */
   rankedPresets?: { preset?: Preset; computedScore?: number }[];
}

export interface TrackPair {
   a: string;
   b: string;
   /** Playback speeds of the two rows (see `itemSpeed`); 1 when omitted. */
   speedA?: number;
   speedB?: number;
}

/**
 * A row's playback speed. The mobile app can speed a track up or down per row, stored as
 * the `item.speed` format-list attribute (e.g. `'1.01562'`). Spotify only accepts a stored
 * transition whose `itemSpeedA` / `itemSpeedB` match the rows' speeds.
 */
export function itemSpeed(item: object): number {
   const attributes = (item as { formatListAttributes?: Record<string, string> }).formatListAttributes;
   const raw = attributes?.['item.speed'];
   const speed = raw === undefined ? NaN : parseFloat(raw);
   return Number.isFinite(speed) && speed > 0 ? speed : 1;
}

/** Track pairs per `GetComputedTransitions` request. */
const CANDIDATE_BATCH = 40;

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
   a: PlaylistItem,
   b: PlaylistItem,
): Promise<{ overlap: Overlap | null; custom: boolean }> {
   const api = Spicetify.Platform.PlaylistMixingAPI;
   // Without B's speed the client assumes 1 and ignores a transition into a sped-up row.
   const speeds = { itemSpeedA: itemSpeed(a), itemSpeedB: itemSpeed(b) };
   const custom: Transition | null = await api
      .getCustomTransitionForTrackPair(playlistUri, a.uri, b.uri, { trackAUid: a.uid, ...speeds })
      .catch(() => null);
   if (custom?.overlap) return { overlap: custom.overlap, custom: true };

   const auto: Transition | null = await api.getAutoTransitionForTrackPair(a.uri, b.uri, speeds).catch(() => null);
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

export function pairKey(a: string, b: string): string {
   return `${a}>${b}`;
}

/**
 * Spotify's ranked transition candidates for each track pair, keyed by `pairKey`, best first.
 * A pair whose tempos are too far apart to beatmatch gets a single non-beatmatched crossfade.
 */
export async function getTransitionCandidates(
   pairs: TrackPair[],
   onProgress?: (done: number, total: number) => void,
): Promise<Map<string, TransitionCandidate[]>> {
   const client = Spicetify.Platform.PlaylistMixingAPI._automixClient;
   const result = new Map<string, TransitionCandidate[]>();

   let done = 0;
   for (const batch of chunk(pairs, CANDIDATE_BATCH)) {
      const response = await client.getComputedTransitions({
         trackPairs: batch.map(({ a, b, speedA, speedB }) => ({
            trackAUri: a,
            trackBUri: b,
            itemSpeedA: speedA ?? 1,
            itemSpeedB: speedB ?? 1,
         })),
      });
      batch.forEach(({ a, b }, i) => {
         result.set(pairKey(a, b), response?.computedTransitions?.[i]?.rankedTransitions ?? []);
      });
      done += batch.length;
      onProgress?.(done, pairs.length);
   }
   return result;
}

/**
 * Store `candidate` as the hand-edited transition from row A into row B, the way the
 * client's own transition editor saves one: Spotify's automatic transition with the
 * overlap and preset overridden, stored on track A's row.
 */
export async function saveCustomTransition(
   playlistUri: string,
   a: { uri: string; uid: string; formatListAttributes?: unknown },
   b: { uri: string; uid: string; formatListAttributes?: unknown },
   candidate: TransitionCandidate,
): Promise<void> {
   const api = Spicetify.Platform.PlaylistMixingAPI;
   const speeds = { itemSpeedA: itemSpeed(a), itemSpeedB: itemSpeed(b) };
   const auto: Transition | null = await api.getAutoTransitionForTrackPair(a.uri, b.uri, speeds).catch(() => null);
   const stored: Transition | null = await api
      .getCustomTransitionForTrackPair(playlistUri, a.uri, b.uri, { trackAUid: a.uid, ...speeds })
      .catch(() => null);

   const transition = {
      ...auto,
      preset: candidate.rankedPresets?.[0]?.preset ?? auto?.preset,
      overlap: {
         ...auto?.overlap,
         ...candidate.overlap,
         trackARowId: a.uid,
         trackBRowId: b.uid,
         // The raw candidates report 0 (unset); the client's own transitions carry the rows' speeds.
         ...speeds,
      },
      isOverlapOverride: true,
      isPresetIdOverride: true,
   };

   // The editor passes what it replaces, presumably for undo/analytics; mirror it.
   const previousTransition = stored?.overlap
      ? { type: 'userDefined', transition: stored }
      : auto ? { type: 'auto', transition: auto } : undefined;

   await api.setTransitionForTrack(playlistUri, a.uid, transition, { previousTransition });
}

/**
 * Drop a hand-edited transition from row A into row B, so the pair goes back to Spotify's
 * automatic one. Returns whether there was one to drop.
 */
export async function resetCustomTransition(
   playlistUri: string,
   a: { uri: string; uid: string; formatListAttributes?: unknown },
   b: { uri: string; formatListAttributes?: unknown },
): Promise<boolean> {
   const api = Spicetify.Platform.PlaylistMixingAPI;
   const stored: Transition | null = await api
      .getCustomTransitionForTrackPair(playlistUri, a.uri, b.uri, {
         trackAUid: a.uid,
         itemSpeedA: itemSpeed(a),
         itemSpeedB: itemSpeed(b),
      })
      .catch(() => null);
   if (!stored?.overlap) return false;

   // The editor's "auto" mode saves exactly this: no transition at all.
   await api.setTransitionForTrack(playlistUri, a.uid, undefined);
   return true;
}
