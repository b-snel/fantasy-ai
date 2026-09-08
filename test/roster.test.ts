import { test, expect, describe } from "bun:test";
import { parseRosterPositions } from "../src/engine/replacement.ts";
import { describeRoster, evaluateRoster, type OwnedPlayer } from "../src/engine/roster.ts";

const REQ = parseRosterPositions([
  "QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF",
  "BN", "BN", "BN", "BN", "BN", "BN",
]);

describe("evaluateRoster", () => {
  test("an empty roster leaves every starting slot unfilled", () => {
    const state = evaluateRoster([], REQ, 15);
    expect(state.needs.RB.unfilled).toBe(2);
    expect(state.needs.QB.unfilled).toBe(1);
    expect(state.filledStarterSlots).toBe(0);
    expect(state.totalStarterSlots).toBe(8);
    expect(describeRoster(state)).toBe("empty");
  });

  test("counts owned players and closes slots", () => {
    const owned: OwnedPlayer[] = [
      { playerId: "1", position: "RB", team: "SF", byeWeek: 9 },
      { playerId: "2", position: "RB", team: "KC", byeWeek: 10 },
      { playerId: "3", position: "WR", team: "SF", byeWeek: 9 },
    ];
    const state = evaluateRoster(owned, REQ, 12);
    expect(state.countsByPosition.RB).toBe(2);
    expect(state.needs.RB.unfilled).toBe(0);
    expect(state.needs.WR.unfilled).toBe(1);
    expect(describeRoster(state)).toBe("RB2 WR1");
  });

  test("urgency rises as picks run out", () => {
    const early = evaluateRoster([], REQ, 15);
    const mid = evaluateRoster([], REQ, 6);
    const late = evaluateRoster([], REQ, 2);
    expect(mid.needs.QB.urgency).toBeGreaterThan(early.needs.QB.urgency);
    expect(late.needs.QB.urgency).toBeGreaterThan(mid.needs.QB.urgency);
  });

  test("urgency saturates once you have no runway left", () => {
    // One unfilled slot and one pick remaining is as urgent as it gets.
    expect(evaluateRoster([], REQ, 1).needs.QB.urgency).toBe(1);
  });

  test("the ramp bites well before the last pick", () => {
    // A linear ramp under-reacted until the startable players were already gone.
    // With two receiver slots open and six picks left this should already be loud.
    const state = evaluateRoster([], REQ, 6);
    expect(state.needs.WR.urgency).toBeGreaterThan(0.6);
  });

  test("a filled position with a flex outlet keeps residual value", () => {
    const owned: OwnedPlayer[] = [
      { playerId: "1", position: "RB", team: "SF", byeWeek: 9 },
      { playerId: "2", position: "RB", team: "KC", byeWeek: 10 },
    ];
    const state = evaluateRoster(owned, REQ, 10);
    expect(state.needs.RB.unfilled).toBe(0);
    expect(state.needs.RB.urgency).toBeGreaterThan(0); // FLEX can still absorb a RB
  });

  test("tracks bye-week concentration", () => {
    const owned: OwnedPlayer[] = [
      { playerId: "1", position: "RB", team: "SF", byeWeek: 9 },
      { playerId: "2", position: "WR", team: "SF", byeWeek: 9 },
      { playerId: "3", position: "TE", team: "KC", byeWeek: 10 },
    ];
    const state = evaluateRoster(owned, REQ, 10);
    expect(state.byeLoad.get(9)).toBe(2);
    expect(state.byeLoad.get(10)).toBe(1);
  });

  test("tracks NFL teams for stack detection", () => {
    const state = evaluateRoster(
      [{ playerId: "1", position: "QB", team: "BUF", byeWeek: 7 }],
      REQ,
      10,
    );
    expect(state.teams.has("BUF")).toBe(true);
    expect(state.teams.has("SF")).toBe(false);
  });

  test("ignores players at non-fantasy positions", () => {
    const state = evaluateRoster(
      [{ playerId: "1", position: "LS", team: "SF", byeWeek: 9 }],
      REQ,
      10,
    );
    expect(state.filledStarterSlots).toBe(0);
  });
});
