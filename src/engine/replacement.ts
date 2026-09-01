/**
 * Replacement level and VORP.
 *
 * A player's raw projection says nothing about draft value on its own — 280 points
 * is elite for a TE and mediocre for a RB. VORP fixes that by measuring each player
 * against the worst starter the league will actually field at that position, which
 * is a function of roster requirements and team count, not of opinion.
 */

import { FANTASY_POSITIONS, type FantasyPosition } from "../sleeper/types.ts";

/** Slots that can be filled by more than one position. */
const FLEX_ELIGIBILITY: Record<string, FantasyPosition[]> = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: [],
};

export interface RosterRequirements {
  /** Dedicated starting slots per position. */
  starters: Record<string, number>;
  /** Flex slots by kind, e.g. { FLEX: 1, SUPER_FLEX: 1 }. */
  flex: Record<string, number>;
  benchSlots: number;
  totalRosterSize: number;
}

export function parseRosterPositions(rosterPositions: string[]): RosterRequirements {
  const starters: Record<string, number> = {};
  const flex: Record<string, number> = {};
  let benchSlots = 0;

  for (const slot of rosterPositions) {
    if (slot === "BN") {
      benchSlots++;
    } else if (slot === "IR" || slot === "TAXI") {
      // Not part of the active roster; ignore for value purposes.
    } else if (slot in FLEX_ELIGIBILITY) {
      flex[slot] = (flex[slot] ?? 0) + 1;
    } else {
      starters[slot] = (starters[slot] ?? 0) + 1;
    }
  }

  return { starters, flex, benchSlots, totalRosterSize: rosterPositions.length };
}

/**
 * How many players at each position the league will start in a typical week,
 * with flex slots distributed across their eligible positions by historical share.
 *
 * The flex split is a heuristic, not a law: in practice flex slots skew RB/WR with
 * a small TE share. Getting it exactly right matters less than being consistent,
 * since VORP is used comparatively.
 */
const FLEX_SHARE: Record<string, Partial<Record<FantasyPosition, number>>> = {
  FLEX: { RB: 0.5, WR: 0.45, TE: 0.05 },
  WRRB_FLEX: { RB: 0.5, WR: 0.5 },
  REC_FLEX: { WR: 0.85, TE: 0.15 },
  SUPER_FLEX: { QB: 0.85, RB: 0.05, WR: 0.08, TE: 0.02 },
};

export function startersPerPosition(
  req: RosterRequirements,
  teams: number,
): Record<FantasyPosition, number> {
  const out = Object.fromEntries(FANTASY_POSITIONS.map((p) => [p, 0])) as Record<
    FantasyPosition,
    number
  >;

  for (const [pos, count] of Object.entries(req.starters)) {
    if (pos in out) out[pos as FantasyPosition] += count;
  }
  for (const [flexKind, count] of Object.entries(req.flex)) {
    const share = FLEX_SHARE[flexKind];
    if (!share) continue;
    for (const [pos, fraction] of Object.entries(share)) {
      out[pos as FantasyPosition] += count * (fraction ?? 0);
    }
  }

  for (const pos of FANTASY_POSITIONS) out[pos] = out[pos] * teams;
  return out;
}

/**
 * The replacement-level index per position: the rank of the last player the league
 * will start. RB replacement in a 12-team league starting 2 RB + a flex lands
 * around RB30, which is why RB30's points are the right zero point for RB value.
 */
export function replacementRanks(
  req: RosterRequirements,
  teams: number,
): Record<FantasyPosition, number> {
  const starters = startersPerPosition(req, teams);
  const out = {} as Record<FantasyPosition, number>;
  for (const pos of FANTASY_POSITIONS) {
    // At least one, and never fractional.
    out[pos] = Math.max(1, Math.round(starters[pos]));
  }
  return out;
}

/**
 * Replacement points per position, given projections already sorted descending
 * within each position.
 */
export function replacementPoints(
  projectionsByPosition: Map<string, number[]>,
  ranks: Record<FantasyPosition, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [pos, points] of projectionsByPosition) {
    const rank = ranks[pos as FantasyPosition] ?? 1;
    // Index is rank-1; if the league is deeper than the player pool, use the last one.
    const idx = Math.min(rank - 1, points.length - 1);
    out[pos] = idx >= 0 ? (points[idx] ?? 0) : 0;
  }
  return out;
}
