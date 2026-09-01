/**
 * Offline fixtures.
 *
 * This sandbox's egress policy blocks every Sleeper host, so nothing in this
 * project may depend on the network to be verified. These fixtures stand in for
 * the live API: real-shaped league and draft objects plus a synthetic but
 * plausibly-distributed player pool, enough to exercise the entire pipeline.
 */

import leagueJson from "./league.json" with { type: "json" };
import draftJson from "./draft.json" with { type: "json" };
import type { Draft, League, PlayersIndex, Player } from "../src/sleeper/types.ts";

export const fixtureLeague = leagueJson as unknown as League;
export const fixtureDraft = draftJson as unknown as Draft;

const NFL_TEAMS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET",
  "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE",
  "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
];

/** Player counts per position, roughly matching a real draftable pool. */
const POOL_SHAPE: Array<[string, number]> = [
  ["QB", 32],
  ["RB", 70],
  ["WR", 90],
  ["TE", 34],
  ["K", 32],
  ["DEF", 32],
];

/**
 * A deterministic pseudo-random generator. Fixtures must be byte-identical across
 * runs or the cache-stability tests become meaningless.
 */
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

/**
 * Build a synthetic player index. Search ranks interleave positions the way
 * Sleeper's do (a few elite RB/WR, then a mix), so replacement-level and tiering
 * behave like they would against the real dump.
 */
export function makeFixturePlayers(seed = 20260901): PlayersIndex {
  const rand = mulberry32(seed);
  const players: PlayersIndex = {};

  let globalRank = 1;
  const queues: Array<{ position: string; index: number; total: number }> = POOL_SHAPE.map(
    ([position, total]) => ({ position, index: 0, total }),
  );

  // Interleave positions by a rough draft-relevance weighting.
  const weights: Record<string, number> = { RB: 3, WR: 3.5, QB: 1, TE: 1, K: 0.15, DEF: 0.15 };
  const credits: Record<string, number> = { RB: 0, WR: 0, QB: 0, TE: 0, K: 0, DEF: 0 };

  while (queues.some((q) => q.index < q.total)) {
    for (const q of queues) {
      if (q.index >= q.total) continue;
      credits[q.position] = (credits[q.position] ?? 0) + (weights[q.position] ?? 1);
      while ((credits[q.position] ?? 0) >= 1 && q.index < q.total) {
        credits[q.position] = (credits[q.position] ?? 0) - 1;
        const positionalRank = q.index + 1;
        const id = `${q.position}${positionalRank}`;
        players[id] = makePlayer(id, q.position, positionalRank, globalRank++, rand);
        q.index++;
      }
    }
  }

  return players;
}

function makePlayer(
  id: string,
  position: string,
  positionalRank: number,
  searchRank: number,
  rand: () => number,
): Player {
  const team = NFL_TEAMS[Math.floor(rand() * NFL_TEAMS.length)]!;
  // A small slice of the pool carries an injury designation, as in reality.
  const roll = rand();
  const injury =
    roll > 0.96 ? "Out" : roll > 0.92 ? "Questionable" : roll > 0.9 ? "IR" : null;

  const first = `${position}`;
  const last = `Player${positionalRank}`;

  return {
    player_id: id,
    first_name: first,
    last_name: last,
    full_name: `${first} ${last}`,
    position,
    fantasy_positions: [position],
    team: position === "DEF" ? team : team,
    status: "Active",
    active: true,
    age: 22 + Math.floor(rand() * 12),
    years_exp: Math.floor(rand() * 10),
    number: 1 + Math.floor(rand() * 98),
    depth_chart_position: position,
    depth_chart_order: 1 + Math.floor(rand() * 3),
    injury_status: injury,
    injury_body_part: injury ? "hamstring" : null,
    practice_participation: injury === "Questionable" ? "Limited Participation" : null,
    news_updated: null,
    search_rank: searchRank,
    search_full_name: `${first}${last}`.toLowerCase(),
    espn_id: 3000000 + searchRank,
    yahoo_id: null,
    gsis_id: null,
  };
}

/** Bye weeks for every fixture team, spread across weeks 5-14 as the NFL does. */
export function makeFixtureByes(): Record<string, number> {
  const byes: Record<string, number> = {};
  NFL_TEAMS.forEach((team, i) => {
    byes[team] = 5 + (i % 10);
  });
  return byes;
}

export { NFL_TEAMS };
