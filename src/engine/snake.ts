/**
 * Draft order math.
 *
 * Everything downstream — especially VONA, which asks "will this player survive to
 * my next pick?" — is only as good as this file. It handles pure snake, Sleeper's
 * `reversal_round` (third-round-reversal and friends), linear drafts, and picks
 * that changed hands via trade.
 */

import type { Draft, TradedPick } from "../sleeper/types.ts";

export interface DraftShape {
  teams: number;
  rounds: number;
  type: "snake" | "linear" | "auction" | string;
  /** 0 = pure snake. N > 0 = direction flips again from round N onward. */
  reversalRound: number;
  /** slot (1-indexed) -> roster_id */
  slotToRoster: Map<number, number>;
  /** roster_id -> slot */
  rosterToSlot: Map<number, number>;
  /** "round:originalRosterId" -> current owner roster_id */
  tradedPicks: Map<string, number>;
}

export function buildDraftShape(draft: Draft, traded: TradedPick[] = []): DraftShape {
  const teams = draft.settings.teams ?? Object.keys(draft.slot_to_roster_id ?? {}).length ?? 12;
  const rounds = draft.settings.rounds ?? 15;

  const slotToRoster = new Map<number, number>();
  const rosterToSlot = new Map<number, number>();
  for (const [slot, rosterId] of Object.entries(draft.slot_to_roster_id ?? {})) {
    const s = Number(slot);
    slotToRoster.set(s, rosterId);
    rosterToSlot.set(rosterId, s);
  }

  const tradedPicks = new Map<string, number>();
  for (const t of traded) {
    // Sleeper scopes traded picks by season; a draft only ever concerns its own.
    if (t.season && draft.season && t.season !== draft.season) continue;
    tradedPicks.set(`${t.round}:${t.roster_id}`, t.owner_id);
  }

  return {
    teams,
    rounds,
    type: draft.type,
    reversalRound: draft.settings.reversal_round ?? 0,
    slotToRoster,
    rosterToSlot,
    tradedPicks,
  };
}

/**
 * Does round `round` run slot 1 -> N (true) or N -> 1 (false)?
 *
 * Pure snake alternates from round 1 forward. `reversalRound = 3` gives the common
 * "third round reversal": rounds 1-2 snake normally, then round 3 repeats the
 * reverse direction and the alternation continues from there.
 */
export function isForwardRound(round: number, shape: Pick<DraftShape, "type" | "reversalRound">): boolean {
  if (shape.type === "linear") return true;
  const normallyForward = round % 2 === 1;
  const flipped = shape.reversalRound > 0 && round >= shape.reversalRound;
  return normallyForward !== flipped;
}

/** Overall pick number (1-indexed) -> the round it falls in. */
export function roundOfPick(pickNo: number, teams: number): number {
  return Math.floor((pickNo - 1) / teams) + 1;
}

/** Overall pick number (1-indexed) -> draft slot (1-indexed). */
export function slotOfPick(pickNo: number, shape: DraftShape): number {
  const round = roundOfPick(pickNo, shape.teams);
  const indexInRound = (pickNo - 1) % shape.teams;
  return isForwardRound(round, shape) ? indexInRound + 1 : shape.teams - indexInRound;
}

/**
 * Which roster actually picks at `pickNo`, after trades.
 * Returns null if the slot has no roster mapping yet (pre-draft, order unset).
 */
export function rosterOfPick(pickNo: number, shape: DraftShape): number | null {
  const slot = slotOfPick(pickNo, shape);
  const original = shape.slotToRoster.get(slot);
  if (original == null) return null;
  const round = roundOfPick(pickNo, shape.teams);
  return shape.tradedPicks.get(`${round}:${original}`) ?? original;
}

export const totalPicks = (shape: DraftShape): number => shape.teams * shape.rounds;

/** Every overall pick number belonging to `rosterId`, in order. */
export function picksForRoster(rosterId: number, shape: DraftShape): number[] {
  const out: number[] = [];
  for (let pickNo = 1; pickNo <= totalPicks(shape); pickNo++) {
    if (rosterOfPick(pickNo, shape) === rosterId) out.push(pickNo);
  }
  return out;
}

export interface TurnInfo {
  /** The pick currently on the clock (1-indexed). */
  currentPick: number;
  currentRound: number;
  /** Roster on the clock, or null once the draft is over. */
  onTheClock: number | null;
  /** Your upcoming picks, soonest first. Empty when you're done. */
  myUpcomingPicks: number[];
  /** Your next pick, or null if you have none left. */
  myNextPick: number | null;
  /** The pick after that — the horizon VONA measures against. */
  myPickAfterNext: number | null;
  /** 0 means you are on the clock right now. null if you have no picks left. */
  picksUntilMyTurn: number | null;
  /** How many selections happen between your next pick and the one after. */
  gapToFollowingPick: number | null;
  isMyTurn: boolean;
  isComplete: boolean;
}

/**
 * Where the draft stands. `madePicks` is the count of picks already made, which is
 * what /draft/{id}/picks gives us directly.
 */
export function getTurnInfo(madePicks: number, myRosterId: number, shape: DraftShape): TurnInfo {
  const total = totalPicks(shape);
  const currentPick = madePicks + 1;
  const isComplete = currentPick > total;

  const myPicks = picksForRoster(myRosterId, shape);
  const myUpcomingPicks = myPicks.filter((p) => p >= currentPick);
  const myNextPick = myUpcomingPicks[0] ?? null;
  const myPickAfterNext = myUpcomingPicks[1] ?? null;

  return {
    currentPick: isComplete ? total : currentPick,
    currentRound: roundOfPick(Math.min(currentPick, total), shape.teams),
    onTheClock: isComplete ? null : rosterOfPick(currentPick, shape),
    myUpcomingPicks,
    myNextPick,
    myPickAfterNext,
    picksUntilMyTurn: myNextPick == null ? null : myNextPick - currentPick,
    gapToFollowingPick:
      myNextPick != null && myPickAfterNext != null ? myPickAfterNext - myNextPick : null,
    isMyTurn: myNextPick === currentPick && !isComplete,
    isComplete,
  };
}

/** Resolve your roster_id from the draft order. Falls back to the rosters join. */
export function myRosterIdFromDraft(draft: Draft, userId: string): number | null {
  const slot = draft.draft_order?.[userId];
  if (slot == null) return null;
  return draft.slot_to_roster_id?.[String(slot)] ?? null;
}
