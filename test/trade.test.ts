/**
 * The trade analyzer.
 *
 * Two layers, tested the way the draft engine is. Hand-built rosters pin down the
 * arithmetic - the lineup optimiser, the waiver floor, depth as insurance, roster
 * limits - where the right answer can be worked out on paper. The fixture league
 * checks the properties that only show up across a whole search: every result
 * clears all three bars, pins are honoured, and the list is not ten copies of the
 * same deal.
 */

import { test, expect, describe } from "bun:test";
import {
  makeFixtureTradeLeague,
  TRADE_FIXTURE_MY_ROSTER,
} from "../fixtures/trade.ts";
import { config } from "../src/config.ts";
import {
  applyMoves,
  buildUniverse,
  lineupSlots,
  rosterBreakdown,
  rosterValue,
  type TeamRoster,
  type TradePlayer,
  type TradeUniverse,
} from "../src/trade/value.ts";
import {
  acceptanceLikelihood,
  evaluateTrade,
  findTrades,
  marketValues,
  packageValue,
  tradeKey,
  TradeQueryError,
} from "../src/trade/search.ts";
import { availabilityNote, explainTrade, ordinal, profileLeague } from "../src/trade/explain.ts";
import { fetchWeekly, lastFantasyWeek, rosWindow } from "../src/data/ros.ts";
import type { League, NflState } from "../src/sleeper/types.ts";

// ---------------------------------------------------------------------------
// Hand-built universes
// ---------------------------------------------------------------------------

interface Spec {
  slots: string[];
  /** Streaming floor per position, every week. */
  floor?: Record<string, number>;
  injuryRate?: number;
  activeLimit?: number;
  reserveLimit?: number;
  rosterSpotValue?: number;
  /** id -> [position, weekly points, market value?] */
  players: Record<string, [string, number[], number?]>;
}

function universe(spec: Spec): TradeUniverse {
  const weeks = Object.values(spec.players)[0]![1].map((_, i) => i + 1);
  const players = new Map<string, TradePlayer>();
  for (const [id, [position, weekly, mv]] of Object.entries(spec.players)) {
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
      marketValue: mv ?? rosTotal,
    });
  }
  return {
    weeks,
    slots: lineupSlots(spec.slots),
    activeLimit: spec.activeLimit ?? 99,
    reserveLimit: spec.reserveLimit ?? 0,
    players,
    freeAgents: [],
    waiverFloor: weeks.map(() => ({ ...(spec.floor ?? {}) })),
    replacementTotal: {},
    rosterSpotValue: spec.rosterSpotValue ?? 5,
    injuryRate: spec.injuryRate ?? 0,
  };
}

const team = (rosterId: number, players: string[], reserve: string[] = []): TeamRoster => ({
  rosterId,
  players,
  reserve,
});

// ---------------------------------------------------------------------------

describe("lineup slots", () => {
  test("THE MAIN LEAGUE: dedicated slots first, then both flexes, no kicker, no bench", () => {
    const fx = makeFixtureTradeLeague();
    const slots = lineupSlots(fx.league.roster_positions).map((s) => s.label);
    expect(slots).toEqual(["QB", "RB", "RB", "WR", "WR", "TE", "DEF", "FLEX", "FLEX"]);
  });

  test("the narrowest flex fills first, so a quarterback can still use SUPER_FLEX", () => {
    const slots = lineupSlots(["SUPER_FLEX", "FLEX", "QB", "BN"]).map((s) => s.label);
    expect(slots).toEqual(["QB", "FLEX", "SUPER_FLEX"]);
  });
});

describe("roster value", () => {
  test("starts the best legal lineup, filling flex with the best leftover", () => {
    const u = universe({
      slots: ["QB", "RB", "WR", "FLEX"],
      players: {
        qb: ["QB", [20]],
        rb1: ["RB", [15]],
        rb2: ["RB", [10]],
        wr1: ["WR", [12]],
        wr2: ["WR", [8]],
      },
    });
    // QB 20 + RB 15 + WR 12 + FLEX max(RB 10, WR 8)
    expect(rosterValue(u, ["qb", "rb1", "rb2", "wr1", "wr2"])).toBeCloseTo(57);
  });

  test("a second quarterback takes SUPER_FLEX when an RB has taken the regular flex", () => {
    const u = universe({
      slots: ["QB", "SUPER_FLEX", "FLEX"],
      players: { qb1: ["QB", [20]], qb2: ["QB", [18]], rb: ["RB", [15]] },
    });
    expect(rosterValue(u, ["qb1", "qb2", "rb"])).toBeCloseTo(53);
  });

  test("a bye is covered by the bench, or streamed at the waiver floor", () => {
    const u = universe({
      slots: ["WR"],
      floor: { WR: 4 },
      players: { star: ["WR", [10, 0]], backup: ["WR", [6, 6]] },
    });
    expect(rosterValue(u, ["star", "backup"])).toBeCloseTo(16);
    expect(rosterValue(u, ["star"])).toBeCloseTo(14);
  });

  test("a starter worse than the waiver wire is streamed over, not started", () => {
    const u = universe({ slots: ["WR"], floor: { WR: 4 }, players: { weak: ["WR", [3, 3]] } });
    expect(rosterValue(u, ["weak"])).toBeCloseTo(8);
    expect(rosterBreakdown(u, ["weak"]).starts.get("weak")).toBe(0);
  });

  test("bench depth is insurance, and a bench player below the waiver floor is worth nothing", () => {
    const u = universe({
      slots: ["WR"],
      floor: { WR: 4 },
      injuryRate: 0.1,
      players: { starter: ["WR", [10]], good: ["WR", [8]], junk: ["WR", [3]] },
    });
    const alone = rosterValue(u, ["starter"]);
    expect(alone).toBeCloseTo(0.9 * 10 + 0.1 * 4);
    expect(rosterValue(u, ["starter", "good"])).toBeCloseTo(0.9 * 10 + 0.1 * 8);
    expect(rosterValue(u, ["starter", "junk"])).toBeCloseTo(alone);
  });

  test("the breakdown agrees with the value and attributes it by position", () => {
    const fx = makeFixtureTradeLeague();
    const rosters = fx.rosters.map((r) => team(r.roster_id, r.players ?? [], r.reserve ?? []));
    const u = buildUniverse({ ...fx, rosters });
    const mine = rosters.find((r) => r.rosterId === TRADE_FIXTURE_MY_ROSTER)!;
    const b = rosterBreakdown(u, mine.players);
    expect(b.total).toBeCloseTo(rosterValue(u, mine.players));
    const byPos = Object.values(b.byPosition).reduce((a, x) => a + x, 0);
    expect(byPos).toBeCloseTo(b.total);
    expect(b.weekly).toHaveLength(u.weeks.length);
  });
});

describe("rosters after a trade", () => {
  const u = universe({
    slots: ["RB"],
    activeLimit: 3,
    reserveLimit: 1,
    players: {
      a: ["RB", [10], 50],
      b: ["RB", [6], 20],
      c: ["RB", [2], 5],
      x: ["RB", [9], 40],
      y: ["RB", [8], 30],
      hurt: ["RB", [7], 25],
    },
  });

  test("the side receiving more players cuts its cheapest - never what it just received", () => {
    const after = applyMoves(u, team(1, ["a", "b", "c"]), ["a"], ["x", "y"]);
    expect(after.dropped).toEqual(["c"]);
    expect(after.players.sort()).toEqual(["b", "x", "y"]);
  });

  test("a player who was in the sender's IR slot lands in IR, so nobody is cut", () => {
    const after = applyMoves(u, team(1, ["a", "b", "c"]), ["a"], ["x", "hurt"], new Set(["hurt"]));
    expect(after.dropped).toEqual([]);
    expect(after.reserve).toEqual(["hurt"]);
  });

  test("the side sending more players is left with an open spot", () => {
    const after = applyMoves(u, team(1, ["a", "b", "c"]), ["b", "c"], ["x"]);
    expect(after.openSpots).toBe(1);
    expect(after.dropped).toEqual([]);
  });
});

describe("finding trades on complementary rosters", () => {
  // I start a waiver-level WR next to three good RBs; they are the mirror image.
  // The trade that helps both of us is the obvious one - and the one a raw
  // player-value chart cannot see, because the RB I give is worth more alone.
  const u = universe({
    slots: ["RB", "WR"],
    floor: { RB: 3, WR: 3 },
    players: {
      myRb1: ["RB", [14]],
      myRb2: ["RB", [12]],
      myWr: ["WR", [4]],
      theirWr1: ["WR", [13]],
      theirWr2: ["WR", [11]],
      theirRb: ["RB", [4]],
    },
  });
  const rosters = [team(1, ["myRb1", "myRb2", "myWr"]), team(2, ["theirWr1", "theirWr2", "theirRb"])];

  test("the swap of surpluses is found, and is labelled win-win", async () => {
    const result = await findTrades(u, rosters, { me: 1 });
    const top = result.trades[0]!;
    expect(top).toBeDefined();
    // Running back out, receiver in - the exact package is the search's call.
    expect(top.give.every((id) => u.players.get(id)!.position === "RB")).toBe(true);
    expect(top.get.some((id) => u.players.get(id)!.position === "WR")).toBe(true);
    expect(top.myGain).toBeGreaterThan(0);
    expect(top.theirGain).toBeGreaterThan(0);
    expect(top.label).toBe("win-win");
  });

  test("handing over your starter for their bench player is not offered", async () => {
    const result = await findTrades(u, rosters, { me: 1 });
    expect(result.trades.some((t) => t.give.includes("myRb1") && t.get.length === 1 && t.get[0] === "theirRb")).toBe(false);
  });
});

describe("the three bars", () => {
  test("acceptance is a coin flip when even on both counts, and rises with either", () => {
    expect(acceptanceLikelihood(0, 1)).toBeCloseTo(0.5);
    expect(acceptanceLikelihood(1, 1)).toBeGreaterThan(0.7);
    expect(acceptanceLikelihood(0, 1.1)).toBeGreaterThan(0.65);
    expect(acceptanceLikelihood(0, 0.85)).toBeLessThan(0.25);
  });

  test("a package's best piece counts in full and extra pieces count less", () => {
    const u = universe({ slots: ["RB"], players: { a: ["RB", [1], 60], b: ["RB", [1], 40] } });
    const [w0, w1] = config.trade.packageWeights;
    expect(packageValue(u, ["b", "a"])).toBeCloseTo(60 * w0! + 40 * w1!);
    expect(packageValue(u, ["a", "b"])).toBeLessThan(100);
  });

  test("a junk throw-in does not sweeten a deal: the receiver pays a roster spot for it", () => {
    const u = universe({
      slots: ["RB"],
      rosterSpotValue: 5,
      players: { star: ["RB", [1], 60], junk: ["RB", [1], 3], theirs: ["RB", [1], 55] },
    });
    const clean = marketValues(u, ["star"], ["theirs"]);
    const padded = marketValues(u, ["star", "junk"], ["theirs"]);
    expect(padded.give).toBeLessThan(clean.give);
    expect(padded.get).toBe(clean.get);
  });

  test("an exact proposal that fails says why, in words", () => {
    const u = universe({
      slots: ["RB"],
      players: { mine: ["RB", [14], 80], theirs: ["RB", [6], 20] },
    });
    const t = evaluateTrade(u, team(1, ["mine"]), team(2, ["theirs"]), ["mine"], ["theirs"]);
    expect(t.passes).toBe(false);
    expect(t.problems.join(" ")).toContain("Costs your lineup");
  });
});

describe("searching the fixture league", () => {
  const fx = makeFixtureTradeLeague();
  const rosters = fx.rosters.map((r) => team(r.roster_id, r.players ?? [], r.reserve ?? []));
  const u = buildUniverse({ ...fx, rosters });
  const me = TRADE_FIXTURE_MY_ROSTER;
  const mine = rosters.find((r) => r.rosterId === me)!;

  test("finds trades league-wide, quickly", async () => {
    const started = performance.now();
    const result = await findTrades(u, rosters, { me });
    expect(result.trades.length).toBeGreaterThan(3);
    expect(result.partners).toHaveLength(rosters.length - 1);
    // ~400ms on a laptop; generous so a slow CI box does not flake.
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("every result clears all three bars", async () => {
    const t = config.trade;
    for (const sort of ["expected", "gain", "likely"] as const) {
      const result = await findTrades(u, rosters, { me, sort });
      for (const trade of result.trades) {
        expect(trade.passes).toBe(true);
        expect(trade.myGain).toBeGreaterThanOrEqual(t.minGainPerWeek);
        expect(trade.theirGain).toBeGreaterThanOrEqual(-t.maxPartnerLossPerWeek);
        expect(trade.marketRatio).toBeGreaterThanOrEqual(t.minMarketRatio);
      }
    }
  });

  test("results are not padded copies of each other", async () => {
    const result = await findTrades(u, rosters, { me });
    const perPartner = new Map<number, number>();
    result.trades.forEach((t, i) => {
      perPartner.set(t.partner, (perPartner.get(t.partner) ?? 0) + 1);
      for (const better of result.trades.slice(0, i)) {
        if (better.partner !== t.partner) continue;
        const superset = better.give.every((id) => t.give.includes(id)) && better.get.every((id) => t.get.includes(id));
        expect(superset).toBe(false);
      }
    });
    for (const n of perPartner.values()) expect(n).toBeLessThanOrEqual(config.trade.perPartnerLimit);
  });

  test("results come back sorted by the requested measure", async () => {
    const gain = await findTrades(u, rosters, { me, sort: "gain" });
    const gains = gain.trades.map((t) => t.myGain);
    expect(gains).toEqual([...gains].sort((a, b) => b - a));
    const likely = await findTrades(u, rosters, { me, sort: "likely" });
    const odds = likely.trades.map((t) => t.acceptance);
    expect(odds).toEqual([...odds].sort((a, b) => b - a));
  });

  test("is deterministic", async () => {
    const a = await findTrades(u, rosters, { me });
    const b = await findTrades(u, rosters, { me });
    expect(a.trades.map(tradeKey)).toEqual(b.trades.map(tradeKey));
  });

  test("a single partner is the only team traded with, and 3-player packages are allowed", async () => {
    const result = await findTrades(u, rosters, { me, partner: 5, maxPerSide: 3 });
    expect(result.maxPerSide).toBe(3);
    expect(result.trades.every((t) => t.partner === 5)).toBe(true);
    expect(result.trades.every((t) => t.give.length <= 3 && t.get.length <= 3)).toBe(true);
  });

  test("league-wide searches cap packages at two a side and say so", async () => {
    const result = await findTrades(u, rosters, { me, maxPerSide: 3 });
    expect(result.maxPerSide).toBe(2);
    expect(result.notes.join(" ")).toContain("up to 2");
  });

  test("pins are honoured: offered players are in, kept players are out", async () => {
    const offer = [...mine.players].sort((a, b) => u.players.get(b)!.marketValue - u.players.get(a)!.marketValue)[1]!;
    const keep = [...mine.players].sort((a, b) => u.players.get(b)!.marketValue - u.players.get(a)!.marketValue)[0]!;
    const result = await findTrades(u, rosters, { me, give: [offer], keep: [keep] });
    for (const t of result.trades) {
      expect(t.give).toContain(offer);
      expect(t.give).not.toContain(keep);
    }
  });

  test("a pinned player is not subject to the diversity caps", async () => {
    // Every result includes the pinned target, so a per-target cap applied to him
    // would silently cut the list to three.
    const theirs = rosters.find((r) => r.rosterId === 8)!;
    const target = [...theirs.players].sort((a, b) => u.players.get(b)!.marketValue - u.players.get(a)!.marketValue)[2]!;
    const pinned = await findTrades(u, rosters, { me, get: [target], maxPerSide: 3, sort: "gain" });
    const counted = pinned.trades.filter((t) => t.get.includes(target)).length;
    expect(counted).toBe(pinned.trades.length);
    expect(pinned.trades.length).toBeGreaterThan(3);
  });

  test("wanting a player pins the partner to his team", async () => {
    const theirs = rosters.find((r) => r.rosterId === 8)!;
    const target = [...theirs.players].sort((a, b) => u.players.get(b)!.marketValue - u.players.get(a)!.marketValue)[2]!;
    const result = await findTrades(u, rosters, { me, get: [target] });
    expect(result.partners).toEqual([8]);
    for (const t of result.trades) expect(t.get).toContain(target);
  });

  test("pinning both sides evaluates that exact trade, pass or fail, and keeps it out of the list", async () => {
    const theirs = rosters.find((r) => r.rosterId === 8)!;
    const result = await findTrades(u, rosters, { me, give: [mine.players[0]!], get: [theirs.players[0]!] });
    expect(result.proposal).not.toBeNull();
    expect(result.proposal!.give).toEqual([mine.players[0]!]);
    expect(result.proposal!.get).toEqual([theirs.players[0]!]);
    expect(result.proposal!.passes).toBe(result.proposal!.problems.length === 0);
    expect(result.trades.some((t) => tradeKey(t) === tradeKey(result.proposal!))).toBe(false);
  });

  test("impossible pins are a clear error, not an empty result", async () => {
    const a = rosters.find((r) => r.rosterId === 8)!.players[0]!;
    const b = rosters.find((r) => r.rosterId === 9)!.players[0]!;
    await expect(findTrades(u, rosters, { me, get: [a, b] })).rejects.toThrow(TradeQueryError);
    await expect(findTrades(u, rosters, { me, give: [a] })).rejects.toThrow("not on your roster");
    await expect(findTrades(u, rosters, { me, get: [mine.players[0]!] })).rejects.toThrow("your own player");
    await expect(
      findTrades(u, rosters, { me, give: [mine.players[0]!], keep: [mine.players[0]!] }),
    ).rejects.toThrow("both");
  });
});

describe("explanations", () => {
  const fx = makeFixtureTradeLeague();
  const rosters = fx.rosters.map((r) => team(r.roster_id, r.players ?? [], r.reserve ?? []));
  const u = buildUniverse({ ...fx, rosters });
  const profiles = profileLeague(u, rosters);

  test("every team gets a rank at every position with a dedicated slot", () => {
    for (const p of profiles.values()) {
      expect(Object.keys(p.positions).sort()).toEqual(["DEF", "QB", "RB", "TE", "WR"]);
      for (const s of Object.values(p.positions)) {
        expect(s.rank).toBeGreaterThanOrEqual(1);
        expect(s.rank).toBeLessThanOrEqual(rosters.length);
      }
    }
  });

  test("the pitch names the other manager and every player in the deal", async () => {
    const result = await findTrades(u, rosters, { me: TRADE_FIXTURE_MY_ROSTER });
    const t = result.trades[0]!;
    const ex = explainTrade(
      { u, rosters, profiles, me: TRADE_FIXTURE_MY_ROSTER, managerName: (id) => `Manager${id}` },
      t,
    );
    expect(ex.pitch).toContain(`Manager${t.partner}`);
    for (const id of [...t.give, ...t.get]) expect(ex.pitch).toContain(u.players.get(id)!.name);
    expect(ex.forMe[0]).toContain("pts/wk");
    expect(ex.forThem.length).toBeGreaterThan(0);
  });

  test("a bye is not an injury, and neither is a game already played this week", () => {
    const v = universe({
      slots: ["WR"],
      players: {
        bye: ["WR", [0, 9, 9]],
        played: ["WR", [0, 9, 9]],
        hurt: ["WR", [0, 0, 9]],
      },
    });
    v.players.get("bye")!.byeWeek = 1;
    v.players.get("played")!.playedThisWeek = true;
    v.players.get("hurt")!.injuryStatus = "IR";
    expect(availabilityNote(v, "bye")).toBeNull();
    expect(availabilityNote(v, "played")).toBeNull();
    expect(availabilityNote(v, "hurt")).toContain("back in week 3");
  });

  test("ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd",
    ]);
  });
});

describe("rest-of-season window", () => {
  const league = (settings: Record<string, number>) => ({ settings }) as unknown as League;
  const state = (season_type: string, week: number) => ({ season_type, week, season: "2026" }) as NflState;

  test("ends with the league's fantasy playoffs", () => {
    expect(lastFantasyWeek(league({ playoff_week_start: 15, playoff_teams: 6 }))).toBe(17);
    expect(lastFantasyWeek(league({ playoff_week_start: 15, playoff_teams: 4 }))).toBe(16);
    expect(lastFantasyWeek(league({}))).toBe(17);
  });

  test("starts this week in season, week 1 before it, and is empty once the playoffs end", () => {
    const l = league({ playoff_week_start: 15, playoff_teams: 6 });
    expect(rosWindow(state("regular", 6), l)).toEqual({ from: 6, to: 17 });
    expect(rosWindow(state("pre", 0), l)).toEqual({ from: 1, to: 17 });
    expect(rosWindow(state("regular", 18), l)).toBeNull();
    expect(rosWindow(state("post", 1), l)).toBeNull();
  });

  test("tells a bye, a played game, and an absence apart in Sleeper's weekly rows", async () => {
    // Shapes observed live 2026-10-19: a bye is a row with no opponent and no date;
    // an injured player keeps his game with near-empty stats.
    const pages: Record<number, unknown[]> = {
      6: [
        { player_id: "bye", date: null, opponent: null, stats: {} },
        { player_id: "done", date: "2026-10-18", opponent: "KC", stats: { rec: 5, rec_yd: 60 } },
        { player_id: "tonight", date: "2026-10-19", opponent: "NYG", stats: { rec: 4, rec_yd: 50 } },
        { player_id: "hurt", date: "2026-10-19", opponent: "DAL", stats: { gp: 1 } },
      ],
      7: [
        { player_id: "bye", date: "2026-10-25", opponent: "GB", stats: { rec: 5, rec_yd: 60 } },
        { player_id: "hurt", date: "2026-10-25", opponent: "PHI", stats: { rec: 3, rec_yd: 40 } },
      ],
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const week = Number(String(input).match(/\/2026\/(\d+)\?/)?.[1]);
      return new Response(JSON.stringify(pages[week] ?? []), { status: 200 });
    }) as typeof fetch;
    try {
      const out = await fetchWeekly("2026", [6, 7], { rec: 0.5, rec_yd: 0.1 }, {}, "2026-10-19");
      expect(out.byeWeek.get("bye")).toBe(6);
      expect(out.weekly.get("bye")).toEqual([0, 8.5]);
      expect(out.played.has("done")).toBe(true);
      expect(out.weekly.get("done")![0]).toBe(0);
      expect(out.weekly.get("tonight")![0]).toBe(7);
      expect(out.weekly.get("hurt")).toEqual([0, 5.5]);
      expect(out.byeWeek.has("hurt")).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
