/**
 * Finding the waiver moves worth making.
 *
 * A move is "add this free agent, drop that player of yours" - or just the add,
 * when there is an open roster spot or an injured player who can go to IR. Its
 * value is the change in your best lineup's expected points, week by week, on
 * the waiver universe (`universe.ts`: no free streaming under your starters,
 * the wire only as injury cover, and the candidate himself taken off the wire).
 * Then two things the trade analyzer never needed:
 *
 *   - **Weeks are weighted** by how much a point that week moves your season
 *     (`odds.ts`), or by the horizon the user picks. A pickup is not a
 *     commitment - you can cut him again - so when his points land matters.
 *   - **Timing.** A claim that processes after his game this week cannot help
 *     this week, so it is valued from next week on. And a move whose value sits
 *     almost entirely in one week is a stream - "add for week 8, drop after" -
 *     not a hold, and if that week is not this one it can usually wait for the
 *     next waiver run.
 *
 * The search is exhaustive: every claimable free agent against every player you
 * could cut. Rosters are small and the pool is a few hundred players.
 */

import { config } from "../config.ts";
import { rosterBreakdown, type TeamRoster, type TradeUniverse } from "../trade/value.ts";
import { sum, waiverUniverse, weeklyPoints, type FloorTable, type WeekZero } from "./universe.ts";

export interface WaiverQuery {
  /** Your players that must not be dropped. */
  keep?: string[];
  /** Only suggest adds at these positions. */
  positions?: string[];
  /** Evaluate this free agent against every possible drop. */
  add?: string | null;
  /** Only consider dropping this player. */
  drop?: string | null;
  limit?: number;
}

export interface DropOption {
  /** Null when the add needs no drop. */
  playerId: string | null;
  /** Weighted gain per week with this drop. */
  gain: number;
}

export type MoveKind = "hold" | "stream";

export interface WaiverMove {
  add: string;
  /** Null: an open spot takes him (possibly after an IR move). */
  drop: string | null;
  /** An injured active player moved to IR first, to open the spot. */
  irMove: string | null;
  /** Weighted lineup points per week of the window - the ranking number. */
  gain: number;
  /** Weighted lineup points over the window. */
  gainTotal: number;
  /** Unweighted expected points this week. */
  gainThisWeek: number;
  /** Unweighted expected points over the window. */
  pointsTotal: number;
  /** Unweighted change each week of the window. */
  weeklyDelta: number[];
  kind: MoveKind;
  /** Window index of the week he helps most. */
  peakWeek: number;
  /** That week's share of his positive weekly gains. */
  peakShare: number;
  /**
   * A stream for a later week whose value this week, under the horizon's
   * weights, is too small to lose by waiting for the next run.
   */
  waitable: boolean;
  /** First window week the add can help (1 when his claim processes after his game). */
  startWeek: number;
  /** Other ways to make room, best first; the chosen drop is the first entry. */
  dropOptions: DropOption[];
  /** Weeks the added player would start in the new lineup. */
  starts: number;
  /**
   * The other adds that would do this job about as well: same position, and for
   * a stream the same week. Best first. Lesser streams fold into the best one's
   * card (six QBs for one bye are one decision), and a bid is priced against
   * these - winning him is only worth what he beats them by.
   */
  alternatives: WaiverMove[];
}

export interface WaiverSearchResult {
  moves: WaiverMove[];
  /** The pinned add, evaluated whether or not it clears the bar. */
  proposal: WaiverMove | null;
  /** Free agents valued. */
  considered: number;
  /** add x drop pairs valued. */
  evaluated: number;
  notes: string[];
}

export class WaiverQueryError extends Error {
  override name = "WaiverQueryError";
}

export interface SearchContext {
  /** The trade universe for the league - the waiver universe is derived per candidate. */
  base: TradeUniverse;
  table: FloorTable;
  /** Per-week weights, aligned to the window. */
  weights: number[];
  mine: TeamRoster;
  /** Active players of yours who can move to an open IR slot right now. */
  irEligible: string[];
  /** Your players whose game this week has started - bench lock forbids dropping them now. */
  locked: ReadonlySet<string>;
  /** First window week a free agent can help: 0, or 1 when his claim cannot beat his game. */
  startWeek: (playerId: string) => number;
  /**
   * Whether `drop` can be cut when the claim on `add` processes. Bench lock is
   * judged at processing time, not now: a fresh-drop claim processes ~23h out,
   * still inside the week. Without it, `locked` decides (lifted for next-run claims).
   */
  canDrop?: (add: string, drop: string) => boolean;
  /** This week's open slots and frozen starters (see universe.ts). */
  weekZero?: WeekZero | null;
  /** Free agents already taken by earlier plan steps - off the wire for later ones. */
  taken?: ReadonlySet<string>;
}

/** Players on the active roster - not in IR. */
export function activePlayers(r: TeamRoster): string[] {
  const reserve = new Set(r.reserve);
  return r.players.filter((id) => !reserve.has(id));
}

/**
 * Room to add without a drop: open active spots, plus injured active players who
 * can move to an open IR slot. `irMove` is the player to move first when there
 * is no plain open spot.
 */
export function openSpots(
  u: TradeUniverse,
  r: TeamRoster,
  irEligible: string[],
): { open: number; irMove: string | null } {
  const free = Math.max(0, u.activeLimit - activePlayers(r).length);
  const reserveFree = Math.max(0, u.reserveLimit - r.reserve.length);
  const movable = irEligible.filter((id) => r.players.includes(id) && !r.reserve.includes(id)).slice(0, reserveFree);
  return { open: free + movable.length, irMove: free > 0 ? null : (movable[0] ?? null) };
}

/** Free agents worth valuing: a projection in some weighted week they can help, at an allowed position. */
export function candidatePool(ctx: SearchContext, positions?: string[]): string[] {
  const allowed = positions?.length ? new Set(positions) : null;
  return ctx.base.freeAgents.filter((id) => {
    if (ctx.taken?.has(id)) return false;
    const p = ctx.base.players.get(id);
    if (!p || (allowed && !allowed.has(p.position))) return false;
    const from = ctx.startWeek(id);
    return p.weekly.some((pts, i) => i >= from && pts > 0 && (ctx.weights[i] ?? 0) > 0);
  });
}

/** Players the add could replace, given the pins and the bench lock. */
function dropPool(ctx: SearchContext, add: string, startWeek: number, keep: ReadonlySet<string>, drop: string | null): string[] {
  const legal = (id: string) => (ctx.canDrop ? ctx.canDrop(add, id) : startWeek > 0 || !ctx.locked.has(id));
  if (drop) return legal(drop) ? [drop] : [];
  return activePlayers(ctx.mine).filter((id) => !keep.has(id) && legal(id));
}

/** Value one add against every allowed drop. Null when there is no legal way to make room. */
export function evaluateAdd(
  ctx: SearchContext,
  add: string,
  opts: { keep?: ReadonlySet<string>; drop?: string | null } = {},
): WaiverMove | null {
  const { base, mine, weights } = ctx;
  if (!base.players.has(add)) return null;
  const startWeek = ctx.startWeek(add);
  const exclude = new Set([add, ...(ctx.taken ?? [])]);
  const u = waiverUniverse(base, ctx.table, exclude);
  const before = weeklyPoints(u, mine.players, ctx.weekZero);
  const weightSum = Math.max(1e-9, sum(weights));
  const keep = opts.keep ?? new Set<string>();
  const { open, irMove } = openSpots(base, mine, ctx.irEligible);

  const options: Array<DropOption & { delta: number[] }> = [];
  const score = (players: string[], playerId: string | null) => {
    const after = weeklyPoints(u, players, ctx.weekZero);
    const delta = after.map((v, i) => (i < startWeek ? 0 : v - (before[i] ?? 0)));
    const total = delta.reduce((a, d, i) => a + d * (weights[i] ?? 0), 0);
    options.push({ playerId, gain: total / weightSum, delta });
  };
  if (open > 0 && !opts.drop) {
    score([...mine.players, add], null);
  } else {
    for (const d of dropPool(ctx, add, startWeek, keep, opts.drop ?? null)) {
      score([...mine.players.filter((x) => x !== d), add], d);
    }
  }
  if (!options.length) return null;
  // Ties on the weighted gain are common under narrow horizons (a bench player
  // whose weeks carry no weight); break them on the plain points the cut loses.
  const plain = (o: { delta: number[] }) => sum(o.delta);
  options.sort(
    (a, b) => b.gain - a.gain || plain(b) - plain(a) || String(a.playerId).localeCompare(String(b.playerId)),
  );

  const best = options[0]!;
  const gainTotal = best.delta.reduce((a, d, i) => a + d * (weights[i] ?? 0), 0);
  // Hold or stream is about the player, not the horizon: judged on the plain
  // weekly gains, positive weeks only (a drop that costs points elsewhere must
  // not push one week's share past 100%).
  let peakWeek = 0;
  best.delta.forEach((d, i) => {
    if (d > (best.delta[peakWeek] ?? 0)) peakWeek = i;
  });
  const positive = best.delta.reduce((a, d) => a + Math.max(0, d), 0);
  const peakShare = positive > 0 ? Math.max(0, best.delta[peakWeek] ?? 0) / positive : 0;
  const kind: MoveKind = peakShare >= config.waiver.streamShare ? "stream" : "hold";
  // Whether it can wait for the next run is about the horizon, though: only if
  // what waiting forfeits - this week's weighted value - is a small part of it.
  const nowValue = Math.max(0, (best.delta[0] ?? 0) * (weights[0] ?? 0));
  const waitable = kind === "stream" && peakWeek >= 1 && gainTotal > 0 && nowValue < 0.25 * gainTotal;
  const nextPlayers = [...mine.players.filter((x) => x !== best.playerId), add];

  return {
    add,
    drop: best.playerId,
    irMove: best.playerId === null ? irMove : null,
    gain: best.gain,
    gainTotal,
    gainThisWeek: round2(best.delta[0] ?? 0),
    pointsTotal: round2(sum(best.delta)),
    weeklyDelta: best.delta.map(round2),
    kind,
    peakWeek,
    peakShare,
    waitable,
    startWeek,
    dropOptions: options.slice(0, 4).map(({ playerId, gain }) => ({ playerId, gain })),
    starts: rosterBreakdown(u, nextPlayers).starts.get(add) ?? 0,
    alternatives: [],
  };
}

/** Rank every claimable add, each with its best drop. */
export async function findMoves(ctx: SearchContext, query: WaiverQuery): Promise<WaiverSearchResult> {
  const { base, mine } = ctx;
  const w = config.waiver;
  const notes: string[] = [];
  const keep = new Set(query.keep ?? []);
  const owned = new Set(mine.players);

  if (query.drop) {
    if (!owned.has(query.drop)) throw new WaiverQueryError(`${nameOf(base, query.drop)} is not on your roster.`);
    if (keep.has(query.drop)) throw new WaiverQueryError(`${nameOf(base, query.drop)} is marked both "drop" and "keep".`);
    if (mine.reserve.includes(query.drop)) {
      throw new WaiverQueryError(`${nameOf(base, query.drop)} is in IR - dropping him does not open an active spot.`);
    }
  }
  if (query.add && !base.freeAgents.includes(query.add)) {
    throw new WaiverQueryError(`${nameOf(base, query.add)} is not a free agent in this league.`);
  }

  if (query.drop && ctx.canDrop && query.add && !ctx.canDrop(query.add, query.drop)) {
    throw new WaiverQueryError(`${nameOf(base, query.drop)}'s game has started - he can't be cut until it is over.`);
  }
  if (query.drop && !ctx.canDrop && ctx.locked.has(query.drop) && query.add && ctx.startWeek(query.add) === 0) {
    throw new WaiverQueryError(`${nameOf(base, query.drop)}'s game has started - he can't be cut until it is over.`);
  }

  const pool = candidatePool(ctx, query.positions);
  const { open } = openSpots(base, mine, ctx.irEligible);
  let evaluated = 0;
  const scored: WaiverMove[] = [];
  for (let i = 0; i < pool.length; i++) {
    const m = evaluateAdd(ctx, pool[i]!, { keep, drop: query.drop });
    if (m) {
      evaluated += open > 0 && !query.drop ? 1 : dropPool(ctx, m.add, m.startWeek, keep, query.drop ?? null).length;
      scored.push(m);
    }
    // Yield now and then so a big pool never stalls the server's live streams.
    if (i % 50 === 49) await new Promise((r) => setTimeout(r, 0));
  }
  scored.sort((a, b) => b.gain - a.gain || a.add.localeCompare(b.add));

  const limit = query.limit ?? w.resultLimit;
  const perPosition = new Map<string, number>();
  const moves: WaiverMove[] = [];
  const streams = new Map<string, WaiverMove>();
  for (const m of scored) {
    if (m.gain < w.minGainPerWeek) break;
    const pos = base.players.get(m.add)?.position ?? "";
    // A lesser stream for the same week and position folds into the best one.
    const key = `${pos}:${m.peakWeek}`;
    if (m.kind === "stream" && streams.has(key)) continue;
    if (moves.length >= limit) continue;
    if (!query.positions?.length && (perPosition.get(pos) ?? 0) >= w.perPositionLimit) continue;
    moves.push(m);
    if (m.kind === "stream") streams.set(key, m);
    perPosition.set(pos, (perPosition.get(pos) ?? 0) + 1);
  }

  // Every listed move (and the pinned one) is priced against the same peers,
  // drawn from everything scored - folding and drops do not change who they are.
  const peersOf = (m: WaiverMove) =>
    scored
      .filter(
        (x) =>
          x.add !== m.add &&
          x.gain >= w.minGainPerWeek &&
          base.players.get(x.add)?.position === base.players.get(m.add)?.position &&
          (m.kind !== "stream" || x.peakWeek === m.peakWeek),
      )
      .slice(0, 5)
      .map((x) => ({ ...x, alternatives: [] }));
  for (const m of moves) m.alternatives = peersOf(m);

  const proposal = query.add ? evaluateAdd(ctx, query.add, { keep, drop: query.drop }) : null;
  if (proposal) proposal.alternatives = peersOf(proposal);
  if (query.add && !proposal) {
    notes.push(`No legal way to make room for ${nameOf(base, query.add)} - every droppable player is pinned or locked.`);
  }
  if (!moves.length && !proposal) {
    notes.push(
      query.positions?.length || query.drop
        ? "No add at those settings beats what you already have."
        : "Nobody on the wire beats what you already have - hold your FAAB.",
    );
  }
  return { moves, proposal, considered: pool.length, evaluated, notes };
}

const nameOf = (u: TradeUniverse, id: string) => u.players.get(id)?.name ?? id;
const round2 = (n: number): number => Math.round(n * 100) / 100;
