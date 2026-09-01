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

describe("tier size cap", () => {
  test("splits a long flat run into comprehensible tiers", () => {
    // A pure gap rule lumps 30 near-identical players into one tier, and
    // "30 left in tier 1" is not information anyone can act on.
    const flat: TieredPlayer[] = Array.from({ length: 30 }, (_, i) => ({
      playerId: `p${i}`,
      position: "WR",
      points: 200 - i, // 1-point gaps, far below the 12-point threshold
    }));
    const tiers = assignTiers(flat, GAPS, 12);
    const sizes = new Map<number, number>();
    for (const t of tiers.values()) sizes.set(t.tier, (sizes.get(t.tier) ?? 0) + 1);

    expect(sizes.size).toBeGreaterThan(1);
    for (const size of sizes.values()) expect(size).toBeLessThanOrEqual(8);
  });

  test("a real gap still takes precedence over the size cap", () => {
    const players: TieredPlayer[] = [
      { playerId: "a", position: "WR", points: 300 },
      { playerId: "b", position: "WR", points: 250 }, // 50-point cliff
      { playerId: "c", position: "WR", points: 249 },
    ];
    const tiers = assignTiers(players, GAPS, 12);
    expect(tiers.get("a")!.tier).toBe(1);
    expect(tiers.get("b")!.tier).toBe(2);
    expect(tiers.get("c")!.tier).toBe(2);
  });

  test("the cap is configurable", () => {
    const flat: TieredPlayer[] = Array.from({ length: 6 }, (_, i) => ({
      playerId: `p${i}`,
      position: "WR",
      points: 200 - i,
    }));
    const tiers = assignTiers(flat, GAPS, 12, 2);
    expect(tiers.get("p0")!.tier).toBe(1);
    expect(tiers.get("p2")!.tier).toBe(2);
    expect(tiers.get("p4")!.tier).toBe(3);
  });
});
