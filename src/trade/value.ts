/**
 * What a roster is worth for the rest of the season.
 *
 * The draft engine prices players against the league; a trade has to be priced
 * against two specific rosters. A third running back is worth a lot to a team
 * starting a waiver-wire RB and almost nothing to a team that already starts four,
 * and that asymmetry is the whole reason trades that help both sides exist. So the
 * unit of value here is not the player but the roster: the points its best legal
 * lineup is expected to score, week by week, over the weeks that are left.
 *
 * Three things make that number honest rather than naive:
 *
 *   - **Week by week.** Projections are weekly, so bye weeks and injury returns are
 *     in the data rather than bolted on. A player out until week 9 projects zero
 *     before it, and a roster that loses three starters to the same bye pays for
 *     it in that week only.
 *   - **A waiver floor.** No slot is ever worth less than the free agent you could
 *     stream into it. An empty slot is not zero points, and a bench player who is
 *     no better than the waiver wire is worth nothing - which is what stops the
 *     search from treating throw-ins as value.
 *   - **Depth as insurance.** Each starter misses a given week with some small
 *     probability, and the best bench player eligible for the slot fills in. That
 *     is the only reason a bench player is worth more than his bye-week cameos,
 *     and pricing it is what keeps a 2-for-1 consolidation from looking free.
 */

import { config } from "../config.ts";
import { FLEX_ELIGIBILITY, parseRosterPositions, replacementRanks } from "../engine/replacement.ts";
import { valueTerm } from "../engine/rank.ts";
import { FANTASY_POSITIONS, type FantasyPosition, type League, type PlayersIndex } from "../sleeper/types.ts";

/** One starting slot and the positions that may fill it. */
export interface LineupSlot {
  label: string;
  eligible: string[];
}

export interface TradePlayer {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  injuryStatus: string | null;
  /** Projected points for each week of the window, aligned to `TradeUniverse.weeks`. */
  weekly: number[];
  /** Sum of `weekly`. */
  rosTotal: number;
  /** His bye, if it falls inside the window. */
  byeWeek: number | null;
  /** His game this week is already over - the first week's zero is not an absence. */
  playedThisWeek: boolean;
  /**
   * What the player looks like he is worth to a typical manager: rest-of-season
   * points over league replacement, softened below replacement. A perception
   * model for the fairness check, never the thing a trade is optimised for.
   */
  marketValue: number;
}

export interface TeamRoster {
  rosterId: number;
  /** Every player on the roster, reserve included. */
  players: string[];
  /** The subset in IR/reserve slots - they do not count against the active limit. */
  reserve: string[];
}

export interface TradeUniverse {
  /** The NFL weeks being valued, e.g. [7, 8, ..., 17]. */
  weeks: number[];
  /** Starting slots, dedicated first, then flex slots narrowest first. */
  slots: LineupSlot[];
  /** Roster spots outside IR. */
  activeLimit: number;
  reserveLimit: number;
  /** Every projected player at a position some slot can use, rostered or not. */
  players: Map<string, TradePlayer>;
  /** Unrostered players, best rest-of-season total first. */
  freeAgents: string[];
  /** Per week index: the streaming floor at each position. */
  waiverFloor: Array<Record<string, number>>;
  /** Per position: the league-replacement rest-of-season total market value is measured from. */
  replacementTotal: Record<string, number>;
  /**
   * Market value of a roster spot: what you could pick up off waivers with it. The
   * side that receives more players than it sends pays this per extra player
   * (it has to cut someone), and the side that sends more gets it back as a free
   * pickup - which is why junk throw-ins do not sweeten a deal.
   */
  rosterSpotValue: number;
  injuryRate: number;
}

export interface UniverseInput {
  league: League;
  rosters: TeamRoster[];
  players: PlayersIndex;
  /** playerId -> weekly projected points, aligned to `weeks`. */
  weekly: Map<string, number[]>;
  weeks: number[];
  /** playerId -> bye week inside the window. */
  byeWeek?: Map<string, number>;
  /** Players whose game this week is already over. */
  played?: Set<string>;
}

/** Parse roster_positions into lineup slots, in the order the optimiser fills them. */
export function lineupSlots(rosterPositions: string[]): LineupSlot[] {
  const dedicated: LineupSlot[] = [];
  const flex: LineupSlot[] = [];
  for (const slot of rosterPositions) {
    if ((FANTASY_POSITIONS as readonly string[]).includes(slot)) {
      dedicated.push({ label: slot, eligible: [slot] });
    } else if (slot in FLEX_ELIGIBILITY) {
      const eligible = FLEX_ELIGIBILITY[slot] ?? [];
      if (eligible.length) flex.push({ label: slot, eligible: [...eligible] });
    }
    // BN, IR, TAXI and IDP slots are not lineup slots.
  }
  // Narrowest flex first: a receiver who could fill FLEX or SUPER_FLEX must take
  // FLEX, or the quarterback who can only use SUPER_FLEX gets benched.
  flex.sort((a, b) => a.eligible.length - b.eligible.length);
  return [...dedicated, ...flex];
}

export function buildUniverse(input: UniverseInput): TradeUniverse {
  const { league, rosters, players, weekly, weeks } = input;
  const slots = lineupSlots(league.roster_positions);
  const usable = new Set(slots.flatMap((s) => s.eligible));

  const rostered = new Set(rosters.flatMap((r) => r.players));
  const universe = new Map<string, TradePlayer>();

  for (const [playerId, points] of weekly) {
    const p = players[playerId];
    const position = p?.position ?? null;
    if (!position || !usable.has(position)) continue;
    // A free agent who has retired or been cut is not someone you can stream. A
    // rostered one still is - he is on somebody's team until they drop him.
    if (!rostered.has(playerId) && p?.active === false) continue;
    const aligned = weeks.map((_, i) => Math.max(0, points[i] ?? 0));
    universe.set(playerId, {
      playerId,
      name: p?.full_name ?? (`${p?.first_name ?? ""} ${p?.last_name ?? ""}`.trim() || playerId),
      position,
      team: p?.team ?? null,
      injuryStatus: p?.injury_status ?? null,
      weekly: aligned,
      rosTotal: round1(aligned.reduce((a, b) => a + b, 0)),
      byeWeek: input.byeWeek?.get(playerId) ?? null,
      playedThisWeek: input.played?.has(playerId) ?? false,
      marketValue: 0,
    });
  }

  // Rostered players Sleeper did not project still exist - they just score zero.
  // Dropping them would make a roster look one player short and skew the limits.
  for (const id of rostered) {
    if (universe.has(id)) continue;
    const p = players[id];
    const position = p?.position ?? null;
    if (!position || !usable.has(position)) continue;
    universe.set(id, {
      playerId: id,
      name: p?.full_name ?? id,
      position,
      team: p?.team ?? null,
      injuryStatus: p?.injury_status ?? null,
      weekly: weeks.map(() => 0),
      rosTotal: 0,
      byeWeek: null,
      playedThisWeek: false,
      marketValue: 0,
    });
  }

  const freeAgents = [...universe.values()]
    .filter((p) => !rostered.has(p.playerId))
    .sort((a, b) => b.rosTotal - a.rosTotal || a.playerId.localeCompare(b.playerId))
    .map((p) => p.playerId);

  // The streaming floor: each week, the Nth-best free agent at the position. Not
  // the best - eleven other managers are reading the same waiver wire.
  const depth = Math.max(1, config.trade.waiverDepth);
  const faByPosition = new Map<string, TradePlayer[]>();
  for (const id of freeAgents) {
    const p = universe.get(id)!;
    const list = faByPosition.get(p.position) ?? [];
    list.push(p);
    faByPosition.set(p.position, list);
  }
  const waiverFloor = weeks.map((_, w) => {
    const floor: Record<string, number> = {};
    for (const pos of usable) {
      const pts = (faByPosition.get(pos) ?? []).map((p) => p.weekly[w] ?? 0).sort((a, b) => b - a);
      floor[pos] = pts.length ? (pts[Math.min(depth, pts.length) - 1] ?? 0) : 0;
    }
    return floor;
  });

  // Market value: rest-of-season points over the league's last starter at the
  // position, through the same softplus the draft engine uses so that bench
  // players are cheap but never free, scaled to the length of the window.
  const req = parseRosterPositions(league.roster_positions);
  const ranks = replacementRanks(req, league.total_rosters || rosters.length || 12);
  const replacementTotal: Record<string, number> = {};
  for (const pos of usable) {
    const totals = [...universe.values()]
      .filter((p) => p.position === pos)
      .map((p) => p.rosTotal)
      .sort((a, b) => b - a);
    const rank = ranks[pos as FantasyPosition] ?? 1;
    replacementTotal[pos] = totals.length ? (totals[Math.min(rank, totals.length) - 1] ?? 0) : 0;
  }
  const scale = Math.max(1, 25 * (weeks.length / 17));
  for (const p of universe.values()) {
    p.marketValue = round1(valueTerm(p.rosTotal - (replacementTotal[p.position] ?? 0), scale));
  }

  return {
    weeks,
    slots,
    activeLimit: league.roster_positions.filter((s) => s !== "IR" && s !== "TAXI").length,
    reserveLimit: league.settings?.reserve_slots ?? 0,
    players: universe,
    freeAgents,
    waiverFloor,
    replacementTotal,
    rosterSpotValue: spotValue(universe, freeAgents, depth),
    injuryRate: config.trade.injuryRate,
  };
}

/**
 * The Nth-best free agent's market value - same competition logic as the floor.
 * Kickers and defenses are left out: they fill only their own slot, and their
 * compressed scoring makes a waiver defense look worth more than it trades for.
 */
function spotValue(players: Map<string, TradePlayer>, freeAgents: string[], depth: number): number {
  const values = freeAgents
    .map((id) => players.get(id))
    .filter((p): p is TradePlayer => p != null && p.position !== "K" && p.position !== "DEF")
    .map((p) => p.marketValue)
    .sort((a, b) => b - a);
  return values.length ? (values[Math.min(depth, values.length) - 1] ?? 0) : 0;
}

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

export interface RosterBreakdown {
  /** Expected lineup points over the whole window. */
  total: number;
  /** Expected lineup points each week. */
  weekly: number[];
  /** Expected lineup points by the position of whoever filled the slot. */
  byPosition: Record<string, number>;
  /** Weeks each player is in the optimal starting lineup. */
  starts: Map<string, number>;
  /** Weeks each slot had to be streamed from waivers, by slot label. */
  streamed: Record<string, number>;
}

/** Expected rest-of-season lineup points. The hot path of the trade search. */
export function rosterValue(u: TradeUniverse, playerIds: readonly string[]): number {
  return evaluate(u, playerIds, null);
}

/** Same number as `rosterValue`, with the working shown. */
export function rosterBreakdown(u: TradeUniverse, playerIds: readonly string[]): RosterBreakdown {
  const detail: RosterBreakdown = {
    total: 0,
    weekly: [],
    byPosition: {},
    starts: new Map(playerIds.map((id) => [id, 0])),
    streamed: {},
  };
  detail.total = evaluate(u, playerIds, detail);
  return detail;
}

function evaluate(u: TradeUniverse, playerIds: readonly string[], detail: RosterBreakdown | null): number {
  const roster: TradePlayer[] = [];
  for (const id of playerIds) {
    const p = u.players.get(id);
    if (p) roster.push(p);
  }

  const q = u.injuryRate;
  const slots = u.slots;
  const n = roster.length;
  const order = new Array<number>(n);
  const assigned = new Array<number>(slots.length);
  const used = new Uint8Array(n);
  let total = 0;

  for (let w = 0; w < u.weeks.length; w++) {
    const floor = u.waiverFloor[w] ?? {};

    // Best-first for this week. Insertion sort: rosters are ~16 players.
    for (let i = 0; i < n; i++) {
      const pts = roster[i]!.weekly[w] ?? 0;
      let j = i;
      while (j > 0 && (roster[order[j - 1]!]!.weekly[w] ?? 0) < pts) {
        order[j] = order[j - 1]!;
        j--;
      }
      order[j] = i;
    }

    // Greedy fill in descending order. Each player takes the first open slot he
    // is eligible for, and slots are ordered dedicated-then-narrowest-flex, so a
    // player only reaches a flex slot once his own position is full of better
    // players - which is exactly the optimal assignment for these slot shapes.
    assigned.fill(-1);
    used.fill(0);
    for (let k = 0; k < n; k++) {
      const i = order[k]!;
      const p = roster[i]!;
      if ((p.weekly[w] ?? 0) <= 0) break; // the rest are on bye, hurt, or empty
      for (let s = 0; s < slots.length; s++) {
        if (assigned[s] !== -1) continue;
        if (!slots[s]!.eligible.includes(p.position)) continue;
        assigned[s] = i;
        used[i] = 1;
        break;
      }
    }

    let weekTotal = 0;
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s]!;
      let slotFloor = 0;
      let floorPos = slot.eligible[0]!;
      for (const pos of slot.eligible) {
        const f = floor[pos] ?? 0;
        if (f > slotFloor) {
          slotFloor = f;
          floorPos = pos;
        }
      }

      const a = assigned[s]!;
      const starterPts = a >= 0 ? (roster[a]!.weekly[w] ?? 0) : 0;
      // Worse than the waiver wire: you would stream, and he sits.
      const streamed = starterPts < slotFloor;
      if (streamed && a >= 0) used[a] = 0;
      const start = streamed ? slotFloor : starterPts;

      // The insurance term: the best unused eligible player, or the waiver wire.
      let sub = slotFloor;
      for (let k = 0; k < n; k++) {
        const i = order[k]!;
        if (used[i] || i === a) continue;
        const p = roster[i]!;
        if (!slot.eligible.includes(p.position)) continue;
        sub = Math.max(sub, p.weekly[w] ?? 0);
        break; // best-first, so the first eligible one is the best
      }

      const expected = (1 - q) * start + q * sub;
      weekTotal += expected;

      if (detail) {
        const pos = streamed || a < 0 ? floorPos : roster[a]!.position;
        detail.byPosition[pos] = (detail.byPosition[pos] ?? 0) + expected;
        if (streamed || a < 0) detail.streamed[slot.label] = (detail.streamed[slot.label] ?? 0) + 1;
        else {
          const id = roster[a]!.playerId;
          detail.starts.set(id, (detail.starts.get(id) ?? 0) + 1);
        }
      }
    }

    total += weekTotal;
    if (detail) detail.weekly.push(weekTotal);
  }

  return total;
}

// ---------------------------------------------------------------------------
// Rosters after a trade
// ---------------------------------------------------------------------------

export interface TradedRoster extends TeamRoster {
  /** Players cut to get back under the active limit. */
  dropped: string[];
  /** Open active spots left behind - filled from waivers, which the floor already prices. */
  openSpots: number;
}

/**
 * Move `out` off a roster and `incoming` onto it, then get it legal again.
 *
 * A received player who was in the sender's IR slot goes to IR here too if there
 * is room. Over the active limit, the team cuts whichever non-incoming player
 * costs it least - nobody accepts a trade and then releases what they got. Under
 * the limit there is nothing to do: an open spot is a waiver pickup, and the
 * waiver floor already says what that is worth.
 */
export function applyMoves(
  u: TradeUniverse,
  roster: TeamRoster,
  out: readonly string[],
  incoming: readonly string[],
  incomingFromReserve: ReadonlySet<string> = new Set(),
): TradedRoster {
  const outSet = new Set(out);
  const players = roster.players.filter((id) => !outSet.has(id));
  const reserve = roster.reserve.filter((id) => !outSet.has(id));

  for (const id of incoming) {
    players.push(id);
    if (incomingFromReserve.has(id) && reserve.length < u.reserveLimit) reserve.push(id);
  }

  const dropped: string[] = [];
  const incomingSet = new Set(incoming);
  const reserveSet = new Set(reserve);
  let active = players.filter((id) => !reserveSet.has(id));

  while (active.length > u.activeLimit) {
    // Only the cheapest few are realistic cuts; trying all of them is wasted work.
    const candidates = active
      .filter((id) => !incomingSet.has(id))
      .sort((a, b) => (u.players.get(a)?.marketValue ?? 0) - (u.players.get(b)?.marketValue ?? 0))
      .slice(0, 3);
    if (!candidates.length) break;

    let best = candidates[0]!;
    let bestValue = -Infinity;
    for (const id of candidates) {
      const value = rosterValue(u, players.filter((x) => x !== id));
      if (value > bestValue) {
        bestValue = value;
        best = id;
      }
    }
    dropped.push(best);
    players.splice(players.indexOf(best), 1);
    active = active.filter((x) => x !== best);
  }

  return {
    rosterId: roster.rosterId,
    players,
    reserve,
    dropped,
    openSpots: Math.max(0, u.activeLimit - active.length),
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
