/**
 * One week at a time: holes, streams, cuts, and this week's lineup.
 *
 * The move search answers "who should I add?" over the season. Four smaller
 * questions are better answered one week at a time:
 *
 *   - **Holes.** Which starting slots can your roster not fill this week or next -
 *     a starter on bye or out with nobody behind him? A QB and a DEF who share a
 *     bye is the classic one, and the first thing a waiver page should say.
 *   - **Streams.** For a given week, which free agents beat who you would start?
 *     Valued with no floor and no injury insurance: by kickoff you know who is
 *     playing, and a backup is not worth 8% of a starter that week.
 *   - **Cuts.** The other half of every move: whose departure costs your weighted
 *     lineup least. A full roster of dead weight is what stops you streaming.
 *   - **Lineup.** Whether your saved lineup for this week is your best one. A
 *     Wednesday waiver page is the cheapest place to catch a starter left on the
 *     bench after his bye.
 */

import type { LineupSlot, TeamRoster, TradeUniverse } from "../trade/value.ts";
import { activePlayers } from "./search.ts";
import { sum, waiverUniverse, weeklyPoints, type FloorTable, type WeekZero } from "./universe.ts";

export interface Stream {
  add: string;
  /** Index into the window. */
  weekIndex: number;
  /** Points he adds to that week's expected lineup over your own best. */
  gain: number;
  /** His projection that week. */
  points: number;
  /** The starter he would bump that week, if any. */
  replaces: string | null;
}

export interface Hole {
  weekIndex: number;
  /** Lineup slot label (QB, RB, FLEX, ...). */
  slot: string;
  /** The positions that can fill it. */
  eligible: string[];
  /** Your best option there that week, if any. */
  best: string | null;
  bestPoints: number;
  /** Why the usual starter is missing. */
  reason: "bye" | "out" | "thin";
  /** Who normally starts there. */
  usual: string | null;
}

export interface Cut {
  playerId: string;
  /** Weighted lineup points per week lost by dropping him (0 = dead weight). */
  cost: number;
  /** Weeks he starts in the current best lineup. */
  starts: number;
}

export interface LineupFix {
  /** Benched players who should start, with this week's projection. */
  start: Array<{ playerId: string; points: number }>;
  /** Starters who should sit. */
  sit: Array<{ playerId: string; points: number }>;
  /** Projected points the fix adds this week. */
  gain: number;
}

/** A week's start decision: no floor, no insurance - you start who is playing. */
function startDecision(u: TradeUniverse, table: FloorTable): TradeUniverse {
  return { ...waiverUniverse(u, table), injuryRate: 0 };
}

/**
 * The best free-agent streams for one week of the window: what each adds to that
 * week's lineup over your roster as it stands (as if a roster spot were free -
 * the cut is a separate question).
 */
export function streamsForWeek(
  u: TradeUniverse,
  table: FloorTable,
  mine: TeamRoster,
  weekIndex: number,
  opts: { perPosition?: number; minGain?: number; startWeek?: (id: string) => number; weekZero?: WeekZero | null } = {},
): Stream[] {
  const bare = startDecision(u, table);
  const w0 = weekIndex === 0 ? opts.weekZero : null;
  const baseWeek = weeklyPoints(bare, mine.players, w0)[weekIndex] ?? 0;
  const perPosition = opts.perPosition ?? 3;
  const minGain = opts.minGain ?? 1;
  const lineup = w0
    ? lineupFor({ ...bare, slots: w0.slots }, mine.players.filter((id) => !w0.frozen.has(id)), 0)
    : lineupFor(bare, mine.players, weekIndex);

  // Best projections first per position - nobody below the tenth best beats a starter.
  const byPos = new Map<string, string[]>();
  for (const id of u.freeAgents) {
    const p = u.players.get(id);
    if (!p || (p.weekly[weekIndex] ?? 0) <= 0) continue;
    if ((opts.startWeek?.(id) ?? 0) > weekIndex) continue;
    const list = byPos.get(p.position) ?? [];
    list.push(id);
    byPos.set(p.position, list);
  }

  const out: Stream[] = [];
  for (const [pos, ids] of byPos) {
    ids.sort((a, b) => (u.players.get(b)!.weekly[weekIndex] ?? 0) - (u.players.get(a)!.weekly[weekIndex] ?? 0));
    const picks: Stream[] = [];
    for (const id of ids.slice(0, 10)) {
      const gain = (weeklyPoints(bare, [...mine.players, id], w0)[weekIndex] ?? 0) - baseWeek;
      if (gain < minGain) continue;
      picks.push({
        add: id,
        weekIndex,
        gain: round2(gain),
        points: round2(u.players.get(id)!.weekly[weekIndex] ?? 0),
        replaces: weakestStarter(w0 ? { ...u, slots: w0.slots } : u, lineup, pos, weekIndex),
      });
    }
    picks.sort((a, b) => b.gain - a.gain || a.add.localeCompare(b.add));
    out.push(...picks.slice(0, perPosition));
  }
  return out.sort((a, b) => b.gain - a.gain || a.add.localeCompare(b.add));
}

/**
 * Starting slots a roster cannot fill properly in a given week: under half of
 * what that slot averages across the window.
 */
export function holesForWeek(
  u: TradeUniverse,
  table: FloorTable,
  roster: TeamRoster,
  weekIndex: number,
  weekZero?: WeekZero | null,
): Hole[] {
  const bare = startDecision(u, table);
  const active = activePlayers(roster);
  const lineups = u.weeks.map((_, i) => lineupFor(bare, active, i));
  let thisWeek = lineups[weekIndex] ?? [];
  // This week, a slot a locked starter holds is filled whatever his projection
  // now reads (zero - his game is in the past); only the open slots can be holes.
  const w0 = weekIndex === 0 ? weekZero : null;
  if (w0?.frozen.size) {
    const open = lineupFor({ ...bare, slots: w0.slots }, active.filter((id) => !w0.frozen.has(id)), 0);
    const remaining = [...open];
    thisWeek = u.slots.map((slot) => {
      const k = remaining.findIndex((f) => f.label === slot.label);
      if (k < 0) return { label: slot.label, id: "frozen", points: Infinity };
      return remaining.splice(k, 1)[0]!;
    });
  }
  const holes: Hole[] = [];
  thisWeek.forEach((slot, s) => {
    const avg = lineups.reduce((a, l) => a + (l[s]?.points ?? 0), 0) / Math.max(1, lineups.length);
    if (avg <= 0 || slot.points >= avg * 0.5) return;
    // Who normally fills it: the most frequent occupant across the window.
    const counts = new Map<string, number>();
    for (const l of lineups) {
      const id = l[s]?.id;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const usual = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    const p = usual ? u.players.get(usual) : undefined;
    const reason: Hole["reason"] =
      p && p.byeWeek === u.weeks[weekIndex] ? "bye" : p && (p.weekly[weekIndex] ?? 0) <= 0 ? "out" : "thin";
    holes.push({
      weekIndex,
      slot: slot.label,
      eligible: u.slots[s]!.eligible,
      best: slot.id,
      bestPoints: round2(slot.points),
      reason,
      usual,
    });
  });
  return holes;
}

/** Your active players by what dropping each costs your weighted lineup, cheapest first. */
export function cutCandidates(
  u: TradeUniverse,
  table: FloorTable,
  mine: TeamRoster,
  weights: number[],
  keep: ReadonlySet<string> = new Set(),
  weekZero?: WeekZero | null,
): Cut[] {
  const wu = waiverUniverse(u, table);
  const before = weeklyPoints(wu, mine.players, weekZero);
  const weightSum = Math.max(1e-9, sum(weights));
  const bare = startDecision(u, table);
  const lineups = u.weeks.map((_, i) => lineupFor(bare, mine.players, i));
  return activePlayers(mine)
    .filter((id) => !keep.has(id))
    .map((id) => {
      const after = weeklyPoints(wu, mine.players.filter((x) => x !== id), weekZero);
      const cost = before.reduce((a, v, i) => a + (v - (after[i] ?? 0)) * (weights[i] ?? 0), 0) / weightSum;
      const starts = lineups.filter((l) => l.some((f) => f.id === id)).length;
      return { playerId: id, cost: round2(Math.max(0, cost)), starts };
    })
    .sort((a, b) => a.cost - b.cost || a.starts - b.starts || a.playerId.localeCompare(b.playerId));
}

/**
 * Is the saved lineup this week's best? Players whose game has started are
 * fixed where they are; everyone else is free to move.
 *
 * `starters` is Sleeper's lineup, aligned to the starting entries of
 * `rosterPositions` ("0" or empty for an open slot).
 */
export function lineupCheck(
  u: TradeUniverse,
  table: FloorTable,
  mine: TeamRoster,
  starters: string[],
  rosterPositions: string[],
  locked: ReadonlySet<string>,
): LineupFix | null {
  const bare = startDecision(u, table);
  const starterSlots = rosterPositions.filter((s) => s !== "BN" && s !== "IR" && s !== "TAXI");
  const pts = (id: string) => u.players.get(id)?.weekly[0] ?? 0;
  const reserve = new Set(mine.reserve);

  // Locked starters keep their slot; that slot is taken out of the optimisation.
  const open: LineupSlot[] = [];
  const fixed = new Set<string>();
  starterSlots.forEach((label, i) => {
    const id = starters[i];
    if (id && id !== "0" && locked.has(id)) {
      fixed.add(id);
      return;
    }
    const slot = u.slots.find((s) => s.label === label);
    if (slot) open.push(slot);
  });
  const free = mine.players.filter((id) => !reserve.has(id) && !locked.has(id) && !fixed.has(id));
  const best = lineupFor({ ...bare, slots: orderSlots(open) }, free, 0);
  const bestIds = new Set(best.map((f) => f.id).filter((x): x is string => x != null));
  const current = new Set(starters.filter((id) => id && id !== "0" && !fixed.has(id)));

  const start = [...bestIds].filter((id) => !current.has(id)).map((id) => ({ playerId: id, points: round2(pts(id)) }));
  const sit = [...current].filter((id) => !bestIds.has(id)).map((id) => ({ playerId: id, points: round2(pts(id)) }));
  const gain = round2(sum([...bestIds].map(pts)) - sum([...current].map(pts)));
  if (gain < 0.5 || !start.length) return null;
  start.sort((a, b) => b.points - a.points);
  sit.sort((a, b) => a.points - b.points);
  return { start, sit, gain };
}

// ---------------------------------------------------------------------------

interface SlotFill {
  label: string;
  id: string | null;
  points: number;
}

/** Dedicated slots first, then flex slots narrowest first - the valuation's order. */
function orderSlots(slots: LineupSlot[]): LineupSlot[] {
  const dedicated = slots.filter((s) => s.eligible.length === 1);
  const flex = slots.filter((s) => s.eligible.length > 1).sort((a, b) => a.eligible.length - b.eligible.length);
  return [...dedicated, ...flex];
}

/** The best lineup one week, slot by slot - the same greedy fill the valuation uses. */
export function lineupFor(u: TradeUniverse, playerIds: readonly string[], weekIndex: number): SlotFill[] {
  const roster = playerIds
    .map((id) => u.players.get(id))
    .filter((p): p is NonNullable<typeof p> => p != null)
    .sort((a, b) => (b.weekly[weekIndex] ?? 0) - (a.weekly[weekIndex] ?? 0) || a.playerId.localeCompare(b.playerId));
  const fills: SlotFill[] = u.slots.map((s) => ({ label: s.label, id: null, points: 0 }));
  for (const p of roster) {
    const pts = p.weekly[weekIndex] ?? 0;
    if (pts <= 0) break;
    const s = u.slots.findIndex((slot, i) => fills[i]!.id == null && slot.eligible.includes(p.position));
    if (s >= 0) fills[s] = { label: u.slots[s]!.label, id: p.playerId, points: pts };
  }
  return fills;
}

function weakestStarter(u: TradeUniverse, lineup: SlotFill[], position: string, weekIndex: number): string | null {
  let worstId: string | null = null;
  let worstPts = Infinity;
  lineup.forEach((fill, s) => {
    if (!u.slots[s]!.eligible.includes(position)) return;
    const pts = fill.id ? (u.players.get(fill.id)?.weekly[weekIndex] ?? 0) : 0;
    if (pts < worstPts) {
      worstPts = pts;
      worstId = fill.id;
    }
  });
  return worstId;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
