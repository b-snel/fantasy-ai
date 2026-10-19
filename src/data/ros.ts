/**
 * Rest-of-season weekly projections, for the trade analyzer.
 *
 * The draft needed one number per player - a season total. A trade in week 7
 * needs the weeks that are left, one at a time: who is on bye when, who comes back
 * from IR in week 10, who is fading. Sleeper's weekly projections (verified live
 * 2026-10-19) carry all of that: they are refreshed every week through the season,
 * IR players project zero until their expected return, and bye weeks are simply
 * absent. So this sums nothing - it keeps the weeks separate and lets the lineup
 * optimiser see them.
 *
 * Same undocumented host as the draft projections, same rule: if it disappears,
 * fall back to season totals spread evenly (with byes zeroed when known), and say
 * so in the UI rather than fail.
 */

import { config } from "../config.ts";
import { getJson, readCache, writeCache } from "../sleeper/client.ts";
import { scoreStatLine, type StatLine } from "../engine/scoring.ts";
import type { League, NflState, PlayersIndex, ScoringSettings } from "../sleeper/types.ts";
import type { ProjectionTable } from "./projections.ts";
import type { ByeWeeks } from "./schedule.ts";

export type RosSource = "sleeper_weekly" | "season_fallback";

export interface RosProjections {
  weeks: number[];
  /** playerId -> projected points per week, aligned to `weeks`. */
  weekly: Map<string, number[]>;
  /**
   * Why a zero is a zero. A projected zero means three different things - a bye,
   * a game already played this week, or a player who is out - and only the last
   * is news. Sleeper marks a bye as a row with no opponent and no date.
   */
  byeWeek: Map<string, number>;
  /** Players whose game this week is already over. */
  played: Set<string>;
  source: RosSource;
  fetchedAt: number;
}

interface RosCache {
  key: string;
  weeks: number[];
  source: RosSource;
  fetchedAt: number;
  rows: Array<[string, number[]]>;
  byes: Array<[string, number]>;
  played: string[];
}

interface WeeklyRow {
  player_id?: string;
  /** Game date, YYYY-MM-DD. Null on a bye. */
  date?: string | null;
  /** Null on a bye. */
  opponent?: string | null;
  stats?: StatLine;
  player?: { position?: string | null } | null;
}

interface Weekly {
  weekly: Map<string, number[]>;
  byeWeek: Map<string, number>;
  played: Set<string>;
}

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** Bump when RosCache changes shape, so an old file is a miss rather than half-read. */
const CACHE_VERSION = 2;

/**
 * The last week fantasy points matter: the end of the league's playoffs. A
 * six-team bracket is three rounds, so playoffs starting week 15 end week 17.
 */
export function lastFantasyWeek(league: League): number {
  const start = league.settings?.playoff_week_start ?? 0;
  if (!start) return 17;
  const teams = Math.max(2, league.settings?.playoff_teams ?? 6);
  const rounds = Math.ceil(Math.log2(teams));
  return Math.min(18, start + rounds - 1);
}

/**
 * Which weeks are still worth trading for. Before the season that is all of
 * them; during it, the current week onward (games already played that week are
 * zeroed per player by date); after the fantasy playoffs, none.
 */
export function rosWindow(state: NflState, league: League): { from: number; to: number } | null {
  const to = lastFantasyWeek(league);
  if (state.season_type === "post") return null;
  const from = state.season_type === "regular" ? Math.max(1, state.week) : 1;
  return from > to ? null : { from, to };
}

/** Today's date where NFL games are scheduled, as YYYY-MM-DD. */
export function easternDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

export async function getRosProjections(opts: {
  season: string;
  from: number;
  to: number;
  scoring: ScoringSettings;
  players: PlayersIndex;
  /** Used only if the weekly host fails. */
  fallback?: () => Promise<{ season: ProjectionTable; byes: ByeWeeks }>;
  force?: boolean;
  today?: string;
}): Promise<RosProjections> {
  const { season, from, to, scoring, players } = opts;
  const today = opts.today ?? easternDate();
  const weeks = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  // The date is in the key: "already played this week" moves with the calendar,
  // so yesterday's cache is wrong about today even if it is young.
  const key = `v${CACHE_VERSION}:${season}:${from}-${to}:${today}:${Bun.hash(JSON.stringify(scoring)).toString(36)}`;

  if (!opts.force) {
    const cached = await readCache<RosCache>(config.paths.ros, MAX_AGE_MS);
    if (cached?.key === key && cached.rows.length) {
      return {
        weeks: cached.weeks,
        weekly: new Map(cached.rows),
        byeWeek: new Map(cached.byes ?? []),
        played: new Set(cached.played ?? []),
        source: cached.source,
        fetchedAt: cached.fetchedAt,
      };
    }
  }

  let fetched: Weekly | null = null;
  try {
    fetched = await fetchWeekly(season, weeks, scoring, players, today);
  } catch (err) {
    console.warn(`[ros] weekly projections failed: ${err instanceof Error ? err.message : err}`);
  }

  let source: RosSource = "sleeper_weekly";
  if (!fetched || fetched.weekly.size === 0) {
    if (!opts.fallback) throw new Error("Rest-of-season projections are unavailable.");
    console.warn("[ros] falling back to season totals spread evenly - byes only, no injury timing");
    const { season: table, byes } = await opts.fallback();
    fetched = spreadSeason(table, players, byes, weeks);
    source = "season_fallback";
  }

  const result: RosProjections = { weeks, ...fetched, source, fetchedAt: Date.now() };
  await writeCache(config.paths.ros, {
    key,
    weeks,
    source,
    fetchedAt: result.fetchedAt,
    rows: [...result.weekly],
    byes: [...result.byeWeek],
    played: [...result.played],
  } satisfies RosCache);
  return result;
}

export async function fetchWeekly(
  season: string,
  weeks: number[],
  scoring: ScoringSettings,
  players: PlayersIndex,
  today: string,
): Promise<Weekly> {
  const positionQuery = POSITIONS.map((p) => `position[]=${p}`).join("&");
  const out = new Map<string, number[]>();
  const byeWeek = new Map<string, number>();
  const played = new Set<string>();
  let weeksWithData = 0;

  // One request per week, in parallel - the rate limiter in getJson paces them.
  const pages = await Promise.all(
    weeks.map((week) =>
      getJson<WeeklyRow[]>(
        `${config.sleeper.dataBase}/projections/nfl/${season}/${week}?season_type=regular&${positionQuery}`,
        { retries: 1, timeoutMs: 30_000 },
      ),
    ),
  );

  pages.forEach((rows, w) => {
    if (!rows?.length) return;
    weeksWithData++;
    for (const row of rows) {
      const id = row.player_id;
      if (!id) continue;
      const list = out.get(id) ?? weeks.map(() => 0);
      out.set(id, list);
      if (!row.opponent && !row.date) {
        byeWeek.set(id, weeks[w]!);
        continue;
      }
      // A game already played this week is no longer something a trade can buy.
      if (w === 0 && row.date && row.date < today) {
        played.add(id);
        continue;
      }
      const position = players[id]?.position ?? row.player?.position ?? null;
      const pts = scoreStatLine(row.stats ?? {}, scoring, position);
      list[w] = Math.round(pts * 100) / 100;
    }
  });

  if (weeksWithData === 0) return { weekly: new Map(), byeWeek, played };
  if (weeksWithData < weeks.length) {
    console.warn(`[ros] only ${weeksWithData} of ${weeks.length} weeks returned projections`);
  }
  return { weekly: out, byeWeek, played };
}

/** The fallback: season pace per game, zero on the bye. */
export function spreadSeason(
  table: ProjectionTable,
  players: PlayersIndex,
  byes: ByeWeeks,
  weeks: number[],
): Weekly {
  const weekly = new Map<string, number[]>();
  const byeWeek = new Map<string, number>();
  for (const [id, row] of table) {
    const team = players[id]?.team ?? null;
    const bye = team ? byes[team] : undefined;
    if (bye != null && weeks.includes(bye)) byeWeek.set(id, bye);
    const perGame = row.points / 17;
    weekly.set(
      id,
      weeks.map((w) => (bye === w ? 0 : Math.round(perGame * 100) / 100)),
    );
  }
  return { weekly, byeWeek, played: new Set() };
}
