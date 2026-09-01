import { test, expect, describe } from "bun:test";
import type { Draft, TradedPick } from "../src/sleeper/types.ts";
import {
  buildDraftShape,
  getTurnInfo,
  isForwardRound,
  picksForRoster,
  rosterOfPick,
  roundOfPick,
  slotOfPick,
  myRosterIdFromDraft,
} from "../src/engine/snake.ts";

/** A 12-team draft where slot N maps to roster N — keeps the arithmetic readable. */
function makeDraft(overrides: Partial<Draft> = {}, teams = 12, rounds = 15): Draft {
  const slotToRoster: Record<string, number> = {};
  const draftOrder: Record<string, number> = {};
  for (let s = 1; s <= teams; s++) {
    slotToRoster[String(s)] = s;
    draftOrder[`user${s}`] = s;
  }
  return {
    draft_id: "d1",
    league_id: "l1",
    sport: "nfl",
    season: "2026",
    season_type: "regular",
    type: "snake",
    status: "drafting",
    draft_order: draftOrder,
    slot_to_roster_id: slotToRoster,
    settings: { teams, rounds, reversal_round: 0 },
    ...overrides,
  };
}

describe("round/slot arithmetic", () => {
  const shape = buildDraftShape(makeDraft());

  test("maps overall pick numbers to rounds", () => {
    expect(roundOfPick(1, 12)).toBe(1);
    expect(roundOfPick(12, 12)).toBe(1);
    expect(roundOfPick(13, 12)).toBe(2);
    expect(roundOfPick(24, 12)).toBe(2);
    expect(roundOfPick(25, 12)).toBe(3);
  });

  test("odd rounds run forward, even rounds run back", () => {
    expect(slotOfPick(1, shape)).toBe(1);
    expect(slotOfPick(12, shape)).toBe(12);
    expect(slotOfPick(13, shape)).toBe(12); // round 2 starts where round 1 ended
    expect(slotOfPick(24, shape)).toBe(1);
    expect(slotOfPick(25, shape)).toBe(1); // round 3 forward again
  });

  test("every slot is used exactly once per round", () => {
    for (let round = 1; round <= 15; round++) {
      const slots = new Set<number>();
      for (let i = 0; i < 12; i++) slots.add(slotOfPick((round - 1) * 12 + i + 1, shape));
      expect(slots.size).toBe(12);
    }
  });
});

describe("reversal_round (third-round reversal)", () => {
  const shape = buildDraftShape(makeDraft({ settings: { teams: 12, rounds: 15, reversal_round: 3 } }));

  test("rounds 1-2 snake normally, then round 3 repeats the reverse direction", () => {
    expect(isForwardRound(1, shape)).toBe(true);
    expect(isForwardRound(2, shape)).toBe(false);
    expect(isForwardRound(3, shape)).toBe(false); // the reversal
    expect(isForwardRound(4, shape)).toBe(true);
    expect(isForwardRound(5, shape)).toBe(false);
  });

  test("the slot-1 team picks back-to-back across the 2/3 boundary", () => {
    // Round 2 ends at slot 1 (pick 24); round 3 also starts at slot 12 under 3RR,
    // so the wheel team at slot 12 gets 13 and 25 is slot 12's again.
    expect(slotOfPick(24, shape)).toBe(1);
    expect(slotOfPick(25, shape)).toBe(12);
    expect(slotOfPick(36, shape)).toBe(1);
  });

  test("linear drafts never reverse", () => {
    const linear = buildDraftShape(makeDraft({ type: "linear" }));
    expect(isForwardRound(2, linear)).toBe(true);
    expect(slotOfPick(13, linear)).toBe(1);
  });
});

describe("roster ownership and trades", () => {
  test("untraded picks belong to the slot's roster", () => {
    const shape = buildDraftShape(makeDraft());
    expect(rosterOfPick(1, shape)).toBe(1);
    expect(rosterOfPick(13, shape)).toBe(12);
  });

  test("a traded pick moves to its new owner", () => {
    // Roster 5 traded its round-2 pick to roster 9.
    const traded: TradedPick[] = [
      { season: "2026", round: 2, roster_id: 5, owner_id: 9, previous_owner_id: 5 },
    ];
    const shape = buildDraftShape(makeDraft(), traded);
    const round2Pick = 12 + (12 - 5 + 1); // round 2 runs backwards: slot 5 is the 8th pick
    expect(slotOfPick(round2Pick, shape)).toBe(5);
    expect(rosterOfPick(round2Pick, shape)).toBe(9);
    // Roster 5 keeps its other rounds.
    expect(rosterOfPick(5, shape)).toBe(5);
  });

  test("traded picks from another season are ignored", () => {
    const traded: TradedPick[] = [
      { season: "2027", round: 2, roster_id: 5, owner_id: 9, previous_owner_id: 5 },
    ];
    const shape = buildDraftShape(makeDraft(), traded);
    expect(rosterOfPick(20, shape)).toBe(rosterOfPick(20, buildDraftShape(makeDraft())));
  });

  test("picksForRoster returns one pick per round for an untraded roster", () => {
    const shape = buildDraftShape(makeDraft());
    const picks = picksForRoster(3, shape);
    expect(picks.length).toBe(15);
    expect(picks[0]).toBe(3);
    expect(picks[1]).toBe(12 + (12 - 3 + 1)); // 22
    // Strictly increasing.
    for (let i = 1; i < picks.length; i++) expect(picks[i]!).toBeGreaterThan(picks[i - 1]!);
  });
});

describe("turn info", () => {
  const shape = buildDraftShape(makeDraft());

  test("reports picks until my turn from the middle of round 1", () => {
    // 2 picks made, so pick 3 is on the clock. Roster 5 picks at 5.
    const info = getTurnInfo(2, 5, shape);
    expect(info.currentPick).toBe(3);
    expect(info.currentRound).toBe(1);
    expect(info.onTheClock).toBe(3);
    expect(info.myNextPick).toBe(5);
    expect(info.picksUntilMyTurn).toBe(2);
    expect(info.isMyTurn).toBe(false);
  });

  test("detects my turn and the turn gap", () => {
    const info = getTurnInfo(4, 5, shape); // pick 5 on the clock, roster 5's pick
    expect(info.isMyTurn).toBe(true);
    expect(info.picksUntilMyTurn).toBe(0);
    expect(info.myPickAfterNext).toBe(20); // round 2, slot 5
    expect(info.gapToFollowingPick).toBe(15);
  });

  test("the turn (wheel) team has the shortest gap", () => {
    const info = getTurnInfo(11, 12, shape); // pick 12 on the clock
    expect(info.myNextPick).toBe(12);
    expect(info.myPickAfterNext).toBe(13); // back-to-back at the turn
    expect(info.gapToFollowingPick).toBe(1);
  });

  test("handles a completed draft", () => {
    const info = getTurnInfo(180, 5, shape);
    expect(info.isComplete).toBe(true);
    expect(info.myNextPick).toBeNull();
    expect(info.picksUntilMyTurn).toBeNull();
    expect(info.onTheClock).toBeNull();
  });
});

test("resolves my roster id from the draft order", () => {
  const draft = makeDraft();
  expect(myRosterIdFromDraft(draft, "user7")).toBe(7);
  expect(myRosterIdFromDraft(draft, "nobody")).toBeNull();
});
