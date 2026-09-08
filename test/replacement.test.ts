import { test, expect, describe } from "bun:test";
import {
  parseRosterPositions,
  replacementPoints,
  replacementRanks,
  startersPerPosition,
} from "../src/engine/replacement.ts";

const STANDARD = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF",
  "BN", "BN", "BN", "BN", "BN", "BN"];

describe("parseRosterPositions", () => {
  test("separates starters, flex and bench", () => {
    const req = parseRosterPositions(STANDARD);
    expect(req.starters).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 });
    expect(req.flex).toEqual({ FLEX: 1 });
    expect(req.benchSlots).toBe(6);
    expect(req.totalRosterSize).toBe(15);
  });

  test("excludes IR and taxi slots from the active roster", () => {
    const req = parseRosterPositions([...STANDARD, "IR", "IR", "TAXI"]);
    expect(req.benchSlots).toBe(6);
    expect(req.starters.QB).toBe(1);
  });

  test("counts superflex separately from standard flex", () => {
    const req = parseRosterPositions(["QB", "RB", "WR", "FLEX", "SUPER_FLEX", "BN"]);
    expect(req.flex).toEqual({ FLEX: 1, SUPER_FLEX: 1 });
  });
});

describe("replacement level", () => {
  test("12-team 2RB+flex puts RB replacement near RB30", () => {
    const req = parseRosterPositions(STANDARD);
    const ranks = replacementRanks(req, 12);
    // 12 teams x (2 dedicated + 0.5 of one flex) = 30
    expect(ranks.RB).toBe(30);
    // 12 x (2 + 0.45) = 29.4 -> 29
    expect(ranks.WR).toBe(29);
    expect(ranks.QB).toBe(12);
    expect(ranks.TE).toBe(13); // 12 x 1.05
  });

  test("superflex pushes QB replacement much deeper", () => {
    const req = parseRosterPositions([...STANDARD, "SUPER_FLEX"]);
    const ranks = replacementRanks(req, 12);
    expect(ranks.QB).toBeGreaterThan(20);
  });

  test("smaller leagues have shallower replacement levels", () => {
    const req = parseRosterPositions(STANDARD);
    expect(replacementRanks(req, 10).RB).toBeLessThan(replacementRanks(req, 14).RB);
  });

  test("fractional starters never round below one", () => {
    const req = parseRosterPositions(["QB", "BN"]);
    const ranks = replacementRanks(req, 12);
    expect(ranks.TE).toBe(1);
  });

  test("startersPerPosition distributes flex across eligible positions", () => {
    const req = parseRosterPositions(STANDARD);
    const starters = startersPerPosition(req, 1);
    expect(starters.RB + starters.WR + starters.TE).toBeCloseTo(2 + 2 + 1 + 1, 5);
  });
});

describe("replacementPoints", () => {
  test("reads the Nth-best projection at each position", () => {
    const byPos = new Map<string, number[]>([
      ["RB", [300, 280, 260, 240, 220]],
      ["QB", [400, 380, 360]],
    ]);
    const pts = replacementPoints(byPos, { RB: 3, QB: 2, WR: 1, TE: 1, K: 1, DEF: 1 });
    expect(pts.RB).toBe(260);
    expect(pts.QB).toBe(380);
  });

  test("clamps to the shallowest available player when the pool is thin", () => {
    const byPos = new Map<string, number[]>([["TE", [200, 150]]]);
    const pts = replacementPoints(byPos, { RB: 1, QB: 1, WR: 1, TE: 30, K: 1, DEF: 1 });
    expect(pts.TE).toBe(150);
  });
});
