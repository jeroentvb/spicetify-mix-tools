import { harmonicCost, type CamelotCode } from './camelot';
import { getTransitionCandidates, itemSpeed, pairKey, type TrackPair, type TransitionCandidate } from './mix';

/**
 * "Improved automix": order a mixed playlist for harmonic mixing, then give every pair a
 * transition of the preferred length (e.g. a 16-bar blend wherever Spotify rates one well
 * enough, instead of its usual 8), or Spotify's own top-ranked one in `'auto'` mode.
 *
 * The order minimises a per-pair cost: how far apart the keys are on the Camelot wheel,
 * how far the tempo jumps (a drop costs more than a rise, so the set builds), and how good
 * Spotify's backend rates the best transition between the two tracks. That last term
 * comes from the ranked candidates behind the mix editor (see `getTransitionCandidates`),
 * which also rule out pairs too far apart in tempo to beatmatch.
 */

/** Which transition length to go for; `'auto'` takes Spotify's top-ranked transition. */
export type BarPreference = 16 | 8 | 4 | 'auto';

export interface MixTrack {
   uri: string;
   /** The tempo the row plays at, speed change included, as `getTrackData` reports it. */
   bpm: number;
   camelotKey: CamelotCode;
   formatListAttributes?: unknown;
}

export interface AutomixPlan<T extends MixTrack> {
   ordered: T[];
   /** Chosen transition per consecutive pair, by `pairKey`. Absent pairs keep Spotify's own. */
   transitions: Map<string, TransitionCandidate>;
}

/** Roughly the best `computedScore` the backend hands out; scores are measured down from it. */
const SCORE_CEILING = 4;
/**
 * Lowest backend score at which a transition of the preferred length is used. Below it, the
 * pair falls back to half that length. Tuned on 16 bars: across a 25-track house playlist
 * the best 16-bar candidate per pair had a median score of 2.82, while 8-bar winners mostly
 * scored 3.3–3.8.
 */
const MIN_PREFERRED_SCORE = 3;
/**
 * Extra cost of a pair that can't take the preferred length. It's high enough that the order
 * bends towards pairs that can, at the price of the odd rougher key step.
 */
const NO_PREFERRED_LENGTH = 6;
/** Cost of a pair Spotify can only crossfade, not beatmatch. High enough to avoid unless forced. */
const NOT_BEATMATCHED = 25;
/**
 * Cost for a pair whose candidates weren't fetched, standing in for the backend's verdict.
 * Only pairs that already look poor on key and tempo go unfetched, so this is pessimistic.
 */
const UNFETCHED = 4;
/** Tempo gap past which an unfetched pair is assumed not to beatmatch. A guess. */
const MAX_BEATMATCH_RATIO = 0.08;
/**
 * Candidate pairs to fetch at most. Small playlists get every ordered pair; larger ones
 * only each track's most promising successors.
 */
const MAX_FETCHED_PAIRS = 2000;
const MIN_SUCCESSORS = 8;

const ANNEAL_RESTARTS = 6;
const START_TEMPERATURE = 5;
const END_TEMPERATURE = 0.01;

function tempoCost(from: number, to: number): number {
   const delta = to - from;
   return Math.abs(delta) * 0.35 + (delta < 0 ? -delta * 0.25 : 0);
}

function beatmatched(candidates: TransitionCandidate[]): TransitionCandidate[] {
   return candidates.filter((c) => c.overlap.isBeatmatched);
}

/** Highest score among candidates of `bars` length; ties go to the one bringing B in earliest. */
function bestOfLength(candidates: TransitionCandidate[], bars: number): TransitionCandidate | null {
   let best: TransitionCandidate | null = null;
   for (const c of candidates) {
      if (c.overlap.durationBars !== bars) continue;
      if (!best
         || c.computedScore > best.computedScore
         || (c.computedScore === best.computedScore && (c.overlap.startBMs ?? 0) < (best.overlap.startBMs ?? 0))) {
         best = c;
      }
   }
   return best;
}

/** The pair's best transition of the preferred length, if one scores well enough. */
function preferred(candidates: TransitionCandidate[], bars: number): TransitionCandidate | null {
   const best = bestOfLength(candidates, bars);
   return best && best.computedScore >= MIN_PREFERRED_SCORE ? best : null;
}

/**
 * The transition to use for a pair. In `'auto'` mode that's Spotify's top-ranked one.
 * Otherwise it's the preferred length whenever that scores well enough, else the best one
 * of half that length. Radio edits often have outros of only ~8 bars, and a 16-bar blend
 * then runs into the outgoing track's last chorus, which the backend's score reflects.
 * Returns null when nothing beatmatches, leaving Spotify's own crossfade in place.
 */
export function pickTransition(candidates: TransitionCandidate[], preference: BarPreference): TransitionCandidate | null {
   const usable = beatmatched(candidates);
   if (preference === 'auto') return usable[0] ?? null;
   return preferred(usable, preference) ?? bestOfLength(usable, preference / 2) ?? usable[0] ?? null;
}

/** The backend's view of a pair, as a cost: 0 for a top-rated transition we'd use, upwards from there. */
function transitionCost(candidates: TransitionCandidate[], preference: BarPreference): number {
   const usable = beatmatched(candidates);
   if (usable.length === 0) return NOT_BEATMATCHED;
   if (preference === 'auto') return SCORE_CEILING - usable[0].computedScore;

   const best = preferred(usable, preference);
   if (best) return SCORE_CEILING - best.computedScore;
   const fallback = bestOfLength(usable, preference / 2);
   return NO_PREFERRED_LENGTH + (fallback ? SCORE_CEILING - fallback.computedScore : 1);
}

function trackPair(a: MixTrack, b: MixTrack): TrackPair {
   return { a: a.uri, b: b.uri, speedA: itemSpeed(a), speedB: itemSpeed(b) };
}

/** Which ordered pairs to ask the backend about: each track's cheapest successors by key and tempo. */
function pairsToFetch(tracks: MixTrack[]): TrackPair[] {
   const n = tracks.length;
   const successors = Math.min(n - 1, Math.max(MIN_SUCCESSORS, Math.floor(MAX_FETCHED_PAIRS / n)));
   const pairs: TrackPair[] = [];

   tracks.forEach((a) => {
      tracks
         .filter((b) => b.uri !== a.uri)
         .map((b) => ({ b, cost: harmonicCost(a.camelotKey, b.camelotKey) + tempoCost(a.bpm, b.bpm) }))
         .sort((x, y) => x.cost - y.cost)
         .slice(0, successors)
         .forEach(({ b }) => pairs.push(trackPair(a, b)));
   });
   return pairs;
}

/** Sum of the costs of the edges at positions `edges` (edge k joins positions k and k + 1). */
function edgeSum(cost: Float64Array, n: number, at: (k: number) => number, edges: Iterable<number>): number {
   let sum = 0;
   for (const k of new Set(edges)) {
      if (k >= 0 && k < n - 1) sum += cost[at(k) * n + at(k + 1)];
   }
   return sum;
}

/**
 * Cheapest path through all tracks (an asymmetric travelling-salesman path) by simulated
 * annealing over two moves, swapping two tracks and moving one track elsewhere. Both
 * have O(1) cost deltas, so a few hundred thousand steps take well under a second.
 */
function anneal(cost: Float64Array, n: number): number[] {
   const total = (p: number[]) => edgeSum(cost, n, (k) => p[k], p.keys());
   const iterations = Math.min(500_000, Math.max(50_000, n * 4000));
   const cooling = Math.pow(END_TEMPERATURE / START_TEMPERATURE, 1 / iterations);

   let best: { order: number[]; cost: number } | null = null;

   for (let restart = 0; restart < ANNEAL_RESTARTS; restart++) {
      const p = [...Array(n).keys()].sort(() => Math.random() - 0.5);
      let current = total(p);
      let temperature = START_TEMPERATURE;

      for (let step = 0; step < iterations; step++, temperature *= cooling) {
         const i = Math.floor(Math.random() * n);
         const j = Math.floor(Math.random() * n);
         if (i === j) continue;

         const swap = Math.random() < 0.5;
         const before = (k: number) => p[k];
         let delta: number;

         if (swap) {
            const after = (k: number) => (k === i ? p[j] : k === j ? p[i] : p[k]);
            const edges = [i - 1, i, j - 1, j];
            delta = edgeSum(cost, n, after, edges) - edgeSum(cost, n, before, edges);
         } else {
            // Move the track at i so that it ends up at position j.
            const after = i < j
               ? (k: number) => (k < i || k > j ? p[k] : k === j ? p[i] : p[k + 1])
               : (k: number) => (k < j || k > i ? p[k] : k === j ? p[i] : p[k - 1]);
            const oldEdges = i < j ? [i - 1, i, j] : [j - 1, i - 1, i];
            const newEdges = i < j ? [i - 1, j - 1, j] : [j - 1, j, i];
            delta = edgeSum(cost, n, after, newEdges) - edgeSum(cost, n, before, oldEdges);
         }

         if (delta > 0 && Math.random() >= Math.exp(-delta / temperature)) continue;

         if (swap) {
            [p[i], p[j]] = [p[j], p[i]];
         } else {
            const [track] = p.splice(i, 1);
            p.splice(j, 0, track);
         }
         current += delta;
      }

      if (!best || current < best.cost) best = { order: [...p], cost: current };
   }

   return best?.order ?? [];
}

/**
 * Work out the mix order and the transition for each pair. Talks to Spotify's backend for
 * the transition candidates but changes nothing; applying the plan is up to the caller.
 */
export async function planAutomix<T extends MixTrack>(
   tracks: T[],
   preference: BarPreference,
   onProgress?: (done: number, total: number) => void,
): Promise<AutomixPlan<T>> {
   const n = tracks.length;
   if (n < 2) return { ordered: [...tracks], transitions: new Map() };

   const candidates = await getTransitionCandidates(pairsToFetch(tracks), onProgress);

   const cost = new Float64Array(n * n);
   tracks.forEach((a, i) => tracks.forEach((b, j) => {
      if (i === j) return;
      const fetched = candidates.get(pairKey(a.uri, b.uri));
      const backend = fetched
         ? transitionCost(fetched, preference)
         : UNFETCHED + (Math.abs(b.bpm - a.bpm) / Math.min(a.bpm, b.bpm) > MAX_BEATMATCH_RATIO ? NOT_BEATMATCHED : 0);
      cost[i * n + j] = harmonicCost(a.camelotKey, b.camelotKey) + tempoCost(a.bpm, b.bpm) + backend;
   }));

   const ordered = anneal(cost, n).map((i) => tracks[i]);

   // The order may use a pair we only estimated; fetch those before picking transitions.
   const consecutive = ordered.slice(0, -1).map((a, i) => trackPair(a, ordered[i + 1]));
   const missing = consecutive.filter(({ a, b }) => !candidates.has(pairKey(a, b)));
   if (missing.length > 0) {
      (await getTransitionCandidates(missing)).forEach((value, key) => candidates.set(key, value));
   }

   const transitions = new Map<string, TransitionCandidate>();
   for (const { a, b } of consecutive) {
      const picked = pickTransition(candidates.get(pairKey(a, b)) ?? [], preference);
      if (picked) transitions.set(pairKey(a, b), picked);
   }

   return { ordered, transitions };
}
