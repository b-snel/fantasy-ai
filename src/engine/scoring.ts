/**
 * League-accurate fantasy scoring.
 *
 * Sleeper's stat/projection payloads and a league's `scoring_settings` share the
 * same key vocabulary (`pass_yd`, `rec`, `rec_td`, ...), so scoring is mostly a dot
 * product between the two. That is deliberate on Sleeper's part and it means we
 * never have to guess whether a league is PPR, half-PPR, or something custom — we
 * apply whatever the commissioner actually configured.
 */

import type { ScoringSettings } from "../sleeper/types.ts";

/** A raw stat or projection line, keyed the same way as scoring_settings. */
export type StatLine = Record<string, number | null | undefined>;

/**
 * Keys that appear in scoring_settings but are not per-unit stat multipliers.
 * Multiplying by these would double-count or produce nonsense.
 */
const NON_STAT_KEYS = new Set([
  "bonus_rec_te",
  "bonus_rec_rb",
  "bonus_rec_wr",
]);

/**
 * Score a stat line under a league's settings.
 *
 * `position` is only needed for position-conditional bonuses (TE premium and the
 * RB/WR equivalents), which Sleeper expresses as extra points per reception for
 * that position rather than as a separate stat.
 */
export function scoreStatLine(
  stats: StatLine,
  scoring: ScoringSettings,
  position?: string | null,
): number {
  let total = 0;

  for (const [key, multiplier] of Object.entries(scoring)) {
    if (multiplier == null || multiplier === 0) continue;
    if (NON_STAT_KEYS.has(key)) continue;
    const value = stats[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value * multiplier;
    }
  }

  // Position-conditional per-reception bonuses (TE premium and friends).
  const receptions = numeric(stats["rec"]);
  if (receptions > 0 && position) {
    const bonusKey = `bonus_rec_${position.toLowerCase()}`;
    const bonus = scoring[bonusKey];
    if (typeof bonus === "number" && bonus !== 0) total += receptions * bonus;
  }

  return round2(total);
}

const numeric = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Points per reception, the number people actually mean by "is this PPR?". */
export function pprValue(scoring: ScoringSettings): number {
  return scoring.rec ?? 0;
}

export function scoringFormatName(scoring: ScoringSettings): string {
  const ppr = pprValue(scoring);
  const base = ppr >= 1 ? "Full PPR" : ppr >= 0.5 ? "Half PPR" : ppr > 0 ? `${ppr} PPR` : "Standard";
  const tePrem = scoring.bonus_rec_te ?? 0;
  return tePrem > 0 ? `${base}, TE premium (+${tePrem}/rec)` : base;
}

/**
 * A compact, human-readable summary of the scoring rules for the model prompt.
 * Deterministic ordering matters: this text lives in the cached prefix, and a
 * reordered key would silently invalidate the cache on every request.
 */
export function describeScoring(scoring: ScoringSettings): string {
  const notable: Array<[string, string]> = [
    ["pass_yd", "pass yd"],
    ["pass_td", "pass TD"],
    ["pass_int", "INT"],
    ["rush_yd", "rush yd"],
    ["rush_td", "rush TD"],
    ["rec", "reception"],
    ["rec_yd", "rec yd"],
    ["rec_td", "rec TD"],
    ["fum_lost", "fumble lost"],
    ["bonus_rec_te", "TE bonus/rec"],
  ];

  const parts: string[] = [];
  for (const [key, label] of notable) {
    const v = scoring[key];
    if (v == null || v === 0) continue;
    parts.push(`${label} ${formatMultiplier(v)}`);
  }
  return `${scoringFormatName(scoring)} — ${parts.join(", ")}`;
}

function formatMultiplier(v: number): string {
  if (Math.abs(v) < 1 && v !== 0) {
    // Yardage values like 0.04 read better as "1 pt / 25 yd".
    const perPoint = 1 / v;
    if (Number.isInteger(Math.round(perPoint)) && Math.abs(perPoint) >= 5) {
      return `1pt/${Math.round(perPoint)}`;
    }
  }
  return v > 0 ? `+${v}` : String(v);
}
