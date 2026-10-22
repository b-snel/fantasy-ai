/**
 * The waiver analyzer's engine.
 *
 * Tested the way the trade analyzer is. Hand-built universes pin down the
 * arithmetic where the right answer can be worked out on paper - the
 * no-free-streaming baseline, a candidate priced against a floor without him,
 * a bye that only a stream can fill, what may and may not be cut. The fixture
 * league checks the properties that only show up across a whole search and a
 * whole plan: every move clears the bar, nobody is added or cut twice, the plan
 * stays inside its transaction budget. Never the exact package - that is the
 * search's call.
 */

import { test, expect, describe } from "bun:test";
import { config } from "../src/config.ts";
import {
  fixtureWaiverSources,
  makeFixtureWaiverLeague,
  WAIVER_FIXTURE_MY_ROSTER,
  WAIVER_FIXTURE_NOW,
} from "../fixtures/waiver.ts";
import {
  buildUniverse,
  lineupSlots,
  rosterBreakdown,
  rosterValue,
  type TeamRoster,
  type TradePlayer,
  type TradeUniverse,
} from "../src/trade/value.ts";
import { floorTable, floorWithout, waiverUniverse, weeklyPoints, weekZero, type FloorTable } from "../src/waiver/universe.ts";
import {
  evaluateAdd,
  findMoves,
  WaiverQueryError,
  type SearchContext,
  type WaiverMove,
} from "../src/waiver/search.ts";
import { buildPlan, canWait, returnWeek, type PlanStep } from "../src/waiver/plan.ts";
import { cutCandidates, holesForWeek, lineupCheck } from "../src/waiver/streams.ts";
import { simulateSeason, weekLeverage, type SeasonInput } from "../src/waiver/odds.ts";
import { etToEpoch, type Availability } from "../src/waiver/availability.ts";
import { WaiverService, type PlanStepView, type WaiverAnalysis } from "../src/server/waivers.ts";

// ---------------------------------------------------------------------------
// Hand-built universes
// ---------------------------------------------------------------------------

interface Spec {
  slots: string[];
  /** Streaming floor per position, every week - only for direct valuation tests. */
  floor?: Record<string, number>;
  injuryRate?: number;
  activeLimit?: number;
  reserveLimit?: number;
  noFloorWeeks?: number;
  /** id -> [position, weekly points] */
  players: Record<string, [string, number[]]>;
  /** Which of `players` are on the wire; the floor table is built from these. */
  freeAgents?: string[];
}

function universe(spec: Spec): TradeUniverse {
  const weeks = Object.values(spec.players)[0]![1].map((_, i) => i + 1);
  const players = new Map<string, TradePlayer>();
  for (const [id, [position, weekly]] of Object.entries(spec.players)) {
    const rosTotal = weekly.reduce((a, b) => a + b, 0);
    players.set(id, {
      playerId: id,
      name: id,
      position,
      team: null,
      injuryStatus: null,
      weekly,
      rosTotal,
      byeWeek: null,
      playedThisWeek: false,
      marketValue: rosTotal,
    });
  }
  return {
    weeks,
    slots: lineupSlots(spec.slots),
    activeLimit: spec.activeLimit ?? 99,
    reserveLimit: spec.reserveLimit ?? 0,
    players,
    freeAgents: spec.freeAgents ?? [],
    waiverFloor: weeks.map(() => ({ ...(spec.floor ?? {}) })),
    replacementTotal: {},
    rosterSpotValue: 5,
    injuryRate: spec.injuryRate ?? 0,
    ...(spec.noFloorWeeks === undefined ? {} : { noFloorWeeks: spec.noFloorWeeks }),
  };
}

/** The floor table at a chosen depth. */
const tableAt = (u: TradeUniverse, depth: number): FloorTable => floorTable(u, depth);

const team = (rosterId: number, players: string[], reserve: string[] = []): TeamRoster => ({
  rosterId,
  players,
  reserve,
});

/** A search context over a hand-built universe: uniform weights, nothing locked, everyone helps now. */
function context(
  u: TradeUniverse,
  mine: TeamRoster,
  over: Partial<SearchContext> & { depth?: number } = {},
): SearchContext {
  const { depth, ...rest } = over;
  return {
    base: u,
    table: tableAt(u, depth ?? 1),
    weights: u.weeks.map(() => 1),
    mine,
    irEligible: [],
    locked: new Set(),
    startWeek: () => 0,
    ...rest,
  };
}

const freeAgent = (): Availability => ({
  mode: "free_agent",
  processesAt: null,
  locksAt: null,
  startWeek: 0,
  droppedBy: null,
  droppedAt: null,
});

const onWaivers = (): Availability => ({
  mode: "waivers",
  processesAt: WAIVER_FIXTURE_NOW + 3_600_000,
  locksAt: null,
  startWeek: 0,
  droppedBy: 7,
  droppedAt: WAIVER_FIXTURE_NOW - 3_600_000,
});

// ---------------------------------------------------------------------------
// The fixture league as the engine sees it
// ---------------------------------------------------------------------------

/**
 * The fixture league assembled into a search context the way the service builds
 * one (src/server/waivers.ts `build`), minus the parts these tests do not need:
 * no locks, everyone claimable this week, and the weights passed in.
 */
function fixtureSearch(weights?: number[]) {
  const fx = makeFixtureWaiverLeague();
  const rosters = fx.trade.rosters.map((r) => team(r.roster_id, [...(r.players ?? [])], [...(r.reserve ?? [])]));
  const base = buildUniverse({
    league: fx.trade.league,
    rosters,
    players: fx.trade.players,
    weekly: fx.trade.weekly,
    weeks: fx.trade.weeks,
    byeWeek: fx.trade.byeWeek,
  });
  const table = floorTable(base);
  const mine = rosters.find((r) => r.rosterId === WAIVER_FIXTURE_MY_ROSTER)!;
  const ctx: SearchContext = {
    base,
    table,
    weights: weights ?? base.weeks.map(() => 1),
    mine,
    irEligible: [],
    locked: new Set(),
    startWeek: () => 0,
  };
  return { fx, rosters, base, table, mine, ctx };
}

// ---------------------------------------------------------------------------

describe("the waiver universe", () => {
  test("in a no-floor week, an empty starting slot scores nothing - the trade view streams it", () => {
    const spec: Spec = {
      slots: ["QB", "WR"],
      floor: { QB: 10, WR: 4 },
      injuryRate: 0.1,
      players: { wr: ["WR", [8]] },
    };
    // Trade: the QB slot is streamed at the floor (10, covered by the floor too).
    expect(rosterValue(universe(spec), ["wr"])).toBeCloseTo(10 + 0.9 * 8 + 0.1 * 4);
    // Waivers: nobody to start, nobody to get hurt - zero.
    expect(rosterValue(universe({ ...spec, noFloorWeeks: 99 }), ["wr"])).toBeCloseTo(0.9 * 8 + 0.1 * 4);
  });

  test("in a no-floor week, a starter below the floor still starts", () => {
    const u = universe({ slots: ["WR"], floor: { WR: 4 }, noFloorWeeks: 99, players: { weak: ["WR", [3, 3]] } });
    expect(rosterValue(u, ["weak"])).toBeCloseTo(6);
    expect(rosterBreakdown(u, ["weak"]).starts.get("weak")).toBe(2);
  });

  test("the injury term still uses the floor in a no-floor week", () => {
    const u = universe({
      slots: ["WR"],
      floor: { WR: 4 },
      injuryRate: 0.1,
      noFloorWeeks: 99,
      players: { starter: ["WR", [10]], weak: ["WR", [3]] },
    });
    expect(rosterValue(u, ["starter"])).toBeCloseTo(0.9 * 10 + 0.1 * 4);
    // He starts at 3, and when he misses the wire covers at 4.
    expect(rosterValue(u, ["weak"])).toBeCloseTo(0.9 * 3 + 0.1 * 4);
  });

  test("trades are untouched: noFloorWeeks undefined is the valuation worked by hand", () => {
    // Two weeks. Week 1: QB below the floor, RB2 below the FLEX floor. Week 2:
    // the WR is on bye with nobody behind him.
    const spec: Spec = {
      slots: ["QB", "RB", "WR", "FLEX"],
      floor: { QB: 15, RB: 6, WR: 5 },
      injuryRate: 0.1,
      players: {
        qb: ["QB", [12, 20]],
        rb1: ["RB", [14, 14]],
        rb2: ["RB", [4, 9]],
        wr: ["WR", [10, 0]],
      },
    };
    const ids = ["qb", "rb1", "rb2", "wr"];
    // Week 1: QB streamed 15 | RB 0.9*14+0.1*6 | WR 0.9*10+0.1*5 | FLEX streamed 6
    // Week 2: QB 0.9*20+0.1*15 | RB 13.2 | WR streamed 5 | FLEX 0.9*9+0.1*6
    const trade = 15 + 13.2 + 9.5 + 6 + (19.5 + 13.2 + 5 + 8.7);
    expect(rosterValue(universe(spec), ids)).toBeCloseTo(trade);
    expect(rosterValue(universe({ ...spec, noFloorWeeks: 0 }), ids)).toBeCloseTo(trade);
    // The same roster on the waiver baseline: weak starters start, the empty WR slot is 0.
    // Week 1: QB 0.9*12+0.1*15 | 13.2 | 9.5 | FLEX 0.9*4+0.1*6 ; Week 2: 19.5 | 13.2 | 0 | 8.7
    expect(rosterValue(universe({ ...spec, noFloorWeeks: 99 }), ids)).toBeCloseTo(12.3 + 13.2 + 9.5 + 4.2 + (19.5 + 13.2 + 8.7));
  });

  test("the floor is the Nth-best free agent, and taking players off the wire moves it down", () => {
    const u = universe({
      slots: ["WR"],
      players: { a: ["WR", [10]], b: ["WR", [7]], c: ["WR", [3]] },
      freeAgents: ["a", "b", "c"],
    });
    const first = tableAt(u, 1);
    expect(floorWithout(first, new Set())[0]!.WR).toBe(10);
    expect(floorWithout(first, new Set(["a"]))[0]!.WR).toBe(7);
    const second = tableAt(u, 2);
    expect(floorWithout(second, new Set())[0]!.WR).toBe(7);
    expect(floorWithout(second, new Set(["a"]))[0]!.WR).toBe(3);
    expect(floorWithout(second, new Set(["a", "b", "c"]))[0]!.WR).toBe(0);
    expect(waiverUniverse(u, second, new Set(["a"])).freeAgents).toEqual(["b", "c"]);
  });

  test("a candidate is not priced against himself", () => {
    // He is the best WR on the wire. Priced on a floor that includes him, his
    // only value - injury cover - cancels to zero. Without him the floor is 5.
    const u = universe({
      slots: ["WR"],
      injuryRate: 0.1,
      players: { starter: ["WR", [10]], a: ["WR", [8]], b: ["WR", [5]] },
      freeAgents: ["a", "b"],
    });
    const m = evaluateAdd(context(u, team(1, ["starter"])), "a")!;
    expect(m.drop).toBeNull();
    // (0.9*10 + 0.1*8) - (0.9*10 + 0.1*5)
    expect(m.gainThisWeek).toBeCloseTo(0.3);
    expect(m.gain).toBeCloseTo(0.3);
  });
});

describe("valuing a move", () => {
  test("a one-QB roster with its QB on bye next week ranks the QB stream above any depth move", async () => {
    const u = universe({
      slots: ["QB", "RB"],
      injuryRate: 0.05,
      activeLimit: 3,
      players: {
        qb: ["QB", [20, 0, 20]],
        rb: ["RB", [10, 10, 10]],
        rbBench: ["RB", [3, 3, 3]],
        faQb: ["QB", [12, 12, 12]],
        faRb: ["RB", [4, 4, 4]],
      },
      freeAgents: ["faQb", "faRb"],
    });
    u.players.get("qb")!.byeWeek = 2;
    const ctx = context(u, team(1, ["qb", "rb", "rbBench"]));

    const qb = evaluateAdd(ctx, "faQb")!;
    const depth = evaluateAdd(ctx, "faRb")!;
    expect(qb.gain).toBeGreaterThan(depth.gain);
    expect(qb.drop).toBe("rbBench");
    // Week index 1 is where his value is: 0.95*12 there, a sliver of QB cover elsewhere.
    expect(qb.weeklyDelta[1]).toBeCloseTo(11.4);
    expect(qb.kind).toBe("stream");
    expect(qb.peakWeek).toBe(1);
    expect(canWait(qb)).toBe(true);

    const found = await findMoves(ctx, {});
    expect(found.moves[0]!.add).toBe("faQb");
    expect(found.moves.some((m) => m.add === "faRb")).toBe(false);
  });

  test("the gain is over what you start, not over a stream you have not made", () => {
    // Two DEFs at 10 and 9 against yours at 6. The trade view would say your
    // slot already streams the 9, so the 10 is worth 1; on waivers he is worth 4.
    const u = universe({
      slots: ["DEF"],
      activeLimit: 2,
      players: { mine: ["DEF", [6, 6]], fa10: ["DEF", [10, 6]], fa9: ["DEF", [9, 6]] },
      freeAgents: ["fa10", "fa9"],
    });
    const ctx = context(u, team(1, ["mine"]));
    const m = evaluateAdd(ctx, "fa10")!;
    expect(m.gainThisWeek).toBe(4);
    expect(m.weeklyDelta).toEqual([4, 0]);

    const trade = { ...waiverUniverse(u, ctx.table, new Set(["fa10"])), noFloorWeeks: 0 };
    expect(weeklyPoints(trade, ["mine", "fa10"])[0]! - weeklyPoints(trade, ["mine"])[0]!).toBeCloseTo(1);
  });

  test("a claim that cannot beat his game this week adds nothing this week", async () => {
    const u = universe({
      slots: ["DEF"],
      activeLimit: 2,
      players: { mine: ["DEF", [6, 6]], fa10: ["DEF", [10, 10]] },
      freeAgents: ["fa10"],
    });
    const ctx = context(u, team(1, ["mine"]), { startWeek: (id) => (id === "fa10" ? 1 : 0) });
    const m = evaluateAdd(ctx, "fa10")!;
    expect(m.startWeek).toBe(1);
    expect(m.weeklyDelta[0]).toBe(0);
    expect(m.gainThisWeek).toBe(0);
    expect(m.weeklyDelta[1]).toBe(4);

    // With only this week weighted he is not even a candidate.
    const thisWeek = await findMoves({ ...ctx, weights: [1, 0] }, {});
    expect(thisWeek.considered).toBe(0);
    expect(thisWeek.moves).toEqual([]);
  });
});

describe("what a move may drop", () => {
  // Two WR starters, a bench of one useful backup and two junk players, and one
  // in IR. Adding the free agent bumps `mid` out of the lineup; the cheapest
  // cut is a junk player (cutting `mid` costs his injury cover).
  const u = universe({
    slots: ["WR", "WR"],
    injuryRate: 0.1,
    activeLimit: 4,
    reserveLimit: 1,
    players: {
      star: ["WR", [10, 10]],
      mid: ["WR", [5, 5]],
      junk1: ["WR", [1, 1]],
      junk2: ["WR", [1, 1]],
      hurt: ["WR", [0, 0]],
      fa: ["WR", [8, 8]],
    },
    freeAgents: ["fa"],
  });
  const mine = team(1, ["star", "mid", "junk1", "junk2", "hurt"], ["hurt"]);
  const drops = (m: WaiverMove | null) => (m?.dropOptions ?? []).map((o) => o.playerId);

  test("the cheapest cut is chosen, and a player in IR is never one", () => {
    const m = evaluateAdd(context(u, mine), "fa")!;
    expect(m.drop).toBe("junk1");
    expect(m.irMove).toBeNull();
    expect(drops(m)).not.toContain("hurt");
    expect(m.gain).toBeGreaterThan(0);
  });

  test("a kept player is never dropped", () => {
    const m = evaluateAdd(context(u, mine), "fa", { keep: new Set(["junk1"]) })!;
    expect(m.drop).toBe("junk2");
    expect(drops(m)).not.toContain("junk1");
    const all = evaluateAdd(context(u, mine), "fa", { keep: new Set(["junk1", "junk2", "mid"]) })!;
    expect(drops(all)).toEqual(["star"]);
  });

  test("a locked player cannot be dropped this week - but can be once the claim is for next week", () => {
    const locked = new Set(["junk1", "junk2"]);
    const now = evaluateAdd(context(u, mine, { locked }), "fa")!;
    expect(drops(now)).not.toContain("junk1");
    expect(drops(now)).not.toContain("junk2");
    const later = evaluateAdd(context(u, mine, { locked, startWeek: () => 1 }), "fa")!;
    expect(later.drop).toBe("junk1");
  });

  test("with an open active spot nobody is dropped", () => {
    const m = evaluateAdd(context({ ...u, activeLimit: 5 }, mine), "fa")!;
    expect(m.drop).toBeNull();
    expect(m.irMove).toBeNull();
    expect(m.dropOptions).toEqual([{ playerId: null, gain: m.gain }]);
  });

  test("an IR-eligible active player with a free reserve slot opens the spot instead", () => {
    const v = universe({
      slots: ["WR", "WR"],
      activeLimit: 3,
      reserveLimit: 1,
      players: { star: ["WR", [10, 10]], out: ["WR", [0, 0]], junk: ["WR", [1, 1]], fa: ["WR", [8, 8]] },
      freeAgents: ["fa"],
    });
    const m = evaluateAdd(context(v, team(1, ["star", "out", "junk"]), { irEligible: ["out"] }), "fa")!;
    expect(m.drop).toBeNull();
    expect(m.irMove).toBe("out");
    // Without the reserve slot the same add has to cut someone.
    const full = evaluateAdd(context({ ...v, reserveLimit: 0 }, team(1, ["star", "out", "junk"]), { irEligible: ["out"] }), "fa")!;
    expect(full.drop).not.toBeNull();
    expect(full.irMove).toBeNull();
  });
});

describe("findMoves", () => {
  test("on a deep wire, open-ended searches cap each position and a position filter lifts the cap", async () => {
    const players: Spec["players"] = { mine: ["WR", [2, 2]] };
    const fas: string[] = [];
    for (let i = 0; i < config.waiver.perPositionLimit + 4; i++) {
      players[`w${i}`] = ["WR", [10 + i, 10 + i]];
      fas.push(`w${i}`);
    }
    const u = universe({ slots: ["WR"], activeLimit: 2, players, freeAgents: fas });
    const ctx = context(u, team(1, ["mine"]));
    const open = await findMoves(ctx, {});
    expect(open.moves).toHaveLength(config.waiver.perPositionLimit);
    const wrs = await findMoves(ctx, { positions: ["WR"] });
    expect(wrs.moves).toHaveLength(fas.length);
    const gains = wrs.moves.map((m) => m.gain);
    expect(gains).toEqual([...gains].sort((a, b) => b - a));
  });

  test("on the fixture league: every move clears the bar, adds only free agents, sorted, capped per position", async () => {
    const { base, rosters, ctx } = fixtureSearch();
    const rostered = new Set(rosters.flatMap((r) => r.players));
    const n = base.weeks.length;
    const horizons = [
      base.weeks.map(() => 1),
      base.weeks.map((_, i) => (i === 0 ? 1 : 0)),
      base.weeks.map((_, i) => (i >= n - 3 ? 1 : 0)),
      base.weeks.map((_, i) => n - i),
    ];
    let listed = 0;
    for (const weights of horizons) {
      const result = await findMoves({ ...ctx, weights }, {});
      listed += result.moves.length;
      const perPosition = new Map<string, number>();
      for (const m of result.moves) {
        expect(m.gain).toBeGreaterThanOrEqual(config.waiver.minGainPerWeek);
        expect(rostered.has(m.add)).toBe(false);
        expect(base.freeAgents).toContain(m.add);
        if (m.drop) expect(ctx.mine.players).toContain(m.drop);
        const pos = base.players.get(m.add)!.position;
        perPosition.set(pos, (perPosition.get(pos) ?? 0) + 1);
      }
      for (const count of perPosition.values()) expect(count).toBeLessThanOrEqual(config.waiver.perPositionLimit);
      const gains = result.moves.map((m) => m.gain);
      expect(gains).toEqual([...gains].sort((a, b) => b - a));
    }
    // The fixture wire is thin, but not empty - otherwise this test checks nothing.
    expect(listed).toBeGreaterThan(0);
  });

  test("impossible requests are a clear error, not an empty result", async () => {
    const u = universe({
      slots: ["WR"],
      activeLimit: 2,
      reserveLimit: 1,
      players: { star: ["WR", [10]], junk: ["WR", [1]], hurt: ["WR", [0]], fa: ["WR", [8]] },
      freeAgents: ["fa"],
    });
    const ctx = context(u, team(1, ["star", "junk", "hurt"], ["hurt"]));
    await expect(findMoves(ctx, { drop: "fa" })).rejects.toThrow(WaiverQueryError);
    await expect(findMoves(ctx, { drop: "nobody" })).rejects.toThrow("not on your roster");
    await expect(findMoves(ctx, { drop: "hurt" })).rejects.toThrow("in IR");
    await expect(findMoves(ctx, { drop: "junk", keep: ["junk"] })).rejects.toThrow("both");
    await expect(findMoves(ctx, { add: "star" })).rejects.toThrow("not a free agent");
    // And the legal version of the same request works.
    const ok = await findMoves(ctx, { add: "fa", drop: "junk" });
    expect(ok.proposal?.drop).toBe("junk");
  });
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** Steps that are transactions this run. */
const transactionsOf = (steps: PlanStep[]) =>
  steps.filter((s): s is Extract<PlanStep, { kind: "add" | "claim" }> => s.kind === "add" || s.kind === "claim");

describe("the plan, hand-built", () => {
  test("a claim's fallbacks share its drop", async () => {
    // Three claims that each replace the same junk starter: one claim, two fallbacks.
    const u = universe({
      slots: ["WR", "WR"],
      activeLimit: 2,
      players: { star: ["WR", [10, 10]], junk: ["WR", [1, 1]], a: ["WR", [8, 8]], b: ["WR", [7, 7]], c: ["WR", [6, 6]] },
      freeAgents: ["a", "b", "c"],
    });
    const ctx = context(u, team(1, ["star", "junk"]));
    const steps = await buildPlan({
      ctx,
      query: {},
      availability: onWaivers,
      bid: () => null,
      lineup: null,
      healthyInIr: [],
      irEligible: [],
      returns: [],
    });
    const claims = steps.filter((s): s is Extract<PlanStep, { kind: "claim" }> => s.kind === "claim");
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.move.add).toBe("a");
    expect(claim.fallbacks.map((f) => f.add)).toEqual(["b", "c"]);
    for (const f of claim.fallbacks) expect(f.drop).toBe(claim.move.drop);
  });

  test("next week's bye hole is a next-run step with its own cut, not an add today", async () => {
    // Your only QB is on bye next week: the free-agent QB is worth one week, so
    // the plan says it can wait - and names the dead-weight cut if you grab him now.
    const u = universe({
      slots: ["QB", "WR"],
      activeLimit: 3,
      players: {
        qb: ["QB", [20, 0, 20]],
        star: ["WR", [10, 10, 10]],
        junk: ["WR", [1, 1, 1]],
        fq: ["QB", [15, 15, 15]],
      },
      freeAgents: ["fq"],
    });
    const steps = await buildPlan({
      ctx: context(u, team(1, ["qb", "star", "junk"])),
      query: {},
      availability: freeAgent,
      bid: () => null,
      lineup: null,
      healthyInIr: [],
      irEligible: [],
      returns: [],
    });
    expect(transactionsOf(steps)).toHaveLength(0);
    const later = steps.filter((s): s is Extract<PlanStep, { kind: "later" }> => s.kind === "later");
    expect(later).toHaveLength(1);
    expect(later[0]!.move.add).toBe("fq");
    expect(later[0]!.week).toBe(u.weeks[1]!);
    expect(later[0]!.cut).toBe("junk");
    expect(later[0]!.nowCost).toBeLessThan(0.1);
  });

  test("a pinned drop is used once; the rest of the plan goes on without it", async () => {
    const u = universe({
      slots: ["WR", "WR"],
      activeLimit: 3,
      players: {
        star: ["WR", [10, 10]],
        j1: ["WR", [1, 1]],
        j2: ["WR", [2, 2]],
        a: ["WR", [8, 8]],
        b: ["WR", [7, 7]],
      },
      freeAgents: ["a", "b"],
    });
    const steps = await buildPlan({
      ctx: context(u, team(1, ["star", "j1", "j2"])),
      query: { drop: "j2" },
      availability: freeAgent,
      bid: () => null,
      lineup: null,
      healthyInIr: [],
      irEligible: [],
      returns: [],
    });
    const tx = transactionsOf(steps);
    expect(tx[0]!.move.drop).toBe("j2");
    expect(tx.filter((s) => s.move.drop === "j2")).toHaveLength(1);
  });

  test("never more transactions than the budget, each player added or cut at most once", async () => {
    // More profitable moves than the plan allows: every junk starter can be upgraded.
    const n = config.waiver.maxPlanMoves + 2;
    const players: Spec["players"] = {};
    const mine: string[] = [];
    const fas: string[] = [];
    for (let i = 0; i < n; i++) {
      players[`j${i}`] = ["WR", [1, 1]];
      mine.push(`j${i}`);
    }
    for (let i = 0; i <= n; i++) {
      players[`f${i}`] = ["WR", [12 - i, 12 - i]];
      fas.push(`f${i}`);
    }
    const u = universe({ slots: Array(n).fill("WR"), activeLimit: n, players, freeAgents: fas });
    const steps = await buildPlan({
      ctx: context(u, team(1, mine)),
      query: {},
      availability: freeAgent,
      bid: () => null,
      lineup: null,
      healthyInIr: [],
      irEligible: [],
      returns: [],
    });
    const tx = transactionsOf(steps);
    expect(tx).toHaveLength(config.waiver.maxPlanMoves);
    expect(new Set(tx.map((s) => s.move.add)).size).toBe(tx.length);
    expect(new Set(tx.map((s) => s.move.drop)).size).toBe(tx.length);
    // Best first: each step took the best free agent the last one left.
    expect(tx.map((s) => s.move.add)).toEqual(fas.slice(0, tx.length));
  });
});

describe("the plan on the fixture league", () => {
  // Wednesday after the run (adds), and Sunday afternoon on the same league
  // (most games locked, so claims and next-run steps appear).
  const fx = makeFixtureWaiverLeague();
  const clocks = [WAIVER_FIXTURE_NOW, etToEpoch(2026, 10, 25, 14, 0)];
  const requests = [{}, { horizon: "season" as const }, { horizon: "week" as const }];

  async function plans(): Promise<Array<{ label: string; analysis: WaiverAnalysis }>> {
    const out: Array<{ label: string; analysis: WaiverAnalysis }> = [];
    for (const now of clocks) {
      const src = fixtureWaiverSources(fx);
      const svc = new WaiverService(src.trade, src.extras, null, () => now);
      for (const req of requests) {
        out.push({ label: `${new Date(now).toISOString()} ${JSON.stringify(req)}`, analysis: await svc.analyze(req) });
      }
    }
    return out;
  }
  const all = plans();
  const rostered = new Set(fx.trade.rosters.flatMap((r) => r.players ?? []));
  type MoveStep = Extract<PlanStepView, { kind: "add" | "claim" | "later" }>;
  const moveSteps = (plan: PlanStepView[]) =>
    plan.filter((s): s is MoveStep => s.kind === "add" || s.kind === "claim" || s.kind === "later");

  test("the scenarios exercise adds and claims", async () => {
    // Next-run steps need a hole next week, which the fixture roster does not
    // have; "the plan, hand-built" covers them.
    const kinds = new Set((await all).flatMap((p) => p.analysis.plan.map((s) => s.kind)));
    for (const k of ["lineup", "add", "claim"] as const) expect(kinds).toContain(k);
  });

  test("this run's transactions never add or drop the same player twice, and stay inside the budget", async () => {
    for (const { label, analysis } of await all) {
      const tx = analysis.plan.filter((s): s is Extract<PlanStepView, { kind: "add" | "claim" }> => s.kind === "add" || s.kind === "claim");
      expect({ label, n: tx.length <= config.waiver.maxPlanMoves }).toEqual({ label, n: true });
      const adds = tx.map((s) => s.move.add.playerId);
      const drops = tx.map((s) => s.move.drop?.playerId).filter((x): x is string => x != null);
      expect({ label, adds: new Set(adds).size }).toEqual({ label, adds: adds.length });
      expect({ label, drops: new Set(drops).size }).toEqual({ label, drops: drops.length });
    }
  });

  test("no step - this run's or the next run's - reuses a player or a roster spot another step already uses", async () => {
    // Following the whole plan has to be possible: two steps that cut the same
    // player, or both open their spot by moving the same player to IR, cannot
    // both go through.
    for (const { label, analysis } of await all) {
      const steps = moveSteps(analysis.plan);
      const adds = steps.map((s) => s.move.add.playerId);
      const room = steps
        .map((s) => s.move.drop?.playerId ?? (s.move.irMove ? `IR:${s.move.irMove.playerId}` : null))
        .filter((x): x is string => x != null);
      expect({ label, adds }).toEqual({ label, adds: [...new Set(adds)] });
      expect({ label, room }).toEqual({ label, room: [...new Set(room)] });
    }
  });

  test("every add is a free agent, a next-run step can wait, and claim fallbacks share the drop", async () => {
    for (const { analysis } of await all) {
      for (const s of moveSteps(analysis.plan)) {
        expect(rostered.has(s.move.add.playerId)).toBe(false);
        if (s.kind === "later") expect(s.move.canWait).toBe(true);
        if (s.kind === "add" || s.kind === "claim") expect(s.move.canWait).toBe(false);
        if (s.kind === "claim") {
          for (const f of s.fallbacks) expect(f.drop?.playerId ?? null).toBe(s.move.drop?.playerId ?? null);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// One week at a time
// ---------------------------------------------------------------------------

describe("holes, cuts and the lineup", () => {
  test("a bye with nobody behind him is a hole that week only", () => {
    const u = universe({
      slots: ["QB", "RB"],
      players: { qb: ["QB", [20, 0, 20]], rb: ["RB", [10, 10, 10]] },
    });
    u.players.get("qb")!.byeWeek = 2;
    const table = floorTable(u);
    const roster = team(1, ["qb", "rb"]);
    expect(holesForWeek(u, table, roster, 0)).toEqual([]);
    const holes = holesForWeek(u, table, roster, 1);
    expect(holes).toHaveLength(1);
    expect(holes[0]).toMatchObject({ weekIndex: 1, slot: "QB", reason: "bye", usual: "qb", best: null, bestPoints: 0 });
  });

  test("a player who never starts is the first cut, at no cost", () => {
    const u = universe({
      slots: ["WR"],
      injuryRate: 0.1,
      players: { star: ["WR", [10, 10]], backup: ["WR", [6, 6]], junk: ["WR", [1, 1]], fa: ["WR", [3, 3]] },
      freeAgents: ["fa"],
    });
    const cuts = cutCandidates(u, tableAt(u, 1), team(1, ["star", "backup", "junk"]), [1, 1]);
    expect(cuts.map((c) => c.playerId)).toEqual(["junk", "backup", "star"]);
    expect(cuts[0]!.cost).toBeCloseTo(0);
    expect(cuts[0]!.starts).toBe(0);
    // The backup is worth his cover over the wire: 0.1 * (6 - 3) a week.
    expect(cuts[1]!.cost).toBeCloseTo(0.3);
  });

  test("the fixture's benched starter is flagged, and locked players stay where they are", () => {
    const { fx, base, table, mine } = fixtureSearch();
    const raw = fx.trade.rosters.find((r) => r.roster_id === WAIVER_FIXTURE_MY_ROSTER)!;
    const starters = raw.starters ?? [];
    const positions = fx.trade.league.roster_positions;
    expect(starters).not.toContain(fx.benchedStarter);

    const fix = lineupCheck(base, table, mine, starters, positions, new Set())!;
    expect(fix).not.toBeNull();
    expect(fix.start.map((s) => s.playerId)).toContain(fx.benchedStarter);
    expect(fix.gain).toBeGreaterThan(0);
    const benchedFor = fix.sit[0]!.playerId;

    // The player keeping his seat has kicked off: he stays in, someone else sits.
    const lockedStarter = lineupCheck(base, table, mine, starters, positions, new Set([benchedFor]));
    expect(lockedStarter?.start.map((s) => s.playerId) ?? []).toContain(fx.benchedStarter);
    expect(lockedStarter?.sit.map((s) => s.playerId) ?? []).not.toContain(benchedFor);

    // The benched starter himself has kicked off on the bench: too late to start him.
    const lockedBench = lineupCheck(base, table, mine, starters, positions, new Set([fx.benchedStarter]));
    expect(lockedBench?.start.map((s) => s.playerId) ?? []).not.toContain(fx.benchedStarter);
  });
});

// ---------------------------------------------------------------------------
// Which weeks matter
// ---------------------------------------------------------------------------

/**
 * Eight teams, weeks 9-17, regular season through 14, four make the playoffs.
 * Team strength rises with roster id; records are passed in.
 */
function seasonInput(
  records: Record<number, [number, number]>,
  over: Partial<SeasonInput> = {},
): SeasonInput {
  const ids = [1, 2, 3, 4, 5, 6, 7, 8];
  const weeks = over.weeks ?? [9, 10, 11, 12, 13, 14, 15, 16, 17];
  const lastRegularWeek = over.lastRegularWeek ?? 14;
  const schedule = new Map<number, Array<[number, number]>>();
  weeks
    .filter((w) => w <= lastRegularWeek)
    .forEach((week, round) => {
      // Circle method: fix team 1, rotate the rest.
      const rest = ids.slice(1);
      const rot = [ids[0]!, ...rest.slice(round % rest.length), ...rest.slice(0, round % rest.length)];
      const pairs: Array<[number, number]> = [];
      for (let i = 0; i < rot.length / 2; i++) pairs.push([rot[i]!, rot[rot.length - 1 - i]!]);
      schedule.set(week, pairs);
    });
  return {
    weeks,
    lastRegularWeek,
    playoffTeams: 4,
    rosterIds: ids,
    standings: new Map(
      ids.map((id) => {
        const [wins, losses] = records[id] ?? [0, 0];
        return [id, { wins, losses, ties: 0, pointsFor: (wins + losses) * (90 + id * 3) }];
      }),
    ),
    schedule,
    expected: new Map(ids.map((id) => [id, weeks.map(() => 90 + id * 3)])),
    sd: 20,
    sims: 3000,
    seed: 11,
    ...over,
  };
}

describe("season odds and week leverage", () => {
  const even = { 1: [3, 3], 2: [3, 3], 3: [3, 3], 4: [3, 3], 5: [3, 3], 6: [3, 3], 7: [3, 3], 8: [3, 3] } as Record<number, [number, number]>;

  test("the simulation is deterministic for a seed", () => {
    const a = simulateSeason(seasonInput(even));
    const b = simulateSeason(seasonInput(even));
    expect([...a.playoffs]).toEqual([...b.playoffs]);
    expect([...a.title]).toEqual([...b.title]);
    expect([...a.wins]).toEqual([...b.wins]);
  });

  test("playoff odds add up to the number of playoff teams, titles to one", () => {
    const odds = simulateSeason(seasonInput(even));
    const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    expect(Math.abs(sum(odds.playoffs) - 4)).toBeLessThan(1e-9);
    expect(Math.abs(sum(odds.title) - 1)).toBeLessThan(1e-9);
  });

  test("a 6-0 strong team is likelier to make it than a 0-6 weak one", () => {
    // Team 8 is the strongest roster, team 1 the weakest.
    const odds = simulateSeason(seasonInput({ ...even, 8: [6, 0], 1: [0, 6] }));
    expect(odds.playoffs.get(8)!).toBeGreaterThan(odds.playoffs.get(1)!);
    expect(odds.playoffs.get(8)!).toBeGreaterThan(0.9);
    expect(odds.title.get(8)!).toBeGreaterThan(odds.title.get(1)!);
  });

  test("a near-eliminated team's weights are non-negative, average 1, and stable across seeds", () => {
    // Team 1, the weakest roster, at 1-7 with six regular-season weeks left.
    const records: Record<number, [number, number]> = { 1: [1, 7], 2: [3, 5], 3: [4, 4], 4: [4, 4], 5: [4, 4], 6: [5, 3], 7: [5, 3], 8: [6, 2] };
    const runs = [1, 2, 3].map((seed) =>
      weekLeverage(seasonInput(records, { seed, sims: config.waiver.sims }), 1, config.waiver.winValue),
    );
    expect(runs[0]!.playoffOdds).toBeLessThan(0.1);
    for (const l of runs) {
      expect(l.weights.every((w) => Number.isFinite(w) && w >= 0)).toBe(true);
      const mean = l.weights.reduce((a, b) => a + b, 0) / l.weights.length;
      expect(mean).toBeCloseTo(1, 9);
    }
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const diff = Math.max(...runs[i]!.weights.map((w, k) => Math.abs(w - runs[j]!.weights[k]!)));
        expect(diff).toBeLessThan(0.15);
      }
    }
  });

  test("an eliminated team with no per-win value gets uniform weights, never NaN", () => {
    // 0-12 with two regular-season weeks left while four teams are 10-2: no path in.
    const records: Record<number, [number, number]> = { 1: [0, 12], 2: [4, 8], 3: [5, 7], 4: [6, 6], 5: [10, 2], 6: [10, 2], 7: [10, 2], 8: [10, 2] };
    const l = weekLeverage(seasonInput(records, { weeks: [13, 14, 15, 16, 17] }), 1, 0);
    expect(l.playoffOdds).toBe(0);
    for (const xs of [l.raw, l.weights, l.alive]) expect(xs.every((x) => Number.isFinite(x))).toBe(true);
    expect(Number.isNaN(l.winWorth)).toBe(false);
    // Nothing moves the needle, so the fallback ran: every week counts the same.
    expect(l.raw.every((x) => x === 0)).toBe(true);
    expect(l.weights).toEqual(l.weights.map(() => 1));
  });
});

// ---------------------------------------------------------------------------
// The service on the fixture league
// ---------------------------------------------------------------------------

describe("WaiverService on the fixture league", () => {
  const fresh = () => {
    const fx = makeFixtureWaiverLeague();
    const src = fixtureWaiverSources(fx);
    return { fx, svc: new WaiverService(src.trade, src.extras, null, () => fx.now) };
  };
  const strip = <T extends object>(x: T, keys: string[]): unknown => {
    const copy = JSON.parse(JSON.stringify(x)) as Record<string, unknown>;
    for (const k of keys) delete copy[k];
    return copy;
  };

  test("overview and analysis are deterministic across fresh services", async () => {
    const a = fresh();
    const b = fresh();
    expect(strip(await a.svc.overview(), ["updatedAt"])).toEqual(strip(await b.svc.overview(), ["updatedAt"]));
    expect(strip(await a.svc.analyze({}), ["elapsedMs"])).toEqual(strip(await b.svc.analyze({}), ["elapsedMs"]));
  });

  test("analyzes quickly, and only ever adds free agents", async () => {
    const { fx, svc } = fresh();
    const started = performance.now();
    const analysis = await svc.analyze({});
    // ~150ms on a laptop including the season simulation; generous for CI.
    expect(performance.now() - started).toBeLessThan(5000);
    const rostered = new Set(fx.trade.rosters.flatMap((r) => r.players ?? []));
    expect(analysis.moves.length).toBeGreaterThan(0);
    for (const m of analysis.moves) expect(rostered.has(m.add.playerId)).toBe(false);
    for (const s of analysis.streams) for (const x of s.streams) expect(rostered.has(x.player.playerId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regressions from the 2026-10-21 review
// ---------------------------------------------------------------------------

describe("review regressions", () => {
  test("a starter who already played holds his slot: no phantom hole, no phantom gain", () => {
    // Your QB played Thursday - his week-0 projection now reads 0 - and a free
    // agent QB plays Sunday. The QB slot is not empty.
    const u = universe({
      slots: ["QB", "WR"],
      activeLimit: 3,
      players: {
        qbThu: ["QB", [0, 18, 18]],
        wr: ["WR", [10, 10, 10]],
        junk: ["WR", [1, 1, 1]],
        faQB: ["QB", [16, 14, 14]],
      },
      freeAgents: ["faQB"],
    });
    const mine = team(1, ["qbThu", "wr", "junk"]);
    const locked = new Set(["qbThu"]);
    const w0 = weekZero(u, ["QB", "WR", "BN"], ["qbThu", "wr"], locked);
    const m = evaluateAdd(context(u, mine, { locked, weekZero: w0 }), "faQB");
    expect(m?.weeklyDelta[0] ?? 0).toBe(0);
    expect(holesForWeek(u, tableAt(u, 1), mine, 0, w0)).toEqual([]);
    // Without the week-zero view the same roster reads as a hole - the bug.
    expect(holesForWeek(u, tableAt(u, 1), mine, 0).map((h) => h.slot)).toEqual(["QB"]);
  });

  test("bench lock is judged when the claim processes, and a pinned locked drop is refused", async () => {
    const u = universe({
      slots: ["WR"],
      activeLimit: 2,
      players: { star: ["WR", [10, 10]], thu: ["WR", [1, 1]], fa: ["WR", [12, 12]] },
      freeAgents: ["fa"],
    });
    // Not locked now, but locked by the time the claim on "fa" processes.
    const ctx = context(u, team(1, ["star", "thu"]), { canDrop: (_add, drop) => drop !== "thu" });
    expect(evaluateAdd(ctx, "fa")?.dropOptions.map((o) => o.playerId)).toEqual(["star"]);
    await expect(findMoves(ctx, { add: "fa", drop: "thu" })).rejects.toThrow("game has started");
  });

  test("this week's value is not given up to wait: under the week horizon nothing defers", () => {
    const u = universe({
      slots: ["QB"],
      activeLimit: 2,
      players: { qb: ["QB", [10, 0, 10, 10]], junk: ["WR", [1, 1, 1, 1]], fa: ["QB", [14, 10, 0, 0]] },
      freeAgents: ["fa"],
    });
    const mine = team(1, ["qb", "junk"]);
    const week = evaluateAdd(context(u, mine, { weights: [1, 0, 0, 0] }), "fa")!;
    expect(week.gainThisWeek).toBeCloseTo(4);
    expect(canWait(week)).toBe(false);
    // Over the season the same move is mostly next week's bye: that one can wait.
    const season = evaluateAdd(context(u, mine), "fa")!;
    expect(season.kind).toBe("stream");
    expect(season.peakWeek).toBe(1);
    expect(canWait(season)).toBe(false); // 4 of 14 points are this week - too much to give up
  });

  test("weeks past next week are streamed from the wire: no hoarding a defense for one playoff week", () => {
    // Your DEF is fine until week index 3; a free agent is 2 points better that
    // week, and the wire has another one just as good. With playoff-heavy
    // weights the no-floor valuation called that a big gain.
    const u = universe({
      slots: ["DEF"],
      activeLimit: 2,
      players: {
        d1: ["DEF", [8, 8, 8, 6]],
        junk: ["WR", [1, 1, 1, 1]],
        fd: ["DEF", [7, 7, 7, 8]],
        f2: ["DEF", [7, 7, 7, 8]],
      },
      freeAgents: ["fd", "f2"],
    });
    const playoffHeavy = [0.2, 0.2, 0.2, 5];
    const m = evaluateAdd(context(u, team(1, ["d1", "junk"]), { weights: playoffHeavy }), "fd");
    expect(m!.gain).toBeLessThan(config.waiver.minGainPerWeek);
    expect(m!.weeklyDelta[3]).toBeCloseTo(0);
  });

  test("an IR player's token projections are not a return; a real one is", () => {
    const u = universe({
      slots: ["WR"],
      players: { token: ["WR", [2, 0, 2.1, 1.9]], back: ["WR", [0, 6, 6.5, 8.8]] },
    });
    expect(returnWeek({ base: u }, "token")).toBeNull();
    expect(returnWeek({ base: u }, "back")).toBe(1);
  });

  test("a healthy player in IR comes out first, and a full roster names the cut", async () => {
    const u = universe({
      slots: ["WR", "WR"],
      activeLimit: 2,
      reserveLimit: 1,
      players: { a: ["WR", [10, 10]], b: ["WR", [9, 9]], healthy: ["WR", [3, 3]], fa: ["WR", [12, 12]] },
      freeAgents: ["fa"],
    });
    const steps = await buildPlan({
      ctx: context(u, team(1, ["a", "b", "healthy"], ["healthy"])),
      query: {},
      availability: freeAgent,
      bid: () => null,
      lineup: null,
      healthyInIr: ["healthy"],
      irEligible: [],
      returns: [],
    });
    const out = steps.find((s): s is Extract<PlanStep, { kind: "ir-healthy" }> => s.kind === "ir-healthy")!;
    // The cheapest way back under the limit is cutting him.
    expect(out.cut).toBe("healthy");
    // And the add that follows needs a cut of its own - no phantom open spot.
    const add = steps.find((s): s is Extract<PlanStep, { kind: "add" }> => s.kind === "add");
    expect(add?.move.drop).not.toBeNull();
  });
});
