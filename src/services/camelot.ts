/**
 * Camelot wheel helpers.
 *
 * Spotify already computes the Camelot code for every analyzed track and hangs it off
 * the tracklist row's React props as `item.key.camelotKey` (e.g. `'9B'`), so there is no
 * key/pitch-class conversion to do here — this module only defines the sort order.
 */

/**
 * Every Camelot code in sort order: number first, then letter (1A, 1B, 2A, … 12B).
 * A track's sort rank is simply its index here.
 *
 * Relative minor/major pairs share a number (8A = A minor, 8B = C major), so this
 * ordering puts them next to each other and consecutive tracks in a sorted playlist are
 * almost always harmonically compatible.
 */
export const CAMELOT_ORDER = [
   '1A', '1B', '2A', '2B', '3A', '3B', '4A', '4B', '5A', '5B', '6A', '6B',
   '7A', '7B', '8A', '8B', '9A', '9B', '10A', '10B', '11A', '11B', '12A', '12B',
] as const;

export type CamelotCode = typeof CAMELOT_ORDER[number];

const RANKS = new Map<string, number>(CAMELOT_ORDER.map((code, index) => [code, index]));

/**
 * Narrow an arbitrary value to a Camelot code, tolerating case and surrounding
 * whitespace. Returns null for anything that isn't one of the 24 codes — including the
 * `undefined` we get for a track Spotify hasn't analyzed.
 */
export function asCamelotCode(value: unknown): CamelotCode | null {
   if (typeof value !== 'string') return null;
   const code = value.trim().toUpperCase();
   return RANKS.has(code) ? (code as CamelotCode) : null;
}

/** Sort rank of a Camelot code: 0 for 1A up to 23 for 12B. */
export function camelotRank(code: CamelotCode): number {
   // Every CamelotCode is in RANKS by construction; the fallback just keeps this total.
   return RANKS.get(code) ?? 0;
}

function parseCamelot(code: CamelotCode): { number: number; letter: string } {
   return { number: parseInt(code, 10), letter: code.slice(-1) };
}

/**
 * How rough a mix from one key into the next sounds: 0 for the same key, rising as the
 * keys get further apart on the wheel. Unlike the sort order this is directional, since a
 * +2 step ("energy boost") is a classic DJ move and a -2 step isn't.
 */
export function harmonicCost(from: CamelotCode, to: CamelotCode): number {
   const a = parseCamelot(from);
   const b = parseCamelot(to);
   const up = (b.number - a.number + 12) % 12;
   const steps = Math.min(up, 12 - up);

   if (a.letter === b.letter) {
      if (steps === 0) return 0;
      if (steps === 1) return 1;
      if (up === 2) return 3;
      if (steps === 2) return 4;
      return 5 + steps;
   }
   if (steps === 0) return 1.5; // relative major/minor (8A ↔ 8B)
   if (steps === 1) return 3.5; // diagonal (8A → 9B)
   return 6 + steps;
}
