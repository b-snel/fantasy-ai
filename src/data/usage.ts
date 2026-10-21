/**
 * What has actually happened this season, for the waiver analyzer.
 *
 * Projections say what a player should do; the box scores say what his role has
 * been. On the waiver wire the second one is often the news - a backup whose snap
 * share jumped from 30% to 70% in two weeks is the pickup, whatever his season
 * line says. Sleeper's weekly stat lines (verified live 2026-10-21, same
 * undocumented host as the projections) carry snaps, team snaps, targets, carries
 * and red-zone looks per game, plus the opponent, so this keeps them per week.
 *
 * Context only. Measured on this season's data, an opportunity jump moves the
 * next week's projection and predicts nothing beyond it - the projections have
 * already priced it in - so usage is shown, never ranked on. Defense-vs-position
 * was measured the same way and left out entirely: six weeks of it is noise for
 * RB and WR, and already inside the projections for the rest.
 *
 * Every point is scored in the league's own scoring - never Sleeper's pts_*
 * fields, which are half-PPR with 4-point passing touchdowns.
 */

import { config } from "../config.ts";
import { getJson, readCache, writeCache } from "../sleeper/client.ts";
import { scoreStatLine, type StatLine } from "../engine/scoring.ts";
import type { PlayersIndex, ScoringSettings } from "../sleeper/types.ts";

export interface WeekLine {
  week: number;
  team: string | null;
  opponent: string | null;
  /** Fantasy points in this league's scoring. */
  points: number;
  /** Offensive snaps over team offensive snaps; null when not reported (K, DEF). */
  snapShare: number | null;
  targets: number;
  carries: number;
  /** Red-zone carries plus red-zone targets. */
  redZone: number;
}

export interface UsageIndex {
  season: string;
  /** Completed weeks covered, ascending. */
  weeks: number[];
  /** playerId -> one line per game played, ascending by week. */
  lines: Map<string, WeekLine[]>;
  fetchedAt: number;
}

interface StatRow {
  player_id?: string;
  team?: string | null;
  opponent?: string | null;
  week?: number;
  stats?: StatLine;
  player?: { position?: string | null } | null;
}

interface UsageCache {
  key: string;
  season: string;
  weeks: number[];
  fetchedAt: number;
  lines: Array<[string, WeekLine[]]>;
}

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
/** Stat corrections land for a few days after a game; six hours is fresh enough. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Bump when UsageCache changes shape, so an old file is a miss rather than half-read. */
const CACHE_VERSION = 2;
/** Completed weeks kept: enough for a trend, and each page is ~0.6MB. */
const RECENT_WEEKS = 4;

export async function getUsage(opts: {
  season: string;
  /** Last completed week to include. */
  throughWeek: number;
  scoring: ScoringSettings;
  players: PlayersIndex;
  force?: boolean;
}): Promise<UsageIndex> {
  const { season, throughWeek, scoring, players } = opts;
  const first = Math.max(1, throughWeek - RECENT_WEEKS + 1);
  const weeks = throughWeek >= 1 ? Array.from({ length: throughWeek - first + 1 }, (_, i) => first + i) : [];
  const key = `v${CACHE_VERSION}:${season}:${throughWeek}:${Bun.hash(JSON.stringify(scoring)).toString(36)}`;

  if (!opts.force) {
    const cached = await readCache<UsageCache>(config.paths.stats, MAX_AGE_MS);
    if (cached?.key === key) {
      return {
        season: cached.season,
        weeks: cached.weeks,
        lines: new Map(cached.lines),
        fetchedAt: cached.fetchedAt,
      };
    }
  }

  const positionQuery = POSITIONS.map((p) => `position[]=${p}`).join("&");
  const pages = await Promise.all(
    weeks.map((week) =>
      getJson<StatRow[]>(`${config.sleeper.dataBase}/stats/nfl/${season}/${week}?season_type=regular&${positionQuery}`, {
        retries: 1,
        timeoutMs: 30_000,
      }).catch((err) => {
        console.warn(`[usage] week ${week} stats failed: ${err instanceof Error ? err.message : err}`);
        return null;
      }),
    ),
  );

  const usage = summarise(
    weeks.map((week, i) => ({ week, rows: pages[i] ?? [] })),
    scoring,
    players,
    season,
  );
  await writeCache(config.paths.stats, {
    key,
    season,
    weeks: usage.weeks,
    fetchedAt: usage.fetchedAt,
    lines: [...usage.lines],
  } satisfies UsageCache);
  return usage;
}

/** Exported for testing: stat rows to per-player lines. */
export function summarise(
  pages: Array<{ week: number; rows: StatRow[] }>,
  scoring: ScoringSettings,
  players: PlayersIndex,
  season: string,
): UsageIndex {
  const lines = new Map<string, WeekLine[]>();
  const covered: number[] = [];

  for (const { week, rows } of pages) {
    if (!rows.length) continue;
    covered.push(week);
    for (const row of rows) {
      const id = row.player_id;
      const stats = row.stats ?? {};
      if (!id || !(stats.gp ?? 0)) continue; // listed but did not play
      const position = players[id]?.position ?? row.player?.position ?? null;
      if (!position || !POSITIONS.includes(position)) continue;

      const points = Math.round(scoreStatLine(stats, scoring, position) * 100) / 100;
      const offSnaps = stats.off_snp ?? 0;
      const teamSnaps = stats.tm_off_snp ?? 0;
      const line: WeekLine = {
        week,
        team: row.team ?? null,
        opponent: row.opponent ?? null,
        points,
        snapShare: position === "DEF" || position === "K" || teamSnaps <= 0 ? null : round2(offSnaps / teamSnaps),
        targets: stats.rec_tgt ?? 0,
        carries: stats.rush_att ?? 0,
        redZone: (stats.rush_rz_att ?? 0) + (stats.rec_rz_tgt ?? 0),
      };
      const list = lines.get(id) ?? [];
      list.push(line);
      lines.set(id, list);
    }
  }
  for (const list of lines.values()) list.sort((a, b) => a.week - b.week);

  return { season, weeks: covered, lines, fetchedAt: Date.now() };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
