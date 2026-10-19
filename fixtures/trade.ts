/**
 * An in-season league for the trade analyzer, built offline.
 *
 * THE MAIN LEAGUE's real settings (no kicker, two flex, half PPR, 6-pt passing
 * TDs), twelve rosters drafted from the synthetic player pool by an ADP-with-noise
 * snake, and weekly projections for weeks 7-17 that carry what the live data
 * carries: bye weeks at zero, and injured players returning partway through.
 * Deterministic, so tests and the demo see the same league every run.
 */

import realLeagueJson from "./real-league.json" with { type: "json" };
import { makeFixtureByes, makeFixturePlayers } from "./index.ts";
import { projectionsFromSearchRank } from "../src/data/projections.ts";
import type { League, LeagueUser, PlayersIndex, Roster } from "../src/sleeper/types.ts";
import type { TradeData, TradeDataSource } from "../src/server/trades.ts";
import type { TradeReviewer, TradeVerdict } from "../src/llm/trade-review.ts";

export const TRADE_FIXTURE_USER_ID = "434221843767881728";
export const TRADE_FIXTURE_MY_ROSTER = 3;
export const TRADE_FIXTURE_WEEKS = Array.from({ length: 11 }, (_, i) => i + 7);

export interface FixtureTradeLeague {
  league: League;
  players: PlayersIndex;
  rosters: Roster[];
  users: LeagueUser[];
  weekly: Map<string, number[]>;
  weeks: number[];
  byeWeek: Map<string, number>;
  nflWeek: number;
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

/** Per-team position caps for the fixture draft - no kicker slot, so no kickers. */
const CAPS: Record<string, number> = { QB: 2, RB: 6, WR: 7, TE: 2, DEF: 1, K: 0 };

export function makeFixtureTradeLeague(seed = 20261019): FixtureTradeLeague {
  const rand = mulberry32(seed);
  const base = realLeagueJson as unknown as League;
  const league: League = {
    ...base,
    status: "in_season",
    settings: { ...base.settings, reserve_slots: 2, trade_deadline: 11 },
  };
  const players = makeFixturePlayers();
  const byes = makeFixtureByes();
  const season = projectionsFromSearchRank(players, league.scoring_settings);
  const weeks = TRADE_FIXTURE_WEEKS;

  // Weekly projections: season pace with a little week-to-week noise, zero on the
  // bye, and anyone carrying an IR tag out for the first three weeks of the window.
  const weekly = new Map<string, number[]>();
  const byeWeek = new Map<string, number>();
  for (const [id, row] of season) {
    const p = players[id];
    const bye = p?.team ? byes[p.team] : undefined;
    if (bye != null && weeks.includes(bye)) byeWeek.set(id, bye);
    const perGame = row.points / 17;
    weekly.set(
      id,
      weeks.map((week, i) => {
        if (p?.team && byes[p.team] === week) return 0;
        if (p?.injury_status === "IR" && i < 3) return 0;
        return Math.round(perGame * (0.85 + rand() * 0.3) * 10) / 10;
      }),
    );
  }

  // Snake draft, 15 rounds, near ADP with noise and roster caps.
  const teams = league.total_rosters;
  const rounds = 15;
  const adpOrder = [...season.values()]
    .filter((r) => r.adp != null)
    .sort((a, b) => (a.adp ?? 0) - (b.adp ?? 0))
    .map((r) => r.playerId);
  const owned = Array.from({ length: teams }, () => [] as string[]);
  const taken = new Set<string>();

  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? [...owned.keys()] : [...owned.keys()].reverse();
    for (const team of order) {
      const roster = owned[team]!;
      const count = (pos: string) => roster.filter((id) => players[id]?.position === pos).length;
      // The last pick goes to a defense if the team has none.
      const needDef = round === rounds - 1 && count("DEF") === 0;
      const options = adpOrder.filter((id) => {
        if (taken.has(id)) return false;
        const pos = players[id]?.position ?? "";
        if (needDef) return pos === "DEF";
        return count(pos) < (CAPS[pos] ?? 0);
      });
      const pick = options[Math.floor(rand() * Math.min(4, options.length))] ?? options[0];
      if (!pick) continue;
      roster.push(pick);
      taken.add(pick);
    }
  }

  const rosters: Roster[] = owned.map((ids, i) => {
    const rosterId = i + 1;
    // Injured players sit in IR when there is room, as they would in Sleeper.
    const reserve = ids.filter((id) => players[id]?.injury_status === "IR").slice(0, 2);
    return {
      roster_id: rosterId,
      owner_id: rosterId === TRADE_FIXTURE_MY_ROSTER ? TRADE_FIXTURE_USER_ID : `u${rosterId}`,
      league_id: league.league_id,
      players: ids,
      starters: [],
      reserve,
      settings: { wins: (rosterId * 7) % 6, losses: 5 - ((rosterId * 7) % 6), fpts: 480 + rosterId * 9 },
    };
  });

  const users: LeagueUser[] = rosters.map((r) => ({
    user_id: r.owner_id!,
    display_name: r.roster_id === TRADE_FIXTURE_MY_ROSTER ? "Tugger_Woods" : `Manager${r.roster_id}`,
    metadata: { team_name: r.roster_id === TRADE_FIXTURE_MY_ROSTER ? "Fixture FC" : `Team ${r.roster_id}` },
  }));

  return { league, players, rosters, users, weekly, weeks, byeWeek, nflWeek: weeks[0]! };
}

/** The fixture league as a trade data source, for the demo and server tests. */
export function fixtureTradeSource(fx: FixtureTradeLeague = makeFixtureTradeLeague()): TradeDataSource {
  const data = (): TradeData => ({
    league: fx.league,
    players: fx.players,
    rosters: fx.rosters,
    users: fx.users,
    weekly: fx.weekly,
    weeks: fx.weeks,
    byeWeek: fx.byeWeek,
    played: new Set(),
    nflWeek: fx.nflWeek,
    source: "sleeper_weekly",
    userId: TRADE_FIXTURE_USER_ID,
  });
  return {
    load: async () => data(),
    rosters: async () => ({ rosters: fx.rosters, users: fx.users }),
  };
}

/**
 * A stand-in for Claude, so the demo and the tests can drive deep analysis end
 * to end without an API key. It walks the same path the real reviewer does - steps
 * reported as it goes, the engine called through the same tools - and writes a
 * verdict from what the engine says. It searches nothing, and says so.
 */
export function cannedReviewer(opts: { delayMs?: number; fail?: string } = {}): TradeReviewer {
  const pause = () => new Promise((r) => setTimeout(r, opts.delayMs ?? 350));
  return {
    unavailable: () => null,
    review: async ({ trade, engine, onStep }) => {
      const step = (kind: "start" | "search" | "engine" | "think" | "write", text: string) =>
        onStep?.({ kind, text, at: Date.now() });
      step("start", "Reading the engine's briefing");
      await pause();
      for (const name of [...trade.give, ...trade.get]) {
        step("search", `(demo) would search the web: ${name} news`);
        await pause();
      }
      if (opts.fail) throw new Error(opts.fail);

      step("engine", `Testing ${trade.give.join(" + ")} for ${trade.get.join(" + ")}`);
      const asked = (await engine.evaluate(trade.give, trade.get)) as EngineCheck;
      await pause();

      let counter: TradeVerdict["counter_offer"] = null;
      if (!asked.clears_bar) {
        step("engine", `Searching the engine with ${trade.partner}`);
        const found = (await engine.find({ give: [trade.give[0]!], team: trade.partner })) as { trades: EngineCheck[] };
        const best = found.trades[0];
        if (best) {
          counter = {
            give: best.you_give.map((p) => p.player),
            get: best.you_get.map((p) => p.player),
            why: "The engine's best version of this deal with the same partner.",
          };
        }
      }
      step("write", "Writing the verdict");
      await pause();

      const verdict: TradeVerdict = {
        decision: asked.clears_bar ? "accept" : counter ? "counter" : "decline",
        confidence: "medium",
        headline: asked.clears_bar
          ? `Demo verdict: the engine likes it (${signed(asked.your_change_per_week)}/wk for you).`
          : counter
            ? `Demo verdict: counter with ${counter.give.join(" + ")} for ${counter.get.join(" + ")}.`
            : "Demo verdict: walk away - nothing nearby clears the bar.",
        summary:
          "This is the offline demo reviewer, not Claude: it read the engine's numbers and nothing else. " +
          "Run the real server with ANTHROPIC_API_KEY set for news, standings and judgment.",
        for_you: [`Your lineup ${signed(asked.your_change_per_week)} pts/wk by the engine.`],
        against: asked.problems.length ? asked.problems : ["No news was checked - this is the demo."],
        news: [],
        standings: "The demo reviewer does not weigh the standings.",
        roster_after: asked.you_cut.length ? `You would cut ${asked.you_cut.join(", ")}.` : "No cuts needed.",
        counter_offer: counter,
        pitch: asked.clears_bar || counter ? "Hey - would you be up for a trade? (demo message)" : null,
      };
      return {
        verdict,
        usage: {
          model: "demo",
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          latencyMs: 0,
        },
        servedBy: "demo reviewer (no API call)",
        searches: 0,
        engineCalls: counter ? 2 : 1,
        sources: [],
      };
    },
  };
}

interface EngineCheck {
  you_give: Array<{ player: string }>;
  you_get: Array<{ player: string }>;
  your_change_per_week: number;
  clears_bar: boolean;
  problems: string[];
  you_cut: string[];
}

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n).toFixed(1)}`;
