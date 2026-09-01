/**
 * The engine against THE MAIN LEAGUE's actual settings.
 *
 * The generic fixture is a conventional league. This one is transcribed from a live
 * `bun run doctor` run and differs in three ways that each exercise a different
 * assumption:
 *
 *   - **No kicker slot.** Nothing in `roster_positions` is a K, so a kicker is worth
 *     literally nothing all season. The streaming rule has to fall out to "never"
 *     rather than to "wait until the endgame", and it does so only because a
 *     position with zero required slots is already saturated at zero owned.
 *   - **Two FLEX slots.** Replacement level for RB and WR is far deeper than in a
 *     one-flex league, which shifts what counts as a startable player.
 *   - **Passing touchdowns are worth 6, not 4.** Quarterback value is materially
 *     higher than the default assumption, and the only reason it comes out right is
 *     that scoring is read from the league rather than configured.
 */

import { test, expect, describe } from "bun:test";
import realLeagueJson from "../fixtures/real-league.json" with { type: "json" };
import { fixtureDraft, makeFixtureByes, makeFixturePlayers } from "../fixtures/index.ts";
import { computeBoard } from "../src/engine/board.ts";
import { projectionsFromSearchRank } from "../src/data/projections.ts";
import { buildDraftShape, rosterOfPick } from "../src/engine/snake.ts";
import { marginalValueMultiplier } from "../src/engine/rank.ts";
import { parseRosterPositions, replacementRanks } from "../src/engine/replacement.ts";
import { evaluateRoster } from "../src/engine/roster.ts";
import { describeScoring, scoreStatLine } from "../src/engine/scoring.ts";
import { buildStaticPrefix } from "../src/llm/prompt.ts";
import type { Draft, DraftPick, League, Roster } from "../src/sleeper/types.ts";

const league = realLeagueJson as unknown as League;
const USER_ID = "434221843767881728";
/** From doctor: slot 9 maps to roster 3. */
const MY_SLOT = 9;
const MY_ROSTER = 3;

describe("league settings are read, not assumed", () => {
  test("is recognised as half PPR", () => {
    expect(describeScoring(league.scoring_settings)).toContain("Half PPR");
  });

  test("scores a passing line at 6 points per touchdown", () => {
    // The common default is 4. Getting this from the league rather than a constant
    // is the whole reason quarterback value lands in the right place here.
    const pts = scoreStatLine({ pass_yd: 4500, pass_td: 35, pass_int: 12 }, league.scoring_settings, "QB");
    // 4500 * 0.04 = 180, 35 * 6 = 210, 12 * -2 = -24
    expect(pts).toBe(366);
  });

  test("halves receptions", () => {
    const pts = scoreStatLine({ rec: 100, rec_yd: 1200, rec_td: 8 }, league.scoring_settings, "WR");
    expect(pts).toBe(218); // 50 + 120 + 48
  });

  test("parses the roster with two flex slots and no kicker", () => {
    const req = parseRosterPositions(league.roster_positions);
    expect(req.starters).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, DEF: 1 });
    expect(req.flex).toEqual({ FLEX: 2 });
    expect(req.starters.K).toBeUndefined();
    expect(req.benchSlots).toBe(6);
    expect(req.totalRosterSize).toBe(15);
  });

  test("two flex slots push RB and WR replacement level deeper", () => {
    const req = parseRosterPositions(league.roster_positions);
    const ranks = replacementRanks(req, 12);
    // 12 teams x (2 dedicated + 2 flex x 0.5 share) = 36
    expect(ranks.RB).toBe(36);
    // 12 x (2 + 2 x 0.45) = 34.8
    expect(ranks.WR).toBe(35);
  });

  test("the cached prompt prefix reflects this league, not a default", () => {
    const prefix = buildStaticPrefix({
      league,
      teams: 12,
      rounds: 15,
      draftType: "snake",
      mySlot: MY_SLOT,
    });
    expect(prefix).toContain("Half PPR");
    expect(prefix).toContain("THE MAIN LEAGUE");
    expect(prefix).toContain("slot 9");
    expect(prefix).toContain("FLEX: 2");
    // No kicker anywhere in the starting requirements.
    expect(prefix).not.toMatch(/^\s+K: \d/m);
  });
});

describe("a position with no roster slot", () => {
  const req = parseRosterPositions(league.roster_positions);
  const empty = evaluateRoster([], req, 15);

  test("a kicker is worthless even in the final round", () => {
    // In a league that starts a kicker this returns 1 at the endgame. Here there is
    // no slot to fill, so it must stay near zero right through the last pick.
    expect(marginalValueMultiplier("K", empty, req, 15)).toBeLessThan(0.05);
    expect(marginalValueMultiplier("K", empty, req, 2)).toBeLessThan(0.05);
    expect(marginalValueMultiplier("K", empty, req, 1)).toBeLessThan(0.05);
  });

  test("the defense, which does have a slot, still becomes urgent at the end", () => {
    expect(marginalValueMultiplier("DEF", empty, req, 12)).toBeLessThan(0.1);
    expect(marginalValueMultiplier("DEF", empty, req, 2)).toBe(1);
  });

  test("a kicker never registers as a roster need", () => {
    expect(empty.needs.K.unfilled).toBe(0);
    expect(empty.needs.K.urgency).toBe(0);
  });
});

describe("a full simulated draft under these settings", () => {
  const players = makeFixturePlayers();
  const byeWeeks = makeFixtureByes();
  const projections = projectionsFromSearchRank(players, league.scoring_settings);

  const draft: Draft = {
    ...fixtureDraft,
    league_id: league.league_id,
    status: "drafting",
    settings: { ...fixtureDraft.settings, teams: 12, rounds: 15, pick_timer: 120 },
    draft_order: { ...fixtureDraft.draft_order, [USER_ID]: MY_SLOT },
    slot_to_roster_id: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [String(i + 1), i + 1]),
    ),
  };
  // Slot 9 must map to roster 3, as it does in the real league.
  draft.slot_to_roster_id![String(MY_SLOT)] = MY_ROSTER;
  draft.slot_to_roster_id!["3"] = MY_SLOT;

  const shape = buildDraftShape(draft, []);
  const rosters: Roster[] = Array.from({ length: 12 }, (_, i) => ({
    roster_id: i + 1,
    owner_id: i + 1 === MY_ROSTER ? USER_ID : `u${i + 1}`,
    league_id: league.league_id,
    players: [],
    starters: [],
  }));

  const picks: DraftPick[] = [];
  const adpOrder = [...projections.values()]
    .filter((p) => p.adp != null)
    .sort((a, b) => (a.adp ?? 0) - (b.adp ?? 0))
    .map((p) => p.playerId);

  const inputs = () => ({
    league,
    draft,
    picks,
    tradedPicks: [],
    rosters,
    players,
    projections,
    byeWeeks,
    trending: new Map<string, number>(),
    news: new Map<string, string>(),
    userId: USER_ID,
  });

  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let pickNo = 1; pickNo <= 180; pickNo++) {
    const rosterId = rosterOfPick(pickNo, shape);
    const state = computeBoard(inputs());
    let chosen: string | undefined;

    if (rosterId != null && rosterId === state.myRosterId) {
      chosen = state.shortlist[0]?.playerId;
    } else {
      const drafted = new Set(picks.map((p) => p.player_id));
      const pool = adpOrder.filter((id) => !drafted.has(id)).slice(0, 8);
      chosen = pool[Math.floor(rand() * Math.min(4, pool.length))] ?? pool[0];
    }
    if (!chosen) break;

    picks.push({
      draft_id: draft.draft_id,
      pick_no: pickNo,
      round: Math.ceil(pickNo / 12),
      draft_slot: ((pickNo - 1) % 12) + 1,
      roster_id: rosterId ?? 0,
      player_id: chosen,
      metadata: { position: players[chosen]?.position ?? undefined },
    });
  }

  const final = computeBoard(inputs());
  const counts = final.roster.countsByPosition;

  test("resolves the right roster from the real slot mapping", () => {
    expect(final.myRosterId).toBe(MY_ROSTER);
    expect(final.mySlot).toBe(MY_SLOT);
  });

  test("drafts a full roster", () => {
    expect(final.myPlayers.length).toBe(15);
  });

  test("never spends a pick on a kicker", () => {
    // This is the headline consequence of the settings: no K slot, so no K, ever.
    expect(counts.K).toBe(0);
  });

  test("takes exactly one defense", () => {
    expect(counts.DEF).toBe(1);
  });

  test("fills every starting slot", () => {
    const req = parseRosterPositions(league.roster_positions).starters;
    for (const [position, required] of Object.entries(req)) {
      expect(counts[position as keyof typeof counts] ?? 0).toBeGreaterThanOrEqual(required);
    }
  });

  test("loads up on flex-eligible players, as two flex slots demand", () => {
    // 2 RB + 2 WR + 1 TE + 2 FLEX = seven flex-eligible starters every week.
    expect(counts.RB + counts.WR + counts.TE).toBeGreaterThanOrEqual(11);
  });

  test("does not hoard quarterbacks despite 6-point passing touchdowns", () => {
    expect(counts.QB).toBeLessThanOrEqual(2);
  });

  test("spends the early rounds on skill positions", () => {
    const early = picks.filter((p) => p.roster_id === MY_ROSTER && p.round <= 3);
    for (const p of early) {
      expect(["RB", "WR", "TE", "QB"]).toContain(p.metadata?.position ?? "");
    }
  });
});
