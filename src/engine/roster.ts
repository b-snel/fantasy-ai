/**
 * What your team still needs.
 *
 * Need is not "how many of this position do I have" — it's "how much would the next
 * one improve my starting lineup, given how many picks are left". Early in the
 * draft need should barely matter (take the best player); late it should dominate
 * (you cannot start a 4th tight end).
 */

import { FANTASY_POSITIONS, type FantasyPosition } from "../sleeper/types.ts";
import type { RosterRequirements } from "./replacement.ts";

export interface PositionNeed {
  position: FantasyPosition;
  /** Dedicated starting slots for this position. */
  required: number;
  /** How many you have rostered. */
  owned: number;
  /** Starting slots still unfilled. */
  unfilled: number;
  /** 0-1 urgency, blending unfilled starters against remaining picks. */
  urgency: number;
}

/** Positions eligible for each flex kind, mirroring replacement.ts. */
const FLEX_ELIGIBILITY: Record<string, FantasyPosition[]> = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};

export interface RosterState {
  countsByPosition: Record<FantasyPosition, number>;
  needs: Record<FantasyPosition, PositionNeed>;
  /** Bye weeks already concentrated on your roster: week -> starter count. */
  byeLoad: Map<number, number>;
  /** NFL teams you already have players from — used for stack detection. */
  teams: Set<string>;
  filledStarterSlots: number;
  totalStarterSlots: number;
}

export interface OwnedPlayer {
  playerId: string;
  position: string;
  team?: string | null;
  byeWeek?: number | null;
}

export function evaluateRoster(
  owned: OwnedPlayer[],
  req: RosterRequirements,
  picksRemaining: number,
): RosterState {
  const counts = Object.fromEntries(FANTASY_POSITIONS.map((p) => [p, 0])) as Record<
    FantasyPosition,
    number
  >;
  const byeLoad = new Map<number, number>();
  const teams = new Set<string>();

  for (const p of owned) {
    if (p.position in counts) counts[p.position as FantasyPosition]++;
    if (p.team) teams.add(p.team);
    if (p.byeWeek != null) byeLoad.set(p.byeWeek, (byeLoad.get(p.byeWeek) ?? 0) + 1);
  }

  // Flex slots absorb surplus from their eligible positions, so a position is only
  // truly "full" once the dedicated slots and its share of flex are covered.
  const flexCapacity = Object.fromEntries(FANTASY_POSITIONS.map((p) => [p, 0])) as Record<
    FantasyPosition,
    number
  >;
  for (const [kind, count] of Object.entries(req.flex)) {
    for (const pos of FLEX_ELIGIBILITY[kind] ?? []) flexCapacity[pos] += count;
  }

  const needs = {} as Record<FantasyPosition, PositionNeed>;
  let filledStarterSlots = 0;
  let totalStarterSlots = 0;

  for (const pos of FANTASY_POSITIONS) {
    const required = req.starters[pos] ?? 0;
    const owned_ = counts[pos];
    const unfilled = Math.max(0, required - owned_);
    totalStarterSlots += required;
    filledStarterSlots += Math.min(owned_, required);

    // Urgency rises as unfilled starters approach the number of picks left. With
    // plenty of picks in hand an empty slot is not yet a problem; with few, it is
    // the only thing that matters. The square root makes the curve bite earlier
    // than a linear ramp, which under-reacted until it was genuinely too late -
    // by the time a linear ramp screams, the startable players are gone.
    const scarcityPressure = picksRemaining > 0 ? unfilled / picksRemaining : unfilled > 0 ? 1 : 0;
    let urgency = unfilled === 0 ? 0 : Math.min(1, Math.sqrt(scarcityPressure * 1.6));

    // A position with flex outlets keeps mild value even when its slots are full.
    if (unfilled === 0 && flexCapacity[pos] > 0 && owned_ < required + flexCapacity[pos]) {
      urgency = Math.max(urgency, 0.2);
    }

    needs[pos] = { position: pos, required, owned: owned_, unfilled, urgency: round3(urgency) };
  }

  return {
    countsByPosition: counts,
    needs,
    byeLoad,
    teams,
    filledStarterSlots,
    totalStarterSlots,
  };
}

/** A short human-readable roster summary for the prompt and the UI header. */
export function describeRoster(state: RosterState): string {
  const parts = FANTASY_POSITIONS.filter((p) => state.countsByPosition[p] > 0).map(
    (p) => `${p}${state.countsByPosition[p]}`,
  );
  return parts.length ? parts.join(" ") : "empty";
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
