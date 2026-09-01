/**
 * The board: turns projections, ADP, roster state and draft position into a ranked
 * shortlist.
 *
 * Everything here is deterministic and unit-tested. The model downstream never sees
 * the player pool — it sees the handful of candidates this file selects, already
 * scored. That division is what keeps token cost near zero and, more importantly,
 * keeps the arithmetic reproducible instead of hallucinated.
 */

import { config } from "../config.ts";
import { isFantasyPosition, type FantasyPosition } from "../sleeper/types.ts";
import { assignTiers, tierCounts, type TierAssignment } from "./tiers.ts";
import type { RosterState } from "./roster.ts";
import type { RosterRequirements } from "./replacement.ts";

export interface RankablePlayer {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  byeWeek: number | null;
  /** Projected season fantasy points under this league's scoring. */
  projectedPoints: number;
  /** Average draft position. Lower = drafted earlier. */
  adp: number | null;
  injuryStatus: string | null;
  practiceParticipation: string | null;
  age: number | null;
  yearsExp: number | null;
  depthChartOrder: number | null;
  /** Sleeper adds over the last 24h — a cheap proxy for late-breaking buzz. */
  trendingAdds: number;
  /** Short news blurb from the pre-draft sweep, if any. */
  newsNote?: string | null;
}

export interface ScoredPlayer extends RankablePlayer {
  vorp: number;
  tier: number;
  /** Points between this player and the next one down at the position. */
  cliffBelow: number;
  /** How many players are left in this player's position+tier. */
  tierRemaining: number;
  /** P(still available at your next pick), 0-1. */
  survival: number;
  /** Value over the player you'd expect at this position at your following pick. */
  vona: number;
  /** ADP minus the current pick. Positive = falling to you; negative = a reach. */
  adpDelta: number | null;
  /** Final blended ranking score, in points-equivalent units. */
  score: number;
  /** Component breakdown, for the UI and for explaining the pick. */
  components: ScoreComponents;
  /** Why this player is on the shortlist. */
  reason: ShortlistReason;
  /** 0-1 multiplier applied to value terms because the position is already covered. */
  saturation: number;
}

export interface ScoreComponents {
  vorp: number;
  vona: number;
  need: number;
  tierBreak: number;
  injury: number;
  byeConflict: number;
  stack: number;
  trending: number;
}

export type ShortlistReason = "value" | "best_available" | "upside" | "need";

export interface BoardContext {
  currentPick: number;
  /** The pick you are being advised for. */
  myNextPick: number | null;
  /** The pick after that — the horizon VONA measures against. */
  myPickAfterNext: number | null;
  roster: RosterState;
  replacementPoints: Record<string, number>;
  picksRemaining: number;
  /** Needed to know when a position is already full. Optional for unit tests. */
  requirements?: RosterRequirements;
}

/** Which positions each flex kind can absorb. Mirrors replacement.ts. */
const FLEX_ELIGIBILITY: Record<string, string[]> = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};

/** Positions that are streamable off waivers all season. */
const STREAMABLE = new Set(["K", "DEF"]);

/**
 * Points-equivalent value of fully satisfying a positional need. Roughly what a
 * startable player produces, because that is what an empty slot costs you.
 */
const NEED_POINT_SCALE = 120;

/**
 * Convert raw VORP into a value term that behaves sensibly below replacement.
 *
 * VORP goes negative for everyone outside the starting pool, which is arithmetically
 * true and strategically useless: a bench receiver is not worth *minus* thirty
 * points, he is worth a small positive amount as a lottery ticket and bye-week
 * cover. Scoring him negative makes a second kicker - tiny but positive VORP - look
 * like the better pick in round twelve, which it never is.
 *
 * Softplus keeps the identity for real starters (a +100 VORP player still scores
 * ~100) while compressing everything below replacement into a small positive band
 * that preserves ordering.
 */
export function valueTerm(vorp: number, scale = 25): number {
  const z = vorp / scale;
  // log1p(exp(z)) computed stably for large z.
  const softplus = z > 30 ? z : Math.log1p(Math.exp(z));
  return scale * softplus;
}

/**
 * How much of a player's raw value actually accrues to *this* roster right now.
 *
 * VORP measures a player against the league's replacement level, which is the right
 * question when you need one and the wrong question once you have one. Two distinct
 * corrections live here, and the engine drafts badly without either.
 *
 * **Saturation.** The eleventh-round quarterback in a one-quarterback league has a
 * genuinely high VORP and almost no marginal value to a team that already started a
 * quarterback in round three. Left uncorrected the blend keeps taking backups,
 * because in isolation each of them really is the best player left.
 *
 * **Streaming.** Kickers and defenses are the sharper version of the same problem.
 * Their VORP is real - the twelfth kicker does score fewer points than the fourth -
 * but it is not worth a draft pick, because the spread is small, next to
 * unpredictable year over year, and the position is replaceable off waivers every
 * single week. Ranking them on VORP alone hands you a kicker in round ten while
 * startable flex players are still on the board. Every competent drafter waits, and
 * so should this.
 */
export function marginalValueMultiplier(
  position: string,
  roster: RosterState,
  requirements: RosterRequirements | undefined,
  picksRemaining: number,
): number {
  if (!requirements) return 1;
  if (!isFantasyPosition(position)) return 1;

  const owned = roster.countsByPosition[position as FantasyPosition] ?? 0;
  const required = requirements.starters[position] ?? 0;

  let flexCapacity = 0;
  for (const [kind, count] of Object.entries(requirements.flex)) {
    if ((FLEX_ELIGIBILITY[kind] ?? []).includes(position)) flexCapacity += count;
  }

  if (STREAMABLE.has(position)) {
    // Already covered: a second kicker is never the pick.
    if (owned >= required) return 0.02;
    // The endgame is exactly when you take the one you need.
    if (picksRemaining <= 2) return 1;
    // Suppressed, but not to zero - the relative order among kickers is preserved,
    // so when the endgame arrives the best one is still on top.
    return 0.05;
  }

  // Still filling a dedicated starting slot: full value.
  if (owned < required) return 1;
  // Could still win a flex slot: nearly full value.
  if (owned < required + flexCapacity) return 0.9;
  // First true backup: real insurance value, especially across bye weeks.
  if (owned < required + flexCapacity + 1) return 0.45;
  // Second backup at a position already covered twice over.
  if (owned < required + flexCapacity + 2) return 0.2;
  // Roster clog.
  return 0.08;
}

/**
 * P(a player with this ADP is still on the board at `targetPick`).
 *
 * ADP is a mean, and the spread around it grows later in the draft — early picks
 * are highly predictable, round-10 picks much less so. A logistic curve over
 * (targetPick - adp) captures that well enough and, unlike a normal CDF, needs no
 * special-function approximation.
 */
export function survivalProbability(adp: number | null, targetPick: number): number {
  if (adp == null || !Number.isFinite(adp)) return 0.5; // unknown ADP: no information
  // Spread widens with ADP; floor keeps early rounds from becoming step functions.
  const sigma = Math.max(3.5, adp * 0.22);
  const z = (targetPick - adp) / sigma;
  // Logistic CDF of being *taken* by targetPick; survival is its complement.
  const takenProb = 1 / (1 + Math.exp(-z * 1.7));
  return clamp01(1 - takenProb);
}

/**
 * Expected VORP of the best player still available at a position at `targetPick`.
 *
 * Walks the position's players best-first: each contributes its value weighted by
 * the chance it survives *and* that everyone better is gone.
 */
export function expectedBestAtPick(
  positionPlayers: Array<{ vorp: number; adp: number | null }>,
  targetPick: number,
): number {
  let expected = 0;
  let allBetterGone = 1;
  for (const p of positionPlayers) {
    const survives = survivalProbability(p.adp, targetPick);
    expected += p.vorp * survives * allBetterGone;
    allBetterGone *= 1 - survives;
    if (allBetterGone < 1e-4) break; // remaining terms cannot move the total
  }
  return round2(expected);
}

/** Score and rank every available player. Returns the full board, best first. */
export function scoreBoard(available: RankablePlayer[], ctx: BoardContext): ScoredPlayer[] {
  const w = config.engine.weights;

  const tiers = assignTiers(
    available.map((p) => ({ playerId: p.playerId, position: p.position, points: p.projectedPoints })),
    config.engine.tierGapPoints,
    config.engine.defaultTierGap,
  );
  const remainingInTier = tierCounts(
    available.map((p) => ({ playerId: p.playerId, position: p.position, points: p.projectedPoints })),
    tiers,
  );

  // VORP first — VONA needs it.
  const withVorp = available.map((p) => ({
    player: p,
    vorp: round2(p.projectedPoints - (ctx.replacementPoints[p.position] ?? 0)),
  }));

  // Per-position pools, best first, for the VONA horizon calculation.
  const byPosition = new Map<string, Array<{ vorp: number; adp: number | null }>>();
  for (const { player, vorp } of withVorp) {
    const list = byPosition.get(player.position) ?? [];
    list.push({ vorp, adp: player.adp });
    byPosition.set(player.position, list);
  }
  for (const list of byPosition.values()) list.sort((a, b) => b.vorp - a.vorp);

  const horizon = ctx.myPickAfterNext;
  const expectedAtHorizon = new Map<string, number>();
  if (horizon != null) {
    for (const [pos, list] of byPosition) {
      expectedAtHorizon.set(pos, expectedBestAtPick(list, horizon));
    }
  }

  const survivalTarget = ctx.myNextPick ?? ctx.currentPick;

  const scored: ScoredPlayer[] = withVorp.map(({ player, vorp }) => {
    const tierInfo: TierAssignment = tiers.get(player.playerId) ?? { tier: 1, cliffBelow: 0 };
    const tierRemaining = remainingInTier.get(`${player.position}:${tierInfo.tier}`) ?? 1;
    const survival = survivalProbability(player.adp, survivalTarget);
    const vona = horizon != null ? round2(vorp - (expectedAtHorizon.get(player.position) ?? 0)) : 0;

    const need = isFantasyPosition(player.position)
      ? ctx.roster.needs[player.position as FantasyPosition]?.urgency ?? 0
      : 0;

    // Scales the value terms only. Injury, bye and stack adjustments are absolute
    // and should not shrink just because a position is covered.
    const saturation = marginalValueMultiplier(
      player.position,
      ctx.roster,
      ctx.requirements,
      ctx.picksRemaining,
    );

    const components: ScoreComponents = {
      vorp: valueTerm(vorp) * w.vorp * saturation,
      vona: vona * w.vona * saturation,
      // Scaled to points so the blend stays interpretable. The scale is large on
      // purpose: an unfilled starting slot is not a preference, it is a hole that
      // scores zero every single week, and the cost of leaving one open is closer
      // to a startable player's entire output than to a rounding adjustment. At 25
      // points the term was decorative and the engine would happily finish a draft
      // without a receiver.
      //
      // Multiplied by the same marginal factor as the value terms, which is what
      // stops an empty kicker slot from screaming in round nine. An unfilled slot
      // at a streamable position is not urgent until the endgame - that is the
      // entire reason it is streamable. For every other position the factor is 1
      // while the slot is open, so this changes nothing there.
      need: need * NEED_POINT_SCALE * w.need * saturation,
      // Being the last player in a tier above a real cliff is worth acting on.
      tierBreak: tierRemaining <= 2 ? tierInfo.cliffBelow * w.tierBreak : 0,
      injury: -injuryPenalty(player) * w.injury,
      byeConflict: -byeConflictPenalty(player, ctx.roster) * w.byeConflict,
      stack: stackBonus(player, ctx.roster) * w.stack,
      trending: Math.min(15, Math.log1p(player.trendingAdds) * 3) * w.trending,
    };

    const score = round2(Object.values(components).reduce((a, b) => a + b, 0));

    return {
      ...player,
      vorp,
      tier: tierInfo.tier,
      cliffBelow: tierInfo.cliffBelow,
      tierRemaining,
      survival: round3(survival),
      vona,
      adpDelta: player.adp == null ? null : round1(player.adp - ctx.currentPick),
      score,
      components: roundComponents(components),
      reason: "value",
      saturation: round2(saturation),
    };
  });

  return scored.sort((a, b) => b.score - a.score || a.playerId.localeCompare(b.playerId));
}

/**
 * Pick the handful of players the model will actually see.
 *
 * Deliberately includes a best-available and an upside option even when the blended
 * score does not rank them top — a shortlist that only contains the safe consensus
 * pick gives the model nothing to weigh.
 */
export function buildShortlist(board: ScoredPlayer[], size: number = config.engine.shortlistSize): ScoredPlayer[] {
  if (board.length === 0) return [];

  const chosen = new Map<string, ScoredPlayer>();
  const take = (p: ScoredPlayer | undefined, reason: ShortlistReason) => {
    if (!p || chosen.has(p.playerId)) return;
    chosen.set(p.playerId, { ...p, reason });
  };

  for (const p of board.slice(0, size)) take(p, "value");

  if (config.engine.includeBestAvailable) {
    // Highest raw projection regardless of need or draft context.
    take([...board].sort((a, b) => b.vorp - a.vorp)[0], "best_available");
  }

  if (config.engine.includeUpsidePick) {
    // Young, ascending, and likely to last — the swing worth considering.
    const upside = board
      .filter((p) => (p.yearsExp ?? 99) <= 2 && p.survival > 0.5 && p.vorp > 0)
      .sort((a, b) => b.vorp - a.vorp)[0];
    take(upside, "upside");
  }

  // Guarantee the most urgent unfilled starting slot is represented, even if the
  // blend buried it — otherwise a run at a position can leave you with a shortlist
  // that never mentions the hole in your lineup.
  const urgentPosition = mostUrgentPosition(board, chosen);
  if (urgentPosition) {
    take(board.find((p) => p.position === urgentPosition), "need");
  }

  return [...chosen.values()].sort((a, b) => b.score - a.score);
}

/**
 * The position with the highest unfilled-starter urgency that the shortlist does
 * not already cover.
 */
function mostUrgentPosition(
  board: ScoredPlayer[],
  chosen: Map<string, ScoredPlayer>,
): string | null {
  const covered = new Set([...chosen.values()].map((p) => p.position));
  let best: { position: string; urgency: number } | null = null;
  for (const p of board) {
    if (covered.has(p.position)) continue;
    const urgency = p.components.need;
    if (urgency <= 0) continue;
    if (!best || urgency > best.urgency) best = { position: p.position, urgency };
  }
  return best?.position ?? null;
}

// ---------------------------------------------------------------------------
// Adjustment terms
// ---------------------------------------------------------------------------

/** Points to shave for injury risk. Season-ending designations are near-total. */
function injuryPenalty(p: RankablePlayer): number {
  const status = (p.injuryStatus ?? "").toUpperCase();
  const base = p.projectedPoints;
  switch (status) {
    case "IR":
    case "PUP":
    case "SUS":
    case "NA":
      return base * 0.6;
    case "OUT":
      return base * 0.25;
    case "DOUBTFUL":
      return base * 0.15;
    case "QUESTIONABLE":
      return base * 0.05;
    default:
      break;
  }
  // Limited or absent practice participation is a soft warning sign.
  const practice = (p.practiceParticipation ?? "").toLowerCase();
  if (practice.includes("did not")) return base * 0.08;
  if (practice.includes("limited")) return base * 0.03;
  return 0;
}

/** Mild penalty for piling starters onto one bye week. */
function byeConflictPenalty(p: RankablePlayer, roster: RosterState): number {
  if (p.byeWeek == null) return 0;
  const existing = roster.byeLoad.get(p.byeWeek) ?? 0;
  if (existing < 2) return 0;
  return (existing - 1) * 8;
}

/** Small nudge for pairing a pass catcher with a QB you already own, or vice versa. */
function stackBonus(p: RankablePlayer, roster: RosterState): number {
  if (!p.team || !roster.teams.has(p.team)) return 0;
  return p.position === "QB" || p.position === "WR" || p.position === "TE" ? 10 : 0;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function roundComponents(c: ScoreComponents): ScoreComponents {
  return Object.fromEntries(
    Object.entries(c).map(([k, v]) => [k, round2(v)]),
  ) as unknown as ScoreComponents;
}
