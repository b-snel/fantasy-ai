/**
 * Finding average draft position in Sleeper's projection payload.
 *
 * This is fiddly enough to be worth its own file, because ADP is load-bearing: the
 * survival model, VONA, and the "is he falling to me?" number all derive from it,
 * and when it is missing every player's survival collapses to a flat 0.5 and VONA
 * stops meaning anything. The failure is silent - the board still renders, it just
 * quietly stops answering the most decision-relevant question.
 *
 * The live payload does not use the key names the obvious guess would suggest. A
 * real 2026 response carries `adp_dd_ppr` and `pos_adp_dd_ppr` inside `stats`, not
 * an `adp_ppr` at the top level. Two consequences drive the design here:
 *
 *   - Match on shape, not on an exact key list. Sleeper is free to rename these and
 *     has no contract with us; a hardcoded list breaks silently the next time.
 *   - `pos_*` keys are POSITIONAL ADP ("the 5th running back"), on a completely
 *     different scale from overall ADP. Feeding one to the survival model would
 *     claim every position's fifth-best player goes off the board at pick five.
 *     Excluding them is not tidiness, it is correctness.
 */

import type { ScoringSettings } from "../sleeper/types.ts";

export type AdpFormat = "ppr" | "half_ppr" | "std" | "unknown";

/** Which scoring format an ADP key refers to, judged from its name. */
export function adpFormatOf(key: string): AdpFormat {
  const k = key.toLowerCase();
  // Check half_ppr first: "adp_dd_half_ppr" also contains "ppr".
  if (k.includes("half_ppr") || k.includes("half")) return "half_ppr";
  if (k.includes("ppr")) return "ppr";
  if (k.includes("std") || k.includes("standard")) return "std";
  return "unknown";
}

/** Formats to prefer, best first, for a league with this scoring. */
export function formatPreference(scoring: ScoringSettings): AdpFormat[] {
  const ppr = scoring.rec ?? 0;
  if (ppr >= 1) return ["ppr", "half_ppr", "std", "unknown"];
  if (ppr > 0) return ["half_ppr", "ppr", "std", "unknown"];
  return ["std", "half_ppr", "ppr", "unknown"];
}

/**
 * Keys that name an ADP for a different game than the one being drafted. A redraft
 * league must not be ranked off dynasty or superflex ADP - those orderings are
 * genuinely different, not just noisier.
 */
const WRONG_GAME = ["dynasty", "rookie", "2qb", "superflex", "bestball", "best_ball"];

/** Is this key an overall-ADP field we can actually use? */
export function isUsableAdpKey(key: string): boolean {
  const k = key.toLowerCase();
  if (!k.includes("adp")) return false;
  // Positional ADP lives on a different scale entirely.
  if (k.startsWith("pos_") || k.includes("pos_adp")) return false;
  return !WRONG_GAME.some((bad) => k.includes(bad));
}

/**
 * Pull the best available overall ADP out of a projection row.
 *
 * Searches the row and its `stats` sub-object, keeps only usable overall-ADP keys,
 * and picks the one whose format best matches the league.
 */
export function extractAdp(
  row: Record<string, unknown>,
  scoring: ScoringSettings,
): { value: number; key: string } | null {
  const sources: Array<Record<string, unknown>> = [row];
  const stats = row.stats;
  if (stats && typeof stats === "object") sources.push(stats as Record<string, unknown>);

  const candidates = new Map<string, number>();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
      if (!isUsableAdpKey(key)) continue;
      // Deterministic on duplicates: first source wins, so row beats stats.
      if (!candidates.has(key)) candidates.set(key, value);
    }
  }
  if (candidates.size === 0) return null;

  for (const format of formatPreference(scoring)) {
    // Sort by key name so a tie between two same-format keys resolves the same way
    // on every run - this feeds the cached prompt, which must be byte-stable.
    const matches = [...candidates.entries()]
      .filter(([key]) => adpFormatOf(key) === format)
      .sort(([a], [b]) => a.localeCompare(b));
    const first = matches[0];
    if (first) return { value: first[1], key: first[0] };
  }
  return null;
}

export interface AdpSanity {
  ok: boolean;
  count: number;
  min: number;
  max: number;
  warning: string | null;
}

/**
 * Does this ADP distribution look like overall draft position?
 *
 * A silent scale error is the dangerous outcome: positional ADP would produce a
 * plausible-looking board whose survival numbers are nonsense, with no error
 * anywhere. So it is worth checking that the numbers mean what we think.
 *
 * Range is a poor test - positional ADP for receivers runs past 100, well into
 * legitimate overall territory. Density is the real tell. Overall ADP assigns each
 * pick number to roughly one player, so about `teams` players fall in the first
 * round. Positional ADP restarts the count for every position, so the same span
 * holds `teams` players *per position* - six times too many, and obvious.
 */
export function checkAdpSanity(values: number[], teams = 12): AdpSanity {
  const usable = values.filter((v) => Number.isFinite(v) && v > 0);
  if (usable.length === 0) {
    return { ok: false, count: 0, min: 0, max: 0, warning: "no ADP values at all" };
  }

  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const base = { count: usable.length, min, max };

  if (min > 3) {
    return {
      ...base,
      ok: false,
      warning: `lowest ADP is ${min.toFixed(1)}; overall ADP should start near 1`,
    };
  }

  if (max < teams) {
    return {
      ...base,
      ok: false,
      warning: `highest ADP is only ${max.toFixed(1)}, under a single round`,
    };
  }

  // Only meaningful once the pool is big enough for density to say anything.
  const firstRound = usable.filter((v) => v <= teams).length;
  if (usable.length >= teams * 4 && firstRound > teams * 2.5) {
    return {
      ...base,
      ok: false,
      warning:
        `${firstRound} players share the first ${teams} ADP slots - overall ADP ` +
        `would have about ${teams}, so this looks like positional ADP`,
    };
  }

  return { ...base, ok: true, warning: null };
}
