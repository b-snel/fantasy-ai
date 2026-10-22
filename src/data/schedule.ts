/**
 * Bye weeks.
 *
 * A bye week is the one schedule fact that matters at draft time — stacking three
 * starters on the same bye is a self-inflicted loss in week 9. Full strength-of-
 * schedule modelling is deliberately out of scope: preseason SOS is a weak signal
 * and spending draft capital on it is a well-known way to be wrong confidently.
 */

import { config } from "../config.ts";
import { getJson, readCache, writeCache } from "../sleeper/client.ts";
import type { Capabilities } from "./capabilities.ts";

export type ByeWeeks = Record<string, number>;

export interface ScheduleGame {
  week?: number;
  home?: string;
  away?: string;
  /** "pre_game" | "in_game" | "complete" (verified live 2026-10-21). */
  status?: string;
  /** YYYY-MM-DD, Eastern. No kickoff time is published. */
  date?: string;
}

/**
 * Derive byes from the season schedule: a team's bye is the regular-season week in
 * which it does not appear. Deriving beats hardcoding — the table would be stale
 * the moment the NFL publishes a new season.
 */
export async function getByeWeeks(opts: {
  season: string;
  teams: string[];
  capabilities: Capabilities;
  force?: boolean;
}): Promise<ByeWeeks> {
  const { season, teams, capabilities, force = false } = opts;

  if (!force) {
    const cached = await readCache<ByeWeeks>(config.paths.schedule, 7 * 24 * 60 * 60 * 1000);
    if (cached && Object.keys(cached).length) return cached;
  }

  if (!capabilities.schedule) return {};

  try {
    const url = `${config.sleeper.dataBase}/schedule/nfl/regular/${season}`;
    const games = await getJson<ScheduleGame[]>(url, { retries: 1 });
    if (!games?.length) return {};

    const byes = deriveByeWeeks(games, teams);
    await writeCache(config.paths.schedule, byes);
    return byes;
  } catch (err) {
    console.warn(`[schedule] bye-week lookup failed: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

export interface TeamGame {
  opponent: string;
  home: boolean;
  /** YYYY-MM-DD; null when Sleeper has not dated it. */
  date: string | null;
  status: string | null;
}

/** team -> week -> its game. Absent weeks are byes. */
export type TeamSchedule = Record<string, Record<number, TeamGame>>;

/** Bump when the cached shape changes, so an old file is a miss rather than half-read. */
const TEAM_SCHEDULE_VERSION = 1;
/** Game status flips to in_game/complete during the week; keep this short. */
const TEAM_SCHEDULE_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * The full regular-season schedule by team - for the waiver analyzer's matchup
 * strip and for knowing whose game has kicked off. Same endpoint as the byes;
 * cached separately (and briefly - statuses change on game day) so the bye
 * cache the draft reads is never touched.
 */
export async function getTeamSchedule(opts: { season: string; force?: boolean }): Promise<TeamSchedule> {
  const { season, force = false } = opts;
  const key = `v${TEAM_SCHEDULE_VERSION}:${season}`;
  if (!force) {
    const cached = await readCache<{ key: string; teams: TeamSchedule }>(
      config.paths.teamSchedule,
      TEAM_SCHEDULE_MAX_AGE_MS,
    );
    if (cached?.key === key && Object.keys(cached.teams).length) return cached.teams;
  }
  try {
    const games = await getJson<ScheduleGame[]>(`${config.sleeper.dataBase}/schedule/nfl/regular/${season}`, {
      retries: 1,
    });
    if (!games?.length) return {};
    const teams = teamSchedule(games);
    await writeCache(config.paths.teamSchedule, { key, teams });
    return teams;
  } catch (err) {
    console.warn(`[schedule] schedule lookup failed: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

/** Exported for testing. */
export function teamSchedule(games: ScheduleGame[]): TeamSchedule {
  const out: TeamSchedule = {};
  for (const g of games) {
    if (g.week == null || !g.home || !g.away) continue;
    const common = { date: g.date ?? null, status: g.status ?? null };
    (out[g.home] ??= {})[g.week] = { opponent: g.away, home: true, ...common };
    (out[g.away] ??= {})[g.week] = { opponent: g.home, home: false, ...common };
  }
  return out;
}

/** Exported for testing: the week each team is absent from the schedule. */
export function deriveByeWeeks(games: ScheduleGame[], teams: string[]): ByeWeeks {
  const played = new Map<string, Set<number>>();
  let maxWeek = 0;

  for (const g of games) {
    if (g.week == null) continue;
    maxWeek = Math.max(maxWeek, g.week);
    for (const team of [g.home, g.away]) {
      if (!team) continue;
      const weeks = played.get(team) ?? new Set<number>();
      weeks.add(g.week);
      played.set(team, weeks);
    }
  }

  const byes: ByeWeeks = {};
  for (const team of teams) {
    const weeks = played.get(team);
    if (!weeks) continue;
    for (let w = 1; w <= maxWeek; w++) {
      if (!weeks.has(w)) {
        byes[team] = w;
        break;
      }
    }
  }
  return byes;
}
