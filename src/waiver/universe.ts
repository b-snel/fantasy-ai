/**
 * The valuation the waiver analyzer runs on: the trade universe, with its waiver
 * floor put back in its box.
 *
 * The trade analyzer assumes every weak slot is streamed from the wire for free.
 * For a trade that cancels out - both sides could stream. For waivers it is the
 * very thing being recommended, so leaving it in makes the baseline circular: it
 * credited this league's 0-6 roster with 5.4 points a week of pickups it had not
 * made, and hid that its only QB and only DEF share a bye (measured live
 * 2026-10-21). So here:
 *
 *   - **This week and next get no floor under starters.** The baseline is what
 *     the roster fields with no further moves; an empty slot scores nothing.
 *     That is where the decisions are: this week's lineup and next week's bye.
 *   - **Later weeks keep it.** By then the wire can be streamed like everyone
 *     else does. Without it every contender was told to stockpile defenses in
 *     October for a point or two in the playoffs (seen live, review 2026-10-21).
 *   - **The floor stays under the injury-substitute term** in every week: an
 *     unplanned absence is covered reactively from the wire.
 *   - **The candidate is removed from the floor.** A free agent is often himself
 *     the 2nd-best option that week, and pricing him against himself cancels his
 *     own value. Each candidate is valued on a floor computed without him.
 *   - **This week's locked starters keep their slots.** Once his game has started
 *     a starter cannot be moved, and his projection for the week reads zero (the
 *     game is in the past) - left alone, his slot would look like a hole any free
 *     agent fills. Week 0 is valued over the slots still open (`WeekZero`).
 *
 * Weeks are weighted outside the universe: a roster's weekly expected points
 * come out of `weeklyPoints`, and the search applies the horizon's weights.
 */

import { config } from "../config.ts";
import { rosterBreakdown, type LineupSlot, type TradeUniverse } from "../trade/value.ts";

/** Per week, per position: the best few free agents' points, best first. */
export interface FloorTable {
  weeks: Array<Map<string, Array<{ id: string; pts: number }>>>;
  depth: number;
}

/** How deep the table goes: the floor depth plus room to exclude a plan's worth of adds. */
const TABLE_EXTRA = 6;

export function floorTable(u: TradeUniverse, depth: number = config.trade.waiverDepth): FloorTable {
  const byPos = new Map<string, string[]>();
  for (const id of u.freeAgents) {
    const p = u.players.get(id);
    if (!p) continue;
    const list = byPos.get(p.position) ?? [];
    list.push(id);
    byPos.set(p.position, list);
  }
  const keep = depth + TABLE_EXTRA;
  const weeks = u.weeks.map((_, w) => {
    const m = new Map<string, Array<{ id: string; pts: number }>>();
    for (const [pos, ids] of byPos) {
      const top = ids
        .map((id) => ({ id, pts: u.players.get(id)!.weekly[w] ?? 0 }))
        .sort((a, b) => b.pts - a.pts || a.id.localeCompare(b.id))
        .slice(0, keep);
      m.set(pos, top);
    }
    return m;
  });
  return { weeks, depth };
}

/** The waiver floor with some players taken off the wire. */
export function floorWithout(table: FloorTable, exclude: ReadonlySet<string>): Array<Record<string, number>> {
  return table.weeks.map((m) => {
    const floor: Record<string, number> = {};
    for (const [pos, top] of m) {
      const left = exclude.size ? top.filter((x) => !exclude.has(x.id)) : top;
      floor[pos] = left.length ? (left[Math.min(table.depth, left.length) - 1]?.pts ?? 0) : 0;
    }
    return floor;
  });
}

/** The waiver valuation universe: no floor under starters this week and next, floor for injury cover. */
export function waiverUniverse(base: TradeUniverse, table: FloorTable, exclude: ReadonlySet<string> = new Set()): TradeUniverse {
  return {
    ...base,
    noFloorWeeks: config.waiver.noFloorWeeks,
    waiverFloor: floorWithout(table, exclude),
    freeAgents: exclude.size ? base.freeAgents.filter((id) => !exclude.has(id)) : base.freeAgents,
  };
}

/**
 * This week as Sleeper will let you play it: the starting slots still open, and
 * the players frozen where they are because their game has started. A locked
 * starter's points are the same with or without any move, so leaving his slot
 * out of week 0 changes no difference the search takes.
 */
export interface WeekZero {
  slots: LineupSlot[];
  frozen: ReadonlySet<string>;
}

/**
 * `starters` is Sleeper's saved lineup, aligned to the starting entries of
 * `rosterPositions`; `locked` is who has kicked off.
 */
export function weekZero(
  u: TradeUniverse,
  rosterPositions: string[],
  starters: readonly string[],
  locked: ReadonlySet<string>,
): WeekZero {
  const starterSlots = rosterPositions.filter((s) => s !== "BN" && s !== "IR" && s !== "TAXI");
  const taken = new Map<string, number>();
  starterSlots.forEach((label, i) => {
    const id = starters[i];
    if (id && id !== "0" && locked.has(id)) taken.set(label, (taken.get(label) ?? 0) + 1);
  });
  // u.slots is already in the optimiser's order; dropping taken labels keeps it.
  const slots = u.slots.filter((slot) => {
    const n = taken.get(slot.label) ?? 0;
    if (n > 0) {
      taken.set(slot.label, n - 1);
      return false;
    }
    return true;
  });
  return { slots, frozen: locked };
}

/** Expected lineup points each week of the window - week 0 over its open slots when given. */
export function weeklyPoints(u: TradeUniverse, playerIds: readonly string[], w0?: WeekZero | null): number[] {
  const weekly = rosterBreakdown(u, playerIds).weekly;
  if (!w0 || !w0.frozen.size || !weekly.length) return weekly;
  const thisWeek = { ...u, weeks: u.weeks.slice(0, 1), waiverFloor: u.waiverFloor.slice(0, 1), slots: w0.slots };
  weekly[0] = rosterBreakdown(thisWeek, playerIds.filter((id) => !w0.frozen.has(id))).weekly[0] ?? 0;
  return weekly;
}

/** Weighted sum of a weekly vector. */
export function weighted(values: readonly number[], weights: readonly number[], from = 0): number {
  let total = 0;
  for (let i = from; i < values.length; i++) total += (values[i] ?? 0) * (weights[i] ?? 0);
  return total;
}

export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
