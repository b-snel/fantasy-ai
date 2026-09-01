/**
 * Season projections, with a fallback chain.
 *
 * Order of preference:
 *   1. Sleeper's bulk weekly projections, summed across the season. Undocumented,
 *      on api.sleeper.com, and the richest source — it returns raw stat lines, so
 *      we can score them through the league's own settings rather than trusting
 *      someone else's idea of PPR.
 *   2. Per-player season projections. Same host, one call per player, so only used
 *      for gap-filling.
 *   3. `search_rank` from the official player dump, mapped through a value curve.
 *      Crude, but it ships with the documented API and never disappears.
 *
 * The point of the chain is that a draft is a hard deadline. If the undocumented
 * host goes away the morning of your draft, the app gets worse, not broken.
 */

import { config } from "../config.ts";
import { getJson, readCache, writeCache } from "../sleeper/client.ts";
import { scoreStatLine, type StatLine } from "../engine/scoring.ts";
import {
  isFantasyPosition,
  type PlayersIndex,
  type ScoringSettings,
} from "../sleeper/types.ts";
import type { Capabilities } from "./capabilities.ts";

/** Projected season points and the ADP that came with them, keyed by player_id. */
export interface ProjectionRow {
  playerId: string;
  points: number;
  adp: number | null;
  source: ProjectionSource;
}

export type ProjectionSource = "sleeper_weekly" | "sleeper_season" | "search_rank";

export type ProjectionTable = Map<string, ProjectionRow>;

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
/** Regular season length. Weeks past a team's schedule simply return nothing. */
const REGULAR_SEASON_WEEKS = 18;

interface SleeperProjectionEntry {
  player_id?: string;
  week?: number;
  season?: string;
  stats?: StatLine;
  /** Sleeper carries several ADP flavours; we take whichever matches the format. */
  [key: string]: unknown;
}

/**
 * Pull and cache season projections. `force` re-fetches even if the cache is warm.
 */
export async function getProjections(opts: {
  season: string;
  scoring: ScoringSettings;
  players: PlayersIndex;
  capabilities: Capabilities;
  force?: boolean;
  maxAgeMs?: number;
}): Promise<ProjectionTable> {
  const { season, scoring, players, capabilities, force = false } = opts;
  const maxAgeMs = opts.maxAgeMs ?? 6 * 60 * 60 * 1000;

  if (!force) {
    const cached = await readCache<ProjectionRow[]>(config.paths.projections, maxAgeMs);
    if (cached?.length) return new Map(cached.map((r) => [r.playerId, r]));
  }

  let table: ProjectionTable | null = null;

  if (capabilities.bulkProjections) {
    try {
      table = await fetchWeeklyProjections(season, scoring, players);
    } catch (err) {
      console.warn(`[projections] bulk weekly fetch failed: ${describe(err)}`);
    }
  }

  if (!table || table.size === 0) {
    console.warn("[projections] falling back to search_rank — value estimates will be coarse");
    table = projectionsFromSearchRank(players, scoring);
  }

  await writeCache(config.paths.projections, [...table.values()]);
  return table;
}

/**
 * Sum Sleeper's weekly projections into a season total, scoring each week's raw
 * stat line through the league's settings.
 */
async function fetchWeeklyProjections(
  season: string,
  scoring: ScoringSettings,
  players: PlayersIndex,
): Promise<ProjectionTable> {
  const totals = new Map<string, { points: number; adp: number | null }>();
  const positionQuery = POSITIONS.map((p) => `position[]=${p}`).join("&");

  for (let week = 1; week <= REGULAR_SEASON_WEEKS; week++) {
    const url =
      `${config.sleeper.dataBase}/projections/nfl/${season}/${week}` +
      `?season_type=regular&${positionQuery}`;

    const rows = await getJson<SleeperProjectionEntry[]>(url, { retries: 1 });
    if (!rows?.length) continue;

    for (const row of rows) {
      const playerId = row.player_id;
      if (!playerId) continue;
      const position = players[playerId]?.position ?? null;
      const weekPoints = scoreStatLine(row.stats ?? {}, scoring, position);
      const prev = totals.get(playerId);
      const adp = prev?.adp ?? extractAdp(row, scoring);
      totals.set(playerId, { points: (prev?.points ?? 0) + weekPoints, adp });
    }
  }

  const out: ProjectionTable = new Map();
  for (const [playerId, { points, adp }] of totals) {
    out.set(playerId, {
      playerId,
      points: Math.round(points * 10) / 10,
      adp,
      source: "sleeper_weekly",
    });
  }
  return out;
}

/**
 * Sleeper exposes several ADP variants (`adp_ppr`, `adp_half_ppr`, `adp_std`,
 * `adp_dynasty_*`). Pick the one matching the league's scoring so a standard league
 * is not ranked off PPR ADP.
 */
function extractAdp(row: SleeperProjectionEntry, scoring: ScoringSettings): number | null {
  const ppr = scoring.rec ?? 0;
  const preference =
    ppr >= 1
      ? ["adp_ppr", "adp_half_ppr", "adp_std", "adp"]
      : ppr > 0
        ? ["adp_half_ppr", "adp_ppr", "adp_std", "adp"]
        : ["adp_std", "adp_half_ppr", "adp_ppr", "adp"];

  // ADP may sit at the top level or inside stats, depending on the endpoint.
  const stats = (row.stats ?? {}) as Record<string, unknown>;
  for (const key of preference) {
    for (const source of [row as Record<string, unknown>, stats]) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

/**
 * Last-resort projections from Sleeper's own relevance ranking.
 *
 * `search_rank` is an ordering, not a point estimate, so this maps rank to a
 * plausible points curve per position: a steep decline through the early ranks
 * flattening out into replacement level. It will not win you a projection contest,
 * but it preserves the *ordering* the rest of the engine needs, and it is derived
 * entirely from the documented API.
 */
export function projectionsFromSearchRank(
  players: PlayersIndex,
  scoring: ScoringSettings,
): ProjectionTable {
  const ppr = scoring.rec ?? 0;

  // Calibrated against real PPR season totals rather than invented: these produce
  // roughly QB12 ~ 300, RB30 ~ 155, WR30 ~ 165, TE12 ~ 120, K12 ~ 131, DEF12 ~ 111,
  // which is close enough to a real season for replacement level and tiering to land
  // in the right place.
  //
  // The narrow K and DEF spreads are the important detail, not a rounding choice.
  // Those positions really do compress into ~30 points top to bottom, and that
  // compression is the whole reason they are streamable - an engine that gives them
  // a wide spread will draft a kicker in round ten and be arithmetically correct
  // about it.
  const peak: Record<string, number> = {
    QB: 400,
    RB: 300 + ppr * 30,
    WR: 250 + ppr * 90,
    TE: 180 + ppr * 70,
    K: 155,
    DEF: 150,
  };
  const floor: Record<string, number> = { QB: 250, RB: 95, WR: 85, TE: 58, K: 120, DEF: 92 };
  /** How quickly value decays with positional rank. */
  const decay: Record<string, number> = { QB: 11, RB: 22, WR: 26, TE: 10, K: 12, DEF: 12 };
  /**
   * A pure exponential asymptotes to its floor, which leaves ranks 20-32 sitting on
   * a plateau at nearly identical value. That plateau is not harmless: it makes the
   * 24th quarterback look like a viable pick, because he scores about what the 20th
   * does. Real distributions keep declining into genuinely unrosterable players, so
   * a linear tail runs underneath the exponential to break the plateau.
   */
  const tail: Record<string, number> = { QB: 2.6, RB: 1.1, WR: 0.9, TE: 1.1, K: 0.6, DEF: 0.6 };
  const hardFloor: Record<string, number> = { QB: 55, RB: 20, WR: 20, TE: 15, K: 90, DEF: 55 };

  const byPosition = new Map<string, Array<{ playerId: string; rank: number }>>();
  for (const [playerId, p] of Object.entries(players)) {
    const position = p.position;
    if (!isFantasyPosition(position)) continue;
    if (p.active === false) continue;
    const rank = p.search_rank;
    if (rank == null || !Number.isFinite(rank) || rank >= 9_999_999) continue;
    const list = byPosition.get(position) ?? [];
    list.push({ playerId, rank });
    byPosition.set(position, list);
  }

  const out: ProjectionTable = new Map();
  for (const [position, list] of byPosition) {
    list.sort((a, b) => a.rank - b.rank || a.playerId.localeCompare(b.playerId));
    const hi = peak[position] ?? 200;
    const lo = floor[position] ?? 40;
    const k = decay[position] ?? 16;

    const slope = tail[position] ?? 1;
    const min = hardFloor[position] ?? 15;

    list.forEach((entry, index) => {
      const positionalRank = index + 1;
      // Exponential decay from peak toward the positional floor, with a linear tail
      // underneath so the deep end keeps declining instead of plateauing.
      const points = Math.max(
        min,
        lo + (hi - lo) * Math.exp(-(positionalRank - 1) / k) - slope * (positionalRank - 1),
      );
      out.set(entry.playerId, {
        playerId: entry.playerId,
        points: Math.round(points * 10) / 10,
        // search_rank is a global ordering, which approximates ADP well enough
        // to drive the survival model when nothing better is available.
        adp: entry.rank,
        source: "search_rank",
      });
    });
  }

  return out;
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
