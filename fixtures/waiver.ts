/**
 * The fixture league, on waiver day, for the waiver analyzer.
 *
 * Wraps the trade fixture league (same rosters, same weekly projections) and adds
 * what the wire needs, in the shapes observed live on 2026-10-21: FAAB settings
 * and budgets, rolling waiver priority, saved lineups, a season of transactions
 * (weekly runs at Wednesday 03:08 ET with winning, outbid and roster-limit
 * claims), a fresh drop still on waivers, Sleeper-wide trending, recent box
 * scores, the NFL schedule, and the fantasy schedule.
 *
 * It draws from its own seeded generator so the trade fixture league - and every
 * trade test pinned to it - is unchanged. Dates hang off `now`, so the demo can
 * run on any day and tests pin it.
 */

import { makeFixtureTradeLeague, fixtureTradeSource, TRADE_FIXTURE_MY_ROSTER, type FixtureTradeLeague } from "./trade.ts";
import { makeFixtureByes, NFL_TEAMS } from "./index.ts";
import { summariseActivity } from "../src/data/activity.ts";
import { etToEpoch } from "../src/waiver/availability.ts";
import { buildUniverse } from "../src/trade/value.ts";
import { lineupFor } from "../src/waiver/streams.ts";
import type { TeamSchedule } from "../src/data/schedule.ts";
import type { UsageIndex, WeekLine } from "../src/data/usage.ts";
import type { TradeDataSource } from "../src/server/trades.ts";
import type { WaiverExtras, WaiverExtrasSource } from "../src/server/waivers.ts";
import type { Roster, Transaction } from "../src/sleeper/types.ts";

export const WAIVER_FIXTURE_MY_ROSTER = TRADE_FIXTURE_MY_ROSTER;
/** Wednesday 2026-10-21, 11:00 ET - after the weekly run, before any week-7 game. */
export const WAIVER_FIXTURE_NOW = etToEpoch(2026, 10, 21, 11, 0);

export interface FixtureWaiverLeague {
  trade: FixtureTradeLeague;
  extras: WaiverExtras;
  now: number;
  /** A free agent dropped six hours ago - still on waivers. */
  freshDrop: string;
  /** The starter left on your bench in the saved lineup. */
  benchedStarter: string;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function makeFixtureWaiverLeague(opts: { now?: number; seed?: number } = {}): FixtureWaiverLeague {
  const now = opts.now ?? WAIVER_FIXTURE_NOW;
  const rand = mulberry32(opts.seed ?? 20261021);
  const base = makeFixtureTradeLeague();
  const nflWeek = base.nflWeek;

  const league = {
    ...base.league,
    settings: {
      ...base.league.settings,
      waiver_type: 2,
      waiver_budget: 100,
      waiver_clear_days: 1,
      waiver_day_of_week: 2,
      daily_waivers: 0,
      reserve_allow_out: 1,
      reserve_allow_doubtful: 1,
      reserve_allow_cov: 1,
      reserve_allow_sus: 0,
      reserve_allow_dnr: 0,
      reserve_allow_na: 0,
    },
  };

  // Give your roster the classic waiver-day problem: its only QB is on bye next
  // week. Swap in the best QB whose team has that bye (the other team gets yours)
  // and trade any backup QB for a middling free-agent receiver, so the roster
  // keeps its size and every other team its strength.
  const byesAll = makeFixtureByes();
  const nextWeek = base.weeks[1]!;
  const leagueRosters = base.rosters.map((r) => ({ ...r, players: [...(r.players ?? [])], reserve: [...(r.reserve ?? [])] }));
  const myRoster = leagueRosters.find((r) => r.roster_id === WAIVER_FIXTURE_MY_ROSTER)!;
  const posOf = (id: string) => base.players[id]?.position;
  const total = (id: string) => (base.weekly.get(id) ?? []).reduce((a, b) => a + b, 0);
  const byTotal = (a: string, b: string) => total(b) - total(a) || a.localeCompare(b);
  const myQbs = myRoster.players.filter((id) => posOf(id) === "QB").sort(byTotal);
  const byeQb = Object.keys(base.players)
    .filter((id) => posOf(id) === "QB" && base.weekly.has(id) && !myRoster.players.includes(id))
    .filter((id) => byesAll[base.players[id]?.team ?? ""] === nextWeek)
    .filter((id) => !leagueRosters.some((r) => r.reserve.includes(id)))
    .sort(byTotal)[0];
  if (byeQb && myQbs[0]) {
    const owner = leagueRosters.find((r) => r.players.includes(byeQb));
    if (owner) owner.players = owner.players.map((id) => (id === byeQb ? myQbs[0]! : id));
    myRoster.players = myRoster.players.map((id) => (id === myQbs[0] ? byeQb : id));
    const taken = new Set(leagueRosters.flatMap((r) => r.players));
    const fillers = Object.keys(base.players)
      .filter((id) => posOf(id) === "WR" && base.weekly.has(id) && !taken.has(id))
      .sort(byTotal)
      .slice(20);
    for (const backup of myQbs.slice(1)) {
      const filler = fillers.shift();
      if (filler) myRoster.players = myRoster.players.map((id) => (id === backup ? filler : id));
    }
  }

  // The league's weekly projections as a universe, to set lineups from.
  const tradeRosters = leagueRosters.map((r) => ({ rosterId: r.roster_id, players: r.players, reserve: r.reserve }));
  const u = buildUniverse({ league, rosters: tradeRosters, players: base.players, weekly: base.weekly, weeks: base.weeks, byeWeek: base.byeWeek });
  const startSlots = league.roster_positions.filter((s) => s !== "BN" && s !== "IR");

  let benchedStarter = "";
  const rosters: Roster[] = leagueRosters.map((r) => {
    const active = (r.players ?? []).filter((id) => !(r.reserve ?? []).includes(id));
    const fills = lineupFor({ ...u, injuryRate: 0 }, active, 0);
    // Sleeper's lineup is in roster_positions order; the optimiser's in slot order.
    const byLabel = new Map<string, string[]>();
    for (const f of fills) byLabel.set(f.label, [...(byLabel.get(f.label) ?? []), f.id ?? "0"]);
    const starters = startSlots.map((label) => byLabel.get(label)?.shift() ?? "0");
    if (r.roster_id === WAIVER_FIXTURE_MY_ROSTER) {
      // Leave your best WR on the bench behind your worst bench WR - the lineup alert's case.
      const wrSlot = startSlots.indexOf("WR");
      const bench = active.filter((id) => !starters.includes(id) && base.players[id]?.position === "WR");
      bench.sort((a, b) => (u.players.get(a)?.weekly[0] ?? 0) - (u.players.get(b)?.weekly[0] ?? 0));
      if (wrSlot >= 0 && bench[0]) {
        benchedStarter = starters[wrSlot]!;
        starters[wrSlot] = bench[0];
      }
    }
    const used = r.roster_id === 2 || r.roster_id === 5 ? 100 : (r.roster_id * 13) % 90;
    return {
      ...r,
      starters,
      settings: { ...r.settings, waiver_budget_used: used, waiver_position: ((r.roster_id * 5) % 12) + 1 },
    };
  });

  // --- the NFL schedule: byes from the fixture, everyone else paired off ----
  const byes = byesAll;
  const anchorSunday = nextSunday(now);
  const schedule: TeamSchedule = {};
  for (let week = 1; week <= 18; week++) {
    const playing = NFL_TEAMS.filter((t) => byes[t] !== week);
    // Rotate so opponents change week to week.
    const k = week % playing.length;
    const order = [...playing.slice(k), ...playing.slice(0, k)];
    const sunday = anchorSunday + (week - nflWeek) * 7 * DAY;
    // An odd count leaves one team over; it plays the first team again rather
    // than taking a bye its projections never had.
    if (order.length % 2) order.push(order[0]!);
    for (let i = 0; i + 1 < order.length; i += 2) {
      const home = order[i]!;
      const away = order[i + 1]!;
      // The first game of each week is Thursday night.
      const day = i === 0 ? sunday - 3 * DAY : sunday;
      const date = isoDate(day);
      const status = week < nflWeek ? "complete" : "pre_game";
      (schedule[home] ??= {})[week] = { opponent: away, home: true, date, status };
      (schedule[away] ??= {})[week] = { opponent: home, home: false, date, status };
    }
  }

  // --- the fantasy schedule: a round robin over the remaining regular season ----
  const ids = rosters.map((r) => r.roster_id);
  const lastRegular = (league.settings.playoff_week_start ?? 15) - 1;
  const matchups = new Map<number, Array<[number, number]>>();
  base.weeks
    .filter((w) => w <= lastRegular)
    .forEach((week, round) => {
      const rot = [ids[0]!, ...rotate(ids.slice(1), round)];
      const pairs: Array<[number, number]> = [];
      for (let i = 0; i < rot.length / 2; i++) pairs.push([rot[i]!, rot[rot.length - 1 - i]!]);
      matchups.set(week, pairs);
    });

  // --- transactions: a season of weekly runs, plus today's fresh drop ----
  const rostered = new Set(rosters.flatMap((r) => r.players ?? []));
  const freeAgents = u.freeAgents.filter((id) => !rostered.has(id));
  // The fresh drop: a startable free agent another team cut six hours ago.
  const freshDrop = freeAgents.find((id) => (u.players.get(id)?.rosTotal ?? 0) > 40 && u.players.get(id)?.position !== "DEF")!;
  const pages: Array<{ week: number; rows: Transaction[] }> = [];
  for (let week = 2; week <= nflWeek; week++) {
    const run = etToEpoch(2026, 9, 16, 3, 8) + (week - 2) * 7 * DAY;
    const rows: Transaction[] = [];
    for (let n = 0; n < 6; n++) {
      const player = [...rostered][Math.floor(rand() * rostered.size)]!;
      const bidders = 1 + Math.floor(rand() * 4);
      const bids = Array.from({ length: bidders }, () => Math.floor(rand() * 20)).sort((a, b) => b - a);
      bids.forEach((bid, i) => {
        const rosterId = ids[(n * 3 + i * 5 + week) % ids.length]!;
        rows.push({
          type: "waiver",
          status: i === 0 ? "complete" : "failed",
          roster_ids: [rosterId],
          adds: { [player]: rosterId },
          drops: null,
          settings: { waiver_bid: bid, seq: n },
          metadata: {
            notes: i === 0 ? "Your waiver claim was processed successfully!" : i === 1 && n === 0
              ? "Unfortunately, your roster will have too many players after this transaction."
              : "This player was claimed by another owner.",
          },
          created: run - DAY,
          status_updated: run,
          leg: week,
        });
      });
    }
    pages.push({ week, rows });
  }
  pages.at(-1)!.rows.push({
    type: "free_agent",
    status: "complete",
    roster_ids: [7],
    adds: null,
    drops: { [freshDrop]: 7 },
    created: now - 6 * HOUR,
    status_updated: now - 6 * HOUR,
    leg: nflWeek,
  });
  const hot = freeAgents.filter((id) => id !== freshDrop).slice(0, 3);
  const myBench = (rosters.find((r) => r.roster_id === WAIVER_FIXTURE_MY_ROSTER)!.players ?? []).slice(-1);
  const activity = summariseActivity(
    pages,
    [
      { player_id: hot[0]!, count: 520_000 },
      { player_id: hot[1]!, count: 40_000 },
      { player_id: hot[2]!, count: 3_000 },
    ],
    myBench.map((id) => ({ player_id: id, count: 150_000 })),
    now,
  );

  // --- recent box scores: weeks 4-6, near each player's projection ----
  const lines = new Map<string, WeekLine[]>();
  for (const [id, p] of u.players) {
    const perGame = p.rosTotal / Math.max(1, u.weeks.length);
    if (perGame <= 0) continue;
    const list: WeekLine[] = [];
    for (const week of [4, 5, 6]) {
      if (p.team && byes[p.team] === week) continue;
      list.push({
        week,
        team: p.team,
        opponent: p.team ? (schedule[p.team]?.[week]?.opponent ?? null) : null,
        points: Math.round(perGame * (0.6 + rand() * 0.8) * 10) / 10,
        snapShare: p.position === "DEF" || p.position === "K" ? null : Math.round((0.3 + rand() * 0.6) * 100) / 100,
        targets: p.position === "WR" || p.position === "TE" ? Math.floor(rand() * 9) : Math.floor(rand() * 3),
        carries: p.position === "RB" ? Math.floor(rand() * 18) : 0,
        redZone: Math.floor(rand() * 3),
      });
    }
    if (list.length) lines.set(id, list);
  }
  const usage: UsageIndex = { season: league.season, weeks: [4, 5, 6], lines, fetchedAt: now };

  return {
    trade: { ...base, league, rosters },
    extras: { activity, usage, schedule, matchups, scoredThisWeek: new Map(ids.map((id) => [id, 0])) },
    now,
    freshDrop,
    benchedStarter,
  };
}

/** The fixture league as the waiver service's two data sources. */
export function fixtureWaiverSources(fx: FixtureWaiverLeague = makeFixtureWaiverLeague()): {
  trade: TradeDataSource;
  extras: WaiverExtrasSource;
} {
  return {
    trade: fixtureTradeSource(fx.trade),
    extras: {
      load: async () => fx.extras,
      refresh: async () => fx.extras,
    },
  };
}

function rotate<T>(xs: T[], k: number): T[] {
  const n = xs.length;
  const s = ((k % n) + n) % n;
  return [...xs.slice(n - s), ...xs.slice(0, n - s)];
}

/** The next Sunday (Eastern) strictly after `now`, at midnight UTC of that date. */
function nextSunday(now: number): number {
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now + i * DAY);
    const ny = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
    const [y, m, day] = ny.split("-").map(Number) as [number, number, number];
    const utc = Date.UTC(y, m - 1, day);
    if (new Date(utc).getUTCDay() === 0) return utc;
  }
  return now;
}

const isoDate = (utcMidnight: number): string => new Date(utcMidnight).toISOString().slice(0, 10);
