import { test, expect, describe } from "bun:test";
import { assignTiers, tierCounts, type TieredPlayer } from "../src/engine/tiers.ts";

const GAPS = { RB: 12, WR: 12 };

describe("assignTiers", () => {
  test("starts a new tier when the drop exceeds the position threshold", () => {
    const players: TieredPlayer[] = [
      { playerId: "a", position: "RB", points: 300 },
      { playerId: "b", position: "RB", points: 295 }, // gap 5, same tier
      { playerId: "c", position: "RB", points: 260 }, // gap 35, new tier
      { playerId: "d", position: "RB", points: 255 },
    ];
    const tiers = assignTiers(players, GAPS, 12);
    expect(tiers.get("a")!.tier).toBe(1);
    expect(tiers.get("b")!.tier).toBe(1);
    expect(tiers.get("c")!.tier).toBe(2);
    expect(tiers.get("d")!.tier).toBe(2);
  });

  test("records the cliff below each player", () => {
    const tiers = assignTiers(
      [
        { playerId: "a", position: "RB", points: 300 },
        { playerId: "b", position: "RB", points: 260 },
      ],
      GAPS,
      12,
    );
    expect(tiers.get("a")!.cliffBelow).toBe(40);
    expect(tiers.get("b")!.cliffBelow).toBe(0); // nothing below
  });

  test("tiers positions independently", () => {
    const tiers = assignTiers(
      [
        { playerId: "rb1", position: "RB", points: 300 },
        { playerId: "wr1", position: "WR", points: 100 },
      ],
      GAPS,
      12,
    );
    expect(tiers.get("rb1")!.tier).toBe(1);
    expect(tiers.get("wr1")!.tier).toBe(1);
  });

  test("uses the default gap for positions without a threshold", () => {
    const tiers = assignTiers(
      [
        { playerId: "a", position: "P", points: 100 },
        { playerId: "b", position: "P", points: 80 },
      ],
      GAPS,
      12,
    );
    expect(tiers.get("b")!.tier).toBe(2);
  });

  test("is deterministic when players tie on points", () => {
    const players: TieredPlayer[] = [
      { playerId: "z", position: "RB", points: 200 },
      { playerId: "a", position: "RB", points: 200 },
    ];
    const first = assignTiers(players, GAPS, 12);
    const second = assignTiers([...players].reverse(), GAPS, 12);
    expect(first.get("a")!.tier).toBe(second.get("a")!.tier);
    expect(first.get("z")!.tier).toBe(second.get("z")!.tier);
  });

  test("handles an empty pool", () => {
    expect(assignTiers([], GAPS, 12).size).toBe(0);
  });
});

describe("tierCounts", () => {
  test("counts remaining players per position and tier", () => {
    const players: TieredPlayer[] = [
      { playerId: "a", position: "RB", points: 300 },
      { playerId: "b", position: "RB", points: 298 },
      { playerId: "c", position: "RB", points: 250 },
    ];
    const tiers = assignTiers(players, GAPS, 12);
    const counts = tierCounts(players, tiers);
    expect(counts.get("RB:1")).toBe(2);
    expect(counts.get("RB:2")).toBe(1);
  });

  test("reflects players being drafted away", () => {
    const players: TieredPlayer[] = [
      { playerId: "a", position: "RB", points: 300 },
      { playerId: "b", position: "RB", points: 298 },
    ];
    const tiers = assignTiers(players, GAPS, 12);
    expect(tierCounts(players.slice(1), tiers).get("RB:1")).toBe(1);
  });
});
