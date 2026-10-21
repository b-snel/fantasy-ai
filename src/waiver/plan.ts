/**
 * The plan: what to actually do, in the order to do it.
 *
 * A ranked list of moves is not advice yet. Two moves that both cut the same
 * player cannot both happen; a claim that processes next Wednesday is a
 * different action from an add you can make right now; and in Sleeper a won
 * claim uses up the roster spot a later claim needed (a third of this league's
 * failed claims failed on roster size). So the plan is built step by step:
 *
 *   1. Fix this week's lineup - free points, no transaction.
 *   2. IR housekeeping: a healthy player in IR (fix it - Sleeper may block moves),
 *      an injured starter who can go to IR and open a spot.
 *   3. Adds you can make now (free agents), re-searched after each one so no
 *      player is cut twice and no hole is filled twice.
 *   4. Claims for players on waivers, each with an explicit drop, a bid, and
 *      fallbacks that share the drop and bid no more (a higher fallback bid
 *      would process first).
 *   5. Next week's holes, which can wait for the next run - with the bid to put
 *      in, and what grabbing a player now would cost instead.
 *   6. Players coming back from IR, and who gets cut to make room.
 */

import { config } from "../config.ts";
import type { TeamRoster } from "../trade/value.ts";
import type { Availability } from "./availability.ts";
import type { BidAdvice } from "./market.ts";
import { activePlayers, findMoves, type SearchContext, type WaiverMove, type WaiverQuery } from "./search.ts";
import { cutCandidates, holesForWeek, type Hole, type LineupFix } from "./streams.ts";

export type PlanStep =
  | { kind: "lineup"; fix: LineupFix }
  /** Out of IR now; `cut` makes the active spot he needs. */
  | { kind: "ir-healthy"; playerId: string; cut: string | null }
  | { kind: "ir-move"; playerId: string }
  /** `roster` is the roster the step was planned on - its reasons are about that one. */
  | { kind: "add"; move: WaiverMove; availability: Availability; roster: TeamRoster }
  | {
      kind: "claim";
      move: WaiverMove;
      availability: Availability;
      bid: BidAdvice | null;
      fallbacks: WaiverMove[];
      roster: TeamRoster;
    }
  | {
      kind: "later";
      move: WaiverMove;
      availability: Availability;
      /** NFL week the move is for - always next week; further out is a decision for later. */
      week: number;
      holes: Hole[];
      alternatives: WaiverMove[];
      bid: BidAdvice | null;
      /** Who to cut if you add him now instead of waiting. */
      cut: string | null;
      /** What that cut costs your weighted lineup per week. */
      nowCost: number;
    }
  | { kind: "return"; playerId: string; week: number; cut: string | null };

export interface PlanInput {
  ctx: SearchContext;
  query: WaiverQuery;
  availability: (playerId: string) => Availability;
  bid: (move: WaiverMove, alternatives: WaiverMove[]) => BidAdvice | null;
  lineup: LineupFix | null;
  /** Reserve players no longer eligible for IR. */
  healthyInIr: string[];
  /** Your active players who can go to IR now. */
  irEligible: string[];
  /** Window week index each reserve player is projected back. */
  returns: Array<{ playerId: string; weekIndex: number }>;
}

export async function buildPlan(input: PlanInput): Promise<PlanStep[]> {
  const steps: PlanStep[] = [];
  const { ctx, query } = input;
  const max = config.waiver.maxPlanMoves;

  if (input.lineup) steps.push({ kind: "lineup", fix: input.lineup });

  let roster: TeamRoster = { ...ctx.mine, players: [...ctx.mine.players], reserve: [...ctx.mine.reserve] };
  let irEligible = [...input.irEligible];
  const keep = new Set(query.keep ?? []);
  const taken = new Set(ctx.taken ?? []);
  let transactions = 0;

  // A player who is in IR without a designation has to come out - and on a full
  // roster that takes a cut, which may be him. Done first, so every later step
  // is planned on a roster Sleeper would accept.
  const activate = (id: string): string | null => {
    roster = { ...roster, reserve: roster.reserve.filter((x) => x !== id) };
    if (activePlayers(roster).length <= ctx.base.activeLimit) return null;
    const cut = cutCandidates(ctx.base, ctx.table, roster, ctx.weights, keep, ctx.weekZero)[0]?.playerId ?? null;
    if (cut) roster = { ...roster, players: roster.players.filter((x) => x !== cut) };
    return cut;
  };
  for (const id of input.healthyInIr) steps.push({ kind: "ir-healthy", playerId: id, cut: activate(id) });

  // A pinned drop applies until a step uses it; after that he is gone.
  let pinnedDrop = query.drop ?? null;
  const search = async () =>
    findMoves(
      { ...ctx, mine: roster, irEligible, taken },
      { ...query, keep: [...keep], add: null, drop: pinnedDrop, limit: 60 },
    );
  const movedToIr: string[] = [];

  // 3 + 4: greedy over moves that pay now. Each step re-searches the new roster.
  let moves = (await search()).moves;
  while (transactions < max) {
    const move = moves.find((m) => !canWait(m));
    if (!move) break;

    const availability = input.availability(move.add);
    if (move.irMove) {
      steps.push({ kind: "ir-move", playerId: move.irMove });
      irEligible = irEligible.filter((id) => id !== move.irMove);
      roster = { ...roster, reserve: [...roster.reserve, move.irMove] };
      movedToIr.push(move.irMove);
    }
    if (availability.mode === "free_agent") {
      steps.push({ kind: "add", move, availability, roster });
    } else {
      // Fallbacks: the next-best adds for the same job (same position) that would
      // use the same drop. The bid is priced against the move's own peers, the
      // same set its card uses.
      const pos = ctx.base.players.get(move.add)?.position;
      const fallbacks = moves
        .filter(
          (m) =>
            m.add !== move.add &&
            m.drop === move.drop &&
            ctx.base.players.get(m.add)?.position === pos &&
            !canWait(m) &&
            m.gain >= config.waiver.minGainPerWeek,
        )
        .slice(0, 2);
      steps.push({ kind: "claim", move, availability, bid: input.bid(move, move.alternatives), fallbacks, roster });
    }
    transactions++;
    if (move.drop === pinnedDrop) pinnedDrop = null;
    roster = { ...roster, players: [...roster.players.filter((id) => id !== move.drop), move.add] };
    keep.add(move.add);
    taken.add(move.add);
    moves = (await search()).moves;
  }

  // 5: next week's streams, on the roster as the steps above leave it - a hole
  // an earlier add already fills is not a hole. Each is applied to a working
  // roster as it is planned, so two of them never count on the same cut.
  // Streams further out are left in the move list: a lot changes before then.
  let later = 0;
  for (const move of moves.filter((m) => canWait(m) && m.peakWeek === 1)) {
    if (later >= 2) break;
    const pos = ctx.base.players.get(move.add)?.position ?? "";
    const holes = holesForWeek(ctx.base, ctx.table, roster, 1, ctx.weekZero).filter((h) => h.eligible.includes(pos));
    if (!holes.length && steps.some((s) => s.kind === "later")) continue;
    const full = activePlayers(roster).length >= ctx.base.activeLimit;
    const cut = full ? (cutCandidates(ctx.base, ctx.table, roster, ctx.weights, keep, ctx.weekZero)[0] ?? null) : null;
    steps.push({
      kind: "later",
      move,
      availability: input.availability(move.add),
      week: ctx.base.weeks[1] ?? 0,
      holes,
      alternatives: move.alternatives.slice(0, 3),
      bid: input.bid(move, move.alternatives),
      cut: cut?.playerId ?? null,
      nowCost: cut?.cost ?? 0,
    });
    later++;
    roster = { ...roster, players: [...roster.players.filter((id) => id !== cut?.playerId), move.add] };
    keep.add(move.add);
    taken.add(move.add);
  }

  // 6: players coming back from IR need an active spot - the ones already in IR
  // and any the plan just moved there. He is in the cut pool himself: activating
  // a worse player by cutting a better one is not the plan. Each takes its own cut.
  const returns = [...input.returns];
  for (const id of movedToIr) {
    const back = returnWeek(ctx, id, 1);
    if (back != null) returns.push({ playerId: id, weekIndex: back });
  }
  for (const r of returns.sort((a, b) => a.weekIndex - b.weekIndex)) {
    if (!roster.reserve.includes(r.playerId)) continue;
    steps.push({ kind: "return", playerId: r.playerId, week: ctx.base.weeks[r.weekIndex] ?? 0, cut: activate(r.playerId) });
  }

  return steps;
}

/**
 * The window week an injured player is really back: the first week he projects
 * at least half his healthy level (and three points). Sleeper gives some IR
 * players token projections every week (2 points, live 2026-10-21), and a
 * player who can stay in IR does not need a spot.
 */
export function returnWeek(ctx: Pick<SearchContext, "base">, id: string, from = 0): number | null {
  const weekly = ctx.base.players.get(id)?.weekly ?? [];
  const healthy = Math.max(0, ...weekly);
  const i = weekly.findIndex((x, k) => k >= from && x >= Math.max(3, healthy * 0.5));
  return i >= 0 ? i : null;
}

/** A stream whose week is not this one can be claimed in the next run instead. */
export function canWait(m: WaiverMove): boolean {
  return m.waitable;
}
