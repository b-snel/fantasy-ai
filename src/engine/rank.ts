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

    const components: ScoreComponents = {
      vorp: vorp * w.vorp,
      vona: vona * w.vona,
      // Scaled to points so the blend stays interpretable: full urgency ~ 25 pts.
      need: need * 25 * w.need,
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
export function buildShortlist(board: ScoredPlayer[], size = config.engine.shortlistSize): ScoredPlayer[] {
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
