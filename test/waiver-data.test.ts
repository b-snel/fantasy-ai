/**
 * The waiver analyzer's data: what Sleeper sends, what the league's own history
 * says a claim costs, and when a player can actually be had.
 *
 * Literal payloads in the shapes observed live on 2026-10-21 - null adds and
 * drops, team-code DEF ids, failed claims explained only by a sentence in
 * metadata.notes, a schedule with dates but no kickoff times. These are the
 * places a parser silently goes wrong, so every shape is spelled out here rather
 * than generated. Clock arithmetic is pinned to Eastern wall-clock times,
 * including across the November DST change.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "../src/config.ts";
import { mergeActivity, summariseActivity, type LeagueActivity } from "../src/data/activity.ts";
import { summarise } from "../src/data/usage.ts";
import { teamSchedule, type TeamSchedule } from "../src/data/schedule.ts";
import {
  availabilityOf,
  etToEpoch,
  gameStarted,
  irEligible,
  kickoffEstimate,
  waiverCalendar,
  type WaiverCalendar,
} from "../src/waiver/availability.ts";
import { expectedBidders, faabMarket, suggestBid, type Demand, type FaabMarket } from "../src/waiver/market.ts";
import { liveNewsProvider, type NewsRequest } from "../src/waiver/news.ts";
import type { PlayersIndex, Transaction } from "../src/sleeper/types.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A league's activity with only the parts a test cares about. */
function activity(over: Partial<LeagueActivity> = {}): LeagueActivity {
  return {
    claims: [],
    failedClaims: [],
    drops: [],
    trendingAdds: new Map(),
    trendingDrops: new Map(),
    failedWeeks: [],
    trendingOk: true,
    fetchedAt: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

describe("league activity from Sleeper's transaction rows", () => {
  const run6 = etToEpoch(2026, 10, 14, 3, 8);
  const run7 = etToEpoch(2026, 10, 21, 3, 8);
  const claim = (over: Partial<Transaction>): Transaction => ({
    type: "waiver",
    status: "complete",
    roster_ids: [3],
    adds: null,
    drops: null,
    settings: { waiver_bid: 0, seq: 0 },
    metadata: { notes: "Your waiver claim was processed successfully!" },
    created: run7 - DAY,
    status_updated: run7,
    leg: 7,
    ...over,
  });

  const pages: Array<{ week: number; rows: Transaction[] }> = [
    {
      week: 6,
      rows: [claim({ adds: { "4034": 5 }, drops: { "7564": 5 }, settings: { waiver_bid: 11, seq: 0 }, status_updated: run6, leg: 6 })],
    },
    {
      week: 7,
      rows: [
        // A defense: the id is the team code. No drop: an open spot.
        claim({ adds: { IND: 3 }, drops: null, settings: { waiver_bid: 0, seq: 1 } }),
        claim({ adds: { "9509": 8 }, drops: { "6794": 8 }, settings: { waiver_bid: 17, seq: 0 } }),
        claim({
          status: "failed",
          adds: { "9509": 2 },
          drops: { "5859": 2 },
          settings: { waiver_bid: 12, seq: 0 },
          metadata: { notes: "This player was claimed by another owner." },
        }),
        claim({
          status: "failed",
          adds: { "9509": 4 },
          drops: null,
          settings: { waiver_bid: 9, seq: 1 },
          metadata: { notes: "Unfortunately, your roster will have too many players after this transaction." },
        }),
        claim({
          status: "failed",
          adds: { "9509": 11 },
          drops: null,
          settings: { waiver_bid: 40, seq: 0 },
          metadata: { notes: "You are over the budget for this transaction." },
        }),
        claim({ status: "failed", adds: { "1111": 6 }, settings: null, metadata: null }),
        // A free-agent drop: no adds at all, no waiver settings.
        {
          type: "free_agent",
          status: "complete",
          roster_ids: [7],
          adds: null,
          drops: { "4881": 7 },
          settings: null,
          metadata: null,
          created: run7 + 5 * HOUR,
          status_updated: run7 + 5 * HOUR,
          leg: 7,
        },
        // A trade "drops" both players - they change hands, they do not hit the wire.
        {
          type: "trade",
          status: "complete",
          roster_ids: [1, 2],
          adds: { "2133": 1, "8138": 2 },
          drops: { "2133": 2, "8138": 1 },
          settings: null,
          metadata: null,
          created: run7 + 2 * HOUR,
          status_updated: run7 + 2 * HOUR,
          leg: 7,
        },
      ],
    },
  ];
  const a = summariseActivity(
    pages,
    [{ player_id: "9509", count: 120_000 }],
    [{ player_id: "4881", count: 15_000 }],
    run7 + 6 * HOUR,
  );

  test("won claims, with their bids, a DEF by team code, newest first", () => {
    expect(a.claims.map((c) => [c.playerId, c.rosterId, c.bid, c.week])).toEqual([
      ["IND", 3, 0, 7],
      ["9509", 8, 17, 7],
      ["4034", 5, 11, 6],
    ]);
    expect(a.claims[0]!.at).toBe(run7);
  });

  test("failed claims carry the reason from Sleeper's note", () => {
    const byRoster = new Map(a.failedClaims.map((f) => [f.rosterId, f]));
    expect(byRoster.get(2)).toMatchObject({ playerId: "9509", bid: 12, reason: "outbid" });
    expect(byRoster.get(4)).toMatchObject({ playerId: "9509", bid: 9, reason: "roster" });
    expect(byRoster.get(11)).toMatchObject({ playerId: "9509", bid: 40, reason: "budget" });
    // No settings, no note: a $0 claim that failed for a reason we cannot read.
    expect(byRoster.get(6)).toMatchObject({ playerId: "1111", bid: 0, reason: "other" });
  });

  test("drops: completed waiver and free-agent drops only, trades ignored, newest first", () => {
    expect(a.drops.map((d) => [d.playerId, d.rosterId])).toEqual([
      ["4881", 7],
      ["6794", 8],
      ["7564", 5],
    ]);
    // A failed claim's drop never happened.
    expect(a.drops.some((d) => d.playerId === "5859")).toBe(false);
  });

  test("trending, by player", () => {
    expect(a.trendingAdds.get("9509")).toBe(120_000);
    expect(a.trendingDrops.get("4881")).toBe(15_000);
    expect(a.fetchedAt).toBe(run7 + 6 * HOUR);
  });
});

// ---------------------------------------------------------------------------
// The FAAB market
// ---------------------------------------------------------------------------

describe("the FAAB market", () => {
  const t1 = etToEpoch(2026, 10, 14, 3, 8);
  const t2 = etToEpoch(2026, 10, 21, 3, 8);
  const won = (playerId: string, rosterId: number, bid: number, at: number) => ({ playerId, rosterId, bid, week: 7, at });
  const lost = (playerId: string, rosterId: number, bid: number, at: number, reason: "outbid" | "roster" | "budget" = "outbid") => ({
    ...won(playerId, rosterId, bid, at),
    reason,
  });
  const positions: Record<string, string> = { A: "RB", B: "WR", C: "QB", D: "QB" };

  const market = faabMarket({
    activity: activity({
      claims: [won("A", 1, 15, t1), won("B", 4, 8, t1), won("A", 6, 2, t2), won("C", 7, 0, t2), won("D", 8, 0, t2)],
      failedClaims: [
        // A at t1: three teams - clearing is the 10.
        lost("A", 2, 10, t1),
        lost("A", 3, 6, t1, "roster"),
        // B at t1: one rival filing two claims is one bidder; his best bid clears.
        lost("B", 5, 3, t1),
        lost("B", 5, 7, t1),
        // A budget failure is not a bid anyone could have matched.
        lost("B", 9, 50, t1, "budget"),
      ],
    }),
    budget: 100,
    rosters: [
      { rosterId: 1, budgetUsed: 30, waiverPosition: 2 },
      { rosterId: 2, budgetUsed: 120, waiverPosition: null },
      { rosterId: 3, budgetUsed: 0, waiverPosition: 1 },
    ],
    positionOf: (id) => positions[id] ?? null,
  });

  test("the clearing price is the second-highest bid per roster within one auction", () => {
    const a = market.contested.find((c) => c.playerId === "A" && c.at === t1)!;
    expect(a.bidders).toBe(3);
    expect(a.clearing).toBe(10);
    const b = market.contested.find((c) => c.playerId === "B")!;
    expect(b.bidders).toBe(2);
    expect(b.clearing).toBe(7);
    // Same player, a different run, nobody else: not an auction.
    expect(market.contested.some((c) => c.playerId === "A" && c.at === t2)).toBe(false);
    expect(market.contested).toHaveLength(2);
    expect(market.clearingByBidders[2]).toEqual({ median: 7, n: 1 });
    expect(market.clearingByBidders[3]).toEqual({ median: 10, n: 1 });
    expect(market.clearingByBidders[5]).toEqual({ median: 0, n: 0 });
  });

  test("$0 wins count in the winning-bid quantiles", () => {
    // Bids 0, 0, 2, 8, 15.
    expect(market.winning).toEqual({ median: 2, p75: 8, p90: 15, n: 5 });
    expect(market.byPosition.QB).toEqual({ median: 0, n: 2 });
    expect(market.byPosition.RB).toEqual({ median: 15, n: 2 });
  });

  test("budgets left and waiver priority by roster", () => {
    expect(market.budgets.get(1)).toBe(70);
    expect(market.budgets.get(2)).toBe(0);
    expect(market.budgets.get(3)).toBe(100);
    expect(market.priority.get(1)).toBe(2);
    expect(market.priority.has(2)).toBe(false);
    expect(market.priority.get(3)).toBe(1);
  });
});

describe("bids", () => {
  const none: Demand = { trendingAdds: 0, freshDrop: false, rivalsWithHole: [] };

  test("expected bidders step with Sleeper-wide adds, rival holes and a fresh drop", () => {
    const at = (trendingAdds: number) => expectedBidders({ ...none, trendingAdds });
    expect([0, 4_999, 5_000, 24_999, 25_000, 99_999, 100_000, 299_999, 300_000].map(at)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5]);
    expect(expectedBidders({ ...none, rivalsWithHole: [2, 5] })).toBe(3);
    expect(expectedBidders({ ...none, trendingAdds: 30_000, rivalsWithHole: [2] })).toBe(3);
    expect(expectedBidders({ ...none, freshDrop: true })).toBe(2);
    expect(expectedBidders({ trendingAdds: 500_000, freshDrop: true, rivalsWithHole: [1, 2, 3, 4, 5, 6] })).toBe(5);
  });

  /** A market built from claims: six QBs won at $0, six RBs at $11, a few WRs at $3. */
  function pricedMarket(myBudgetUsed = 40): FaabMarket {
    const at = etToEpoch(2026, 10, 14, 3, 8);
    const claims = [
      ...Array.from({ length: 6 }, (_, i) => ({ playerId: `qb${i}`, rosterId: 2, bid: 0, week: 6, at })),
      ...Array.from({ length: 6 }, (_, i) => ({ playerId: `rb${i}`, rosterId: 4, bid: 11, week: 6, at })),
      ...Array.from({ length: 3 }, (_, i) => ({ playerId: `wr${i}`, rosterId: 5, bid: 3, week: 6, at })),
    ];
    return faabMarket({
      activity: activity({ claims }),
      budget: 100,
      rosters: [
        { rosterId: 1, budgetUsed: myBudgetUsed, waiverPosition: 6 },
        { rosterId: 2, budgetUsed: 10, waiverPosition: 1 },
        { rosterId: 4, budgetUsed: 20, waiverPosition: 3 },
        { rosterId: 5, budgetUsed: 100, waiverPosition: 9 },
      ],
      positionOf: (id) => id.slice(0, 2).toUpperCase(),
    });
  }
  const bid = (over: Partial<Parameters<typeof suggestBid>[0]>) =>
    suggestBid({
      market: pricedMarket(),
      me: 1,
      position: "RB",
      demand: none,
      worthPoints: 20,
      playoffOdds: 0.5,
      ...over,
    });

  test("nobody else wants him: bid $0", () => {
    const b = bid({});
    expect(b.bidders).toBe(1);
    expect(b.amount).toBe(0);
    expect(b.outbidLikely).toBe(false);
  });

  test("never above your budget, however hot he is", () => {
    const hot: Demand = { trendingAdds: 500_000, freshDrop: true, rivalsWithHole: [2, 4] };
    const b = bid({ market: pricedMarket(97), demand: hot, worthPoints: 1_000 });
    expect(b.amount).toBeLessThanOrEqual(3);
    expect(b.worthCap).toBeLessThanOrEqual(3);
  });

  test("a contested player worth little to you: likely outbid, and the bid says so", () => {
    const b = bid({ demand: { ...none, trendingAdds: 150_000 }, worthPoints: 0.1, alternatives: ["Backup One"] });
    expect(b.bidders).toBeGreaterThanOrEqual(2);
    expect(b.outbidLikely).toBe(true);
    expect(b.amount).toBeLessThanOrEqual(b.worthCap);
    expect(b.lines.join(" ")).toContain("Backup One");
  });

  test("a position that goes for $0 here clears lower than one that goes for $11", () => {
    const demand: Demand = { ...none, trendingAdds: 30_000 };
    const qb = bid({ position: "QB", demand });
    const rb = bid({ position: "RB", demand });
    expect(qb.bidders).toBe(rb.bidders);
    expect(qb.clearing).toBeLessThan(rb.clearing);
    expect(qb.amount).toBeLessThan(rb.amount);
  });
});

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

describe("the waiver calendar", () => {
  const settings = { waiver_day_of_week: 2, waiver_clear_days: 1 };
  const run = etToEpoch(2026, 10, 21, 3, 8);
  const offCycle = etToEpoch(2026, 10, 21, 3, 45);
  const claimsAt = (at: number, n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ playerId: `p${from + i}`, rosterId: (i % 12) + 1, bid: i, week: 7, at }));
  // The weekly run: 10 won and 6 lost claims. A dropped player clearing the same
  // morning: three teams, one processing time.
  const season = activity({
    claims: [...claimsAt(run, 10), ...claimsAt(offCycle, 1, 50)],
    failedClaims: [...claimsAt(run, 6, 20), ...claimsAt(offCycle, 2, 60)].map((c) => ({ ...c, reason: "outbid" as const })),
  });

  test("the weekly run is the big batch, not a three-claim clear the same morning", () => {
    const cal = waiverCalendar(season, settings, etToEpoch(2026, 10, 21, 11, 0));
    expect(cal.lastRun).toBe(run);
    expect(cal.nextRun).toBe(run + 7 * DAY);
    // A one-day clear lands about 23 hours after the drop.
    expect(cal.clearMs).toBe(23 * HOUR);
  });

  test("the next run is the last one plus whole weeks, stepping past now", () => {
    // Weeks are stepped in New York clock time: daylight saving ends on Nov 1,
    // and the run stays at 3:08am ET rather than drifting to 2:08.
    expect(waiverCalendar(season, settings, run + 7 * DAY + HOUR).nextRun).toBe(etToEpoch(2026, 11, 4, 3, 8));
    // A quiet week: the season's last big run still fixes the clock.
    const quiet = waiverCalendar(season, settings, run + 20 * DAY);
    expect(quiet.lastRun).toBe(run);
    expect(quiet.nextRun).toBe(etToEpoch(2026, 11, 11, 3, 8));
  });

  test("with no run seen yet, the waiver day at ~03:00 ET", () => {
    const cal = waiverCalendar(activity(), settings, etToEpoch(2026, 10, 20, 12, 0));
    expect(cal.lastRun).toBeNull();
    expect(cal.nextRun).toBe(etToEpoch(2026, 10, 21, 3, 0));
  });
});

describe("kickoff estimates", () => {
  test("Thursday night, Sunday early, Monday night - in Eastern time", () => {
    // 2026-10-22 is a Thursday; EDT is UTC-4.
    expect(kickoffEstimate("2026-10-22")).toBe(Date.UTC(2026, 9, 23, 0, 15));
    expect(kickoffEstimate("2026-10-25")).toBe(Date.UTC(2026, 9, 25, 17, 0));
    expect(kickoffEstimate("2026-10-26")).toBe(Date.UTC(2026, 9, 26, 23, 15));
  });

  test("correct across the DST change: November is UTC-5", () => {
    // DST ends at 2am on Sunday 2026-11-01, before that day's kickoffs.
    expect(kickoffEstimate("2026-11-01")).toBe(Date.UTC(2026, 10, 1, 18, 0));
    expect(kickoffEstimate("2026-11-05")).toBe(Date.UTC(2026, 10, 6, 1, 15));
    expect(kickoffEstimate("2026-11-08")).toBe(Date.UTC(2026, 10, 8, 18, 0));
    // Thanksgiving: three Thursday games, the first at ~12:30 - assume that for all.
    expect(kickoffEstimate("2026-11-26", 3)).toBe(Date.UTC(2026, 10, 26, 17, 30));
    expect(kickoffEstimate("2026-11-26", 1)).toBe(Date.UTC(2026, 10, 27, 1, 15));
    expect(kickoffEstimate("2026-11-09")).toBe(Date.UTC(2026, 10, 10, 0, 15));
  });
});

describe("when a player can be had", () => {
  const wed = etToEpoch(2026, 10, 21, 11, 0);
  const game = (opponent: string, home: boolean, date: string, status = "pre_game") => ({ opponent, home, date, status });
  const schedule: TeamSchedule = {
    KC: { 7: game("LV", true, "2026-10-25") },
    LV: { 7: game("KC", false, "2026-10-25") },
    DEN: { 7: game("LAC", true, "2026-10-22") },
    LAC: { 7: game("DEN", false, "2026-10-22") },
    // Sleeper flipped these to in_game before our kickoff estimate.
    SEA: { 7: game("SF", true, "2026-10-25", "in_game") },
    SF: { 7: game("SEA", false, "2026-10-25", "complete") },
    // GB is on bye in week 7: absent.
    GB: { 8: game("CHI", true, "2026-11-01") },
  };
  const calendar = (now: number): WaiverCalendar => ({
    now,
    lastRun: etToEpoch(2026, 10, 21, 3, 8),
    nextRun: etToEpoch(2026, 10, 28, 3, 8),
    clearMs: 23 * HOUR,
  });
  const at = (now: number, drops: LeagueActivity["drops"] = []) => ({
    calendar: calendar(now),
    schedule,
    nflWeek: 7,
    activity: activity({ drops }),
  });

  test("a free agent before his game: add now, and when he locks", () => {
    const a = availabilityOf("p1", "KC", at(wed));
    expect(a).toEqual({
      mode: "free_agent",
      processesAt: null,
      locksAt: kickoffEstimate("2026-10-25"),
      startWeek: 0,
      droppedBy: null,
      droppedAt: null,
    });
    // A bye, or no team: nothing to lock.
    expect(availabilityOf("p2", "GB", at(wed)).locksAt).toBeNull();
    expect(availabilityOf("p3", null, at(wed)).mode).toBe("free_agent");
  });

  test("a fresh drop is on waivers until it clears", () => {
    const droppedAt = wed - 6 * HOUR;
    const a = availabilityOf("p1", "KC", at(wed, [{ playerId: "p1", rosterId: 7, week: 7, at: droppedAt }]));
    expect(a.mode).toBe("waivers");
    expect(a.processesAt).toBe(droppedAt + 23 * HOUR);
    expect(a.droppedBy).toBe(7);
    expect(a.droppedAt).toBe(droppedAt);
    // Clears Thursday morning, before his Sunday game.
    expect(a.startWeek).toBe(0);
    // An old drop has cleared: he is a free agent again.
    expect(availabilityOf("p1", "KC", at(wed, [{ playerId: "p1", rosterId: 7, week: 6, at: wed - 3 * DAY }])).mode).toBe("free_agent");
  });

  test("a drop that clears after his kickoff helps from next week", () => {
    const thu = etToEpoch(2026, 10, 22, 12, 0);
    const a = availabilityOf("p1", "DEN", at(thu, [{ playerId: "p1", rosterId: 7, week: 7, at: thu - 2 * HOUR }]));
    expect(a.mode).toBe("waivers");
    expect(a.startWeek).toBe(1);
  });

  test("once his game has started he is locked until the next run", () => {
    const thursdayNight = etToEpoch(2026, 10, 22, 21, 0);
    const a = availabilityOf("p1", "DEN", at(thursdayNight));
    expect(a).toMatchObject({ mode: "locked", processesAt: etToEpoch(2026, 10, 28, 3, 8), startWeek: 1, locksAt: null });
    // Sunday's players are still free agents on Thursday night.
    expect(availabilityOf("p2", "KC", at(thursdayNight)).mode).toBe("free_agent");
  });

  test("gameStarted: Sleeper's in_game/complete status wins over the clock", () => {
    expect(gameStarted("SEA", 7, schedule, wed)).toBe(true);
    expect(gameStarted("SF", 7, schedule, wed)).toBe(true);
    expect(gameStarted("KC", 7, schedule, wed)).toBe(false);
    expect(gameStarted("KC", 7, schedule, etToEpoch(2026, 10, 25, 13, 0))).toBe(true);
    expect(gameStarted("GB", 7, schedule, etToEpoch(2026, 10, 26, 23, 0))).toBe(false);
    expect(gameStarted(null, 7, schedule, wed)).toBe(false);
  });
});

describe("IR eligibility", () => {
  const p = (injury_status: string | null) => ({ injury_status, status: "Active" });
  const closed = { reserve_allow_out: 0, reserve_allow_doubtful: 0, reserve_allow_sus: 0 };
  const open = { reserve_allow_out: 1, reserve_allow_doubtful: 1, reserve_allow_sus: 1, reserve_allow_cov: 1, reserve_allow_dnr: 1, reserve_allow_na: 1 };

  test("IR always; Out and Doubtful per the league's flags; Questionable never", () => {
    expect(irEligible(p("IR"), closed)).toBe(true);
    expect(irEligible(p("IR"), {})).toBe(true);
    expect(irEligible(p("Out"), closed)).toBe(false);
    expect(irEligible(p("Out"), { reserve_allow_out: 1 })).toBe(true);
    expect(irEligible(p("Doubtful"), { reserve_allow_out: 1 })).toBe(false);
    expect(irEligible(p("Doubtful"), { reserve_allow_doubtful: 1 })).toBe(true);
    expect(irEligible(p("Questionable"), open)).toBe(false);
  });

  test("a suspension only when the league allows it; healthy players never", () => {
    expect(irEligible(p("Sus"), closed)).toBe(false);
    expect(irEligible(p("Sus"), { reserve_allow_sus: 1 })).toBe(true);
    expect(irEligible(p(null), open)).toBe(false);
    expect(irEligible(undefined, open)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schedule and usage
// ---------------------------------------------------------------------------

describe("the NFL schedule by team", () => {
  test("both sides of every game, dates and statuses kept, byes absent", () => {
    const teams = teamSchedule([
      { week: 7, home: "KC", away: "LV", date: "2026-10-25", status: "pre_game" },
      { week: 6, home: "DEN", away: "KC", date: "2026-10-18", status: "complete" },
      { week: 8, home: "LV", away: "DEN" },
      // Malformed rows are skipped.
      { week: 8, home: "KC" },
      { home: "SF", away: "SEA", date: "2026-10-25" },
    ]);
    expect(teams.KC).toEqual({
      6: { opponent: "DEN", home: false, date: "2026-10-18", status: "complete" },
      7: { opponent: "LV", home: true, date: "2026-10-25", status: "pre_game" },
    });
    expect(teams.LV![8]).toEqual({ opponent: "DEN", home: true, date: null, status: null });
    // KC is on bye in week 8: no entry.
    expect(teams.KC![8]).toBeUndefined();
    expect(teams.SF).toBeUndefined();
  });
});

describe("usage from Sleeper's weekly stat lines", () => {
  // The league's scoring: 6-point passing TDs, unlike Sleeper's pts_* fields.
  const scoring = { pass_yd: 0.04, pass_td: 6, rec: 0.5, rec_yd: 0.1, rush_yd: 0.1, rush_td: 6 };
  const players: PlayersIndex = {
    qb1: { player_id: "qb1", position: "QB" },
    wr1: { player_id: "wr1", position: "WR" },
    lb1: { player_id: "lb1", position: "LB" },
  };
  const usage = summarise(
    [
      { week: 4, rows: [] },
      {
        week: 5,
        rows: [
          { player_id: "wr1", team: "KC", opponent: "DEN", stats: { gp: 1, rec: 4, rec_yd: 40, rec_tgt: 6, off_snp: 32, tm_off_snp: 64 } },
        ],
      },
      {
        week: 6,
        rows: [
          {
            player_id: "qb1",
            team: "KC",
            opponent: "LV",
            stats: { gp: 1, pass_td: 2, pass_yd: 250, pts_half_ppr: 18, off_snp: 64, tm_off_snp: 64 },
          },
          {
            player_id: "wr1",
            team: "KC",
            opponent: "LV",
            stats: { gp: 1, rec: 6, rec_yd: 80, rec_tgt: 9, rec_rz_tgt: 2, off_snp: 48, tm_off_snp: 64 },
          },
          // Listed, did not play.
          { player_id: "qb2", team: "KC", opponent: "LV", stats: { pass_yd: 0 } },
          // A defense: id by team code, position only on the row.
          { player_id: "KC", team: "KC", opponent: "LV", stats: { gp: 1, def_int: 2 }, player: { position: "DEF" } },
          // Not a fantasy position.
          { player_id: "lb1", team: "KC", opponent: "LV", stats: { gp: 1, idp_tkl: 9 } },
        ],
      },
    ],
    scoring,
    players,
    "2026",
  );

  test("points are the league's scoring, not Sleeper's half-PPR 4-point-TD total", () => {
    const qb = usage.lines.get("qb1")!;
    expect(qb).toHaveLength(1);
    expect(qb[0]!.points).toBe(2 * 6 + 250 * 0.04);
    expect(qb[0]!.points).not.toBe(18);
  });

  test("snap share, looks, and one line per game in week order", () => {
    const wr = usage.lines.get("wr1")!;
    expect(wr.map((l) => l.week)).toEqual([5, 6]);
    expect(wr[0]).toMatchObject({ snapShare: 0.5, targets: 6, carries: 0, redZone: 0, opponent: "DEN" });
    expect(wr[1]).toMatchObject({ snapShare: 0.75, targets: 9, redZone: 2, points: 6 * 0.5 + 8 });
  });

  test("players who did not play are skipped; defenses have no snap share", () => {
    expect(usage.lines.has("qb2")).toBe(false);
    expect(usage.lines.has("lb1")).toBe(false);
    expect(usage.lines.get("KC")![0]!.snapShare).toBeNull();
    // Weeks with no rows were not covered.
    expect(usage.weeks).toEqual([5, 6]);
  });
});

// ---------------------------------------------------------------------------
// The paid news check's cache
// ---------------------------------------------------------------------------

describe("the news cache", () => {
  const paths = config.paths as { waiverNews: string };
  const saved = paths.waiverNews;
  const realFetch = globalThis.fetch;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  let dir = "";
  let fetches = 0;

  const today = "2026-10-21";
  const req: NewsRequest = {
    today,
    leagueLine: "THE MAIN LEAGUE, 12 teams, half PPR, FAAB.",
    teamLine: "My team is 3-2.",
    candidates: [
      { playerId: "9509", name: "Add One", position: "WR", team: "KC", role: "add", context: "9.1 pts/wk" },
      { playerId: "6794", name: "Drop One", position: "RB", team: "LV", role: "drop", context: "3.0 pts/wk" },
    ],
    moves: [{ add: "9509", drop: "6794", summary: "+1.2 pts/wk weighted, a hold" }],
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "waiver-news-"));
    paths.waiverNews = join(dir, "waiver-news.json");
    // The on-disk shape the provider writes (CACHE_VERSION 1 in src/waiver/news.ts).
    await Bun.write(
      paths.waiverNews,
      JSON.stringify({
        version: 1,
        date: today,
        items: {
          "9509": { playerId: "9509", note: "Took first-team reps Wednesday.", outlook: "up", checkedAt: 1 },
          "6794": { playerId: "6794", note: "", outlook: "unknown", checkedAt: 1 },
        },
        verdicts: { "9509": { add: "9509", verdict: "do", reason: "The role is real.", checkedAt: 1 } },
        summary: "Grab the receiver.",
      }),
    );
    // Any network call - Sleeper or the model - fails the test loudly.
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error("no network in this test");
    }) as unknown as typeof fetch;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    paths.waiverNews = saved;
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    rmSync(dir, { recursive: true, force: true });
  });

  test("everything already checked today costs nothing and calls nobody", async () => {
    const out = await liveNewsProvider().check(req);
    expect(out.costUsd).toBe(0);
    expect(out.searches).toBe(0);
    expect(out.model).toBeNull();
    expect(out.cachedPlayers).toBe(2);
    expect(out.items.map((i) => i.playerId)).toEqual(["9509", "6794"]);
    expect(out.verdicts).toEqual([{ add: "9509", verdict: "do", reason: "The role is real.", checkedAt: 1 }]);
    expect(out.summary).toBe("Grab the receiver.");
    expect(fetches).toBe(0);
  });

  test("today's cache is readable without a call", async () => {
    const c = await liveNewsProvider().cached(today);
    expect(c.items).toHaveLength(2);
    expect(c.verdicts).toHaveLength(1);
    expect(c.summary).toBe("Grab the receiver.");
  });

  test("a different day is a miss", async () => {
    const tomorrow = await liveNewsProvider().cached("2026-10-22");
    expect(tomorrow).toEqual({ items: [], verdicts: [], summary: null });
    // A miss needs the model - which, with no key, is a clear error rather than a call.
    await expect(liveNewsProvider().check({ ...req, today: "2026-10-22" })).rejects.toThrow("ANTHROPIC_API_KEY");
    expect(fetches).toBe(0);
  });

  test("one unchecked player is enough to need a call", async () => {
    const extra = { ...req, candidates: [...req.candidates, { ...req.candidates[0]!, playerId: "1111", name: "New One" }] };
    await expect(liveNewsProvider().check(extra)).rejects.toThrow("ANTHROPIC_API_KEY");
    expect(fetches).toBe(0);
  });
});

describe("the news call, against a canned API response", () => {
  // The real request path - SDK, structured output, usage and search billing -
  // with fetch answering as the Messages API would. No network.
  const paths = config.paths as { waiverNews: string };
  const saved = paths.waiverNews;
  const realFetch = globalThis.fetch;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  let dir = "";
  let calls = 0;

  const req: NewsRequest = {
    today: "2026-10-21",
    leagueLine: "THE MAIN LEAGUE, 12 teams, half PPR, FAAB.",
    teamLine: "My team is 0-6.",
    candidates: [{ playerId: "9509", name: "Add One", position: "QB", team: "NYJ", role: "add", context: "15 pts/wk" }],
    moves: [{ add: "9509", drop: null, summary: "+2.3 pts/wk weighted, a week 8 stream" }],
  };
  const answer = {
    players: [{ id: "9509", note: "Named the starter again on Wednesday.", outlook: "up" }],
    moves: [{ add_id: "9509", verdict: "do", reason: "He keeps the job." }],
    summary: "Stream him for the bye.",
  };

  /** A finished message whose one search returned `searchContent`. */
  function respondWith(searchContent: unknown) {
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [
            { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Add One news" } },
            { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: searchContent },
            { type: "text", text: JSON.stringify(answer) },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 500, server_tool_use: { web_search_requests: 1 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "waiver-news-call-"));
    paths.waiverNews = join(dir, "waiver-news.json");
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    paths.waiverNews = saved;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    rmSync(dir, { recursive: true, force: true });
  });

  test("searches that failed are an error, and nothing is cached", async () => {
    respondWith({ type: "web_search_tool_result_error", error_code: "too_many_requests" });
    await expect(liveNewsProvider().check(req)).rejects.toThrow("web_search too_many_requests");
    expect(await Bun.file(paths.waiverNews).exists()).toBe(false);
  });

  test("a working search is cached per player, and billed for tokens plus searches", async () => {
    respondWith([{ type: "web_search_result", url: "https://example.com", title: "News", encrypted_content: "x", page_age: null }]);
    const before = calls;
    const out = await liveNewsProvider().check(req);
    expect(calls - before).toBe(1);
    expect(out.items.map((i) => [i.playerId, i.outlook])).toEqual([["9509", "up"]]);
    expect(out.verdicts.map((v) => [v.add, v.verdict])).toEqual([["9509", "do"]]);
    expect(out.searches).toBe(1);
    // Opus 5.5: 1000 x $4/M + 500 x $20/M + one search at $0.01.
    expect(out.costUsd).toBeCloseTo(0.004 + 0.01 + 0.01, 4);
    // And the same question again is free.
    const again = await liveNewsProvider().check(req);
    expect(calls - before).toBe(1);
    expect(again.costUsd).toBe(0);
  });
});

describe("a refresh with failed fetches keeps the last good data", () => {
  const claim = { playerId: "p1", rosterId: 1, bid: 3, week: 6, at: 1 };
  const good = {
    claims: [claim],
    failedClaims: [],
    drops: [{ playerId: "p2", rosterId: 2, week: 7, at: 2 }],
    trendingAdds: new Map([["p3", 9_000]]),
    trendingDrops: new Map(),
    failedWeeks: [],
    trendingOk: true,
    fetchedAt: 1,
  } satisfies LeagueActivity;

  test("a failed transactions week does not forget who is on waivers", () => {
    const blip = { ...good, claims: [], drops: [], failedWeeks: [7], fetchedAt: 2 };
    const merged = mergeActivity(good, blip);
    expect(merged.claims).toEqual(good.claims);
    expect(merged.drops).toEqual(good.drops);
  });

  test("failed trending keeps the previous lists; a clean refresh replaces everything", () => {
    const noTrend = { ...good, trendingAdds: new Map(), trendingOk: false };
    expect(mergeActivity(good, noTrend).trendingAdds.get("p3")).toBe(9_000);
    const fresh = { ...good, claims: [], drops: [], trendingAdds: new Map() };
    expect(mergeActivity(good, fresh)).toBe(fresh);
  });
});

describe("the news call when the search budget runs out mid-check", () => {
  // The live failure of 2026-10-22: the model searched from code, the budget
  // ran out after one player, and the limit showed up only in the code run's
  // stderr. What was searched is kept; the rest is asked again next time.
  const paths = config.paths as { waiverNews: string };
  const saved = paths.waiverNews;
  const realFetch = globalThis.fetch;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  let dir = "";

  const req: NewsRequest = {
    today: "2026-10-22",
    leagueLine: "THE MAIN LEAGUE, 12 teams, half PPR, FAAB.",
    teamLine: "My team is 0-6.",
    candidates: [
      { playerId: "1373", name: "Geno Smith", position: "QB", team: "NYJ", role: "add", context: "15 pts/wk" },
      { playerId: "PHI", name: "Philadelphia Eagles", position: "DEF", team: "PHI", role: "add", context: "8 pts/wk" },
    ],
    moves: [
      { add: "1373", drop: null, summary: "+2.3 pts/wk weighted, a week 8 stream" },
      { add: "PHI", drop: null, summary: "+1.8 pts/wk weighted, a hold" },
    ],
  };
  const answer = {
    players: [
      { id: "1373", note: "Named the starter again Wednesday.", outlook: "up" },
      { id: "PHI", note: "Couldn't check - the search limit ran out.", outlook: "unknown" },
    ],
    moves: [
      { add_id: "1373", verdict: "do", reason: "He keeps the job." },
      { add_id: "PHI", verdict: "consider", reason: "No news found." },
    ],
    summary: "Stream Geno.",
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "waiver-news-budget-"));
    paths.waiverNews = join(dir, "waiver-news.json");
    process.env.ANTHROPIC_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "msg_budget",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [
            { type: "server_tool_use", id: "srv_1", name: "code_execution", input: { code: "..." } },
            { type: "server_tool_use", id: "srv_2", name: "web_search", input: { query: "Geno Smith Jets injury news" } },
            { type: "web_search_tool_result", tool_use_id: "srv_2", content: [{ type: "web_search_result", url: "https://example.com", title: "x", encrypted_content: "x", page_age: null }] },
            {
              type: "code_execution_tool_result",
              tool_use_id: "srv_1",
              content: { type: "encrypted_code_execution_result", encrypted_stdout: "x", stderr: "Server tool use limit exceeded", return_code: 1 },
            },
            { type: "text", text: JSON.stringify(answer) },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 500, server_tool_use: { web_search_requests: 8 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    paths.waiverNews = saved;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps the searched player, leaves the unsearched one for next time, and says so", async () => {
    const out = await liveNewsProvider().check(req);
    expect(out.unchecked).toEqual(["Philadelphia Eagles"]);
    expect(out.items.map((i) => i.playerId)).toEqual(["1373"]);
    expect(out.verdicts.map((v) => v.add)).toEqual(["1373"]);
    const cached = await liveNewsProvider().cached(req.today);
    expect(cached.items.map((i) => i.playerId)).toEqual(["1373"]);
    expect(cached.verdicts.map((v) => v.add)).toEqual(["1373"]);
  });
});
