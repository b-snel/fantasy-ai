/**
 * End-to-end draft simulation.
 *
 * The unit tests check that each piece computes what it claims to. This one checks
 * the thing that actually matters: that fifteen rounds of those pieces interacting
 * produce a roster a human would not be embarrassed by.
 *
 * Every bug this file exists to catch was found by running the simulation and
 * reading the output, not by reasoning about the components in isolation - each one
 * was a case where every individual number was correct and the emergent behaviour
 * was still wrong:
 *
 *   - replacement level recomputed against the shrinking available pool, which
 *     inflated VORP for whatever position had already been drained, so the engine
 *     took three quarterbacks in a one-quarterback league;
 *   - no saturation term, so backups at a covered position kept out-ranking
 *     startable players at an empty one;
 *   - kickers and defenses ranked on VORP like everyone else, which is defensible
 *     arithmetic and produces a kicker in round ten;
 *   - a residual-urgency floor that became a flat bonus for every *filled* position
 *     once the need scale was raised, handing the draft to a second kicker;
 *   - sub-replacement players scoring negative, which made a duplicate kicker with
 *     tiny positive VORP beat the entire remaining receiver pool.
 */

import { test, expect, describe } from "bun:test";
import { fixtureDraft, fixtureLeague, makeFixtureByes, makeFixturePlayers } from "../fixtures/index.ts";
import { computeBoard, detectRun, measureDecisiveness } from "../src/engine/board.ts";
import { projectionsFromSearchRank } from "../src/data/projections.ts";
import { buildDraftShape, rosterOfPick } from "../src/engine/snake.ts";
import { marginalValueMultiplier, valueTerm } from "../src/engine/rank.ts";
import { parseRosterPositions } from "../src/engine/replacement.ts";
import { evaluateRoster } from "../src/engine/roster.ts";
import type { Draft, DraftPick, Roster } from "../src/sleeper/types.ts";

const USER_ID = "434221843767881728";
const MY_SLOT = 7;

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

/** Run a full simulated draft and return the final board state. */
function simulateDraft(seed = 424242) {
  const players = makeFixturePlayers();
  const byeWeeks = makeFixtureByes();
  const projections = projectionsFromSearchRank(players, fixtureLeague.scoring_settings);
  const draft: Draft = { ...fixtureDraft, status: "drafting" };
  const shape = buildDraftShape(draft, []);
  const rosters: Roster[] = Array.from({ length: shape.teams }, (_, i) => ({
    roster_id: i + 1,
    owner_id: i + 1 === MY_SLOT ? USER_ID : `u${i + 1}`,
    league_id: fixtureLeague.league_id,
    players: [],
    starters: [],
  }));

  const picks: DraftPick[] = [];
  const rand = mulberry32(seed);
  const adpOrder = [...projections.values()]
    .filter((p) => p.adp != null)
    .sort((a, b) => (a.adp ?? 0) - (b.adp ?? 0))
    .map((p) => p.playerId);

  const inputs = () => ({
    league: fixtureLeague,
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

  const myShortlists: Array<{ pickNo: number; positions: string[]; scores: number[] }> = [];

  for (let pickNo = 1; pickNo <= shape.teams * shape.rounds; pickNo++) {
    const rosterId = rosterOfPick(pickNo, shape);
    const state = computeBoard(inputs());

    let chosen: string | undefined;
    if (rosterId != null && rosterId === state.myRosterId) {
      chosen = state.shortlist[0]?.playerId;
      myShortlists.push({
        pickNo,
        positions: state.shortlist.map((p) => p.position),
        scores: state.shortlist.map((p) => p.score),
      });
    } else {
      const drafted = new Set(picks.map((p) => p.player_id));
      const candidates = adpOrder.filter((id) => !drafted.has(id)).slice(0, 8);
      chosen = candidates[Math.floor(rand() * Math.min(4, candidates.length))] ?? candidates[0];
    }
    if (!chosen) break;

    const player = players[chosen];
    picks.push({
      draft_id: draft.draft_id,
      pick_no: pickNo,
      round: Math.ceil(pickNo / shape.teams),
      draft_slot: ((pickNo - 1) % shape.teams) + 1,
      roster_id: rosterId ?? 0,
      player_id: chosen,
      metadata: { position: player?.position ?? undefined, team: player?.team ?? undefined },
    });
  }

  return { final: computeBoard(inputs()), picks, myShortlists, shape };
}

describe("a full simulated draft", () => {
  const { final, picks, myShortlists, shape } = simulateDraft();
  const counts = final.roster.countsByPosition;

  test("drafts every pick without crashing or stalling", () => {
    expect(picks.length).toBe(shape.teams * shape.rounds);
  });

  test("fills every required starting slot", () => {
    const req = parseRosterPositions(fixtureLeague.roster_positions).starters;
    for (const [position, required] of Object.entries(req)) {
      expect(counts[position as keyof typeof counts] ?? 0).toBeGreaterThanOrEqual(required);
    }
  });

  test("takes exactly one kicker and one defense", () => {
    // Streamable positions. More than one of either is a wasted pick, and the
    // engine used to take five kickers.
    expect(counts.K).toBe(1);
    expect(counts.DEF).toBe(1);
  });

  test("does not draft the kicker or defense early", () => {
    const lateRoundStart = shape.rounds - 3;
    for (const p of picks) {
      if (p.roster_id !== final.myRosterId) continue;
      if (p.metadata?.position === "K" || p.metadata?.position === "DEF") {
        expect(p.round).toBeGreaterThanOrEqual(lateRoundStart);
      }
    }
  });

  test("does not hoard backups at a one-slot position", () => {
    // A one-QB league with a FLEX that cannot take a QB: two is a backup, three is
    // a bug. This caught the inflated-VORP regression.
    expect(counts.QB).toBeLessThanOrEqual(2);
  });

  test("builds a roster weighted toward the positions that score", () => {
    const skill = counts.RB + counts.WR + counts.TE;
    expect(skill).toBeGreaterThanOrEqual(9);
  });

  test("spends early picks on premium positions, not on filling holes", () => {
    // The first three rounds should be RB/WR/TE, never a kicker, defense, or a
    // need-driven reach.
    const early = picks.filter((p) => p.roster_id === final.myRosterId && p.round <= 3);
    for (const p of early) {
      expect(["RB", "WR", "TE", "QB"]).toContain(p.metadata?.position ?? "");
    }
  });

  test("offers a shortlist at every one of my picks", () => {
    expect(myShortlists.length).toBe(shape.rounds);
    for (const s of myShortlists) expect(s.positions.length).toBeGreaterThan(0);
  });

  test("keeps the shortlist positionally varied rather than one-note", () => {
    // A shortlist of eight players at the same position gives the model nothing to
    // weigh. Mid-draft, expect at least two positions represented.
    const mid = myShortlists.slice(2, 10);
    for (const s of mid) {
      expect(new Set(s.positions).size).toBeGreaterThanOrEqual(2);
    }
  });

  test("is reproducible", () => {
    const again = simulateDraft();
    expect(again.picks.map((p) => p.player_id)).toEqual(picks.map((p) => p.player_id));
  });

  test("produces a different draft from a different seed", () => {
    const other = simulateDraft(999);
    expect(other.picks.map((p) => p.player_id)).not.toEqual(picks.map((p) => p.player_id));
  });
});

describe("marginalValueMultiplier", () => {
  const req = parseRosterPositions(fixtureLeague.roster_positions);
  const empty = evaluateRoster([], req, 15);
  const withQb = evaluateRoster([{ playerId: "q", position: "QB", team: "KC", byeWeek: 9 }], req, 12);
  const withKicker = evaluateRoster([{ playerId: "k", position: "K", team: "KC", byeWeek: 9 }], req, 5);

  test("gives full value to a player filling an empty starting slot", () => {
    expect(marginalValueMultiplier("RB", empty, req, 15)).toBe(1);
  });

  test("discounts a backup at a one-slot position", () => {
    expect(marginalValueMultiplier("QB", withQb, req, 12)).toBeLessThan(0.5);
  });

  test("keeps near-full value where a flex slot can still absorb the player", () => {
    const withOneRb = evaluateRoster(
      [
        { playerId: "a", position: "RB", team: "KC", byeWeek: 9 },
        { playerId: "b", position: "RB", team: "SF", byeWeek: 8 },
      ],
      req,
      12,
    );
    expect(marginalValueMultiplier("RB", withOneRb, req, 12)).toBeGreaterThan(0.8);
  });

  test("suppresses kickers until the endgame", () => {
    expect(marginalValueMultiplier("K", empty, req, 12)).toBeLessThan(0.1);
    expect(marginalValueMultiplier("K", empty, req, 2)).toBe(1);
  });

  test("all but eliminates a second kicker even in the endgame", () => {
    expect(marginalValueMultiplier("K", withKicker, req, 1)).toBeLessThan(0.05);
  });

  test("is a no-op when requirements are unknown", () => {
    expect(marginalValueMultiplier("RB", empty, undefined, 5)).toBe(1);
  });
});

describe("valueTerm", () => {
  test("is effectively the identity for real starters", () => {
    expect(valueTerm(150)).toBeCloseTo(150, 0);
    expect(valueTerm(100)).toBeCloseTo(100, 0);
  });

  test("stays positive below replacement", () => {
    // A bench receiver is a lottery ticket, not a liability. Scoring him negative
    // is what let a duplicate kicker outrank the whole remaining pool.
    expect(valueTerm(-20)).toBeGreaterThan(0);
    expect(valueTerm(-80)).toBeGreaterThan(0);
  });

  test("is monotonically increasing", () => {
    let prev = -Infinity;
    for (let v = -120; v <= 200; v += 10) {
      const t = valueTerm(v);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });

  test("compresses the sub-replacement range", () => {
    // The gap between two bad bench options should matter far less than the gap
    // between two startable players.
    expect(valueTerm(-20) - valueTerm(-40)).toBeLessThan(valueTerm(60) - valueTerm(40));
  });
});

describe("detectRun", () => {
  const players = makeFixturePlayers();
  const pick = (id: string, n: number): DraftPick => ({
    draft_id: "d",
    pick_no: n,
    round: 1,
    draft_slot: n,
    roster_id: n,
    player_id: id,
    metadata: { position: players[id]?.position ?? undefined },
  });

  test("spots a positional run", () => {
    const picks = ["RB1", "RB2", "WR1", "RB3", "RB4", "RB5"].map((id, i) => pick(id, i + 1));
    const run = detectRun(picks, players);
    expect(run?.position).toBe("RB");
    expect(run?.count).toBe(5);
  });

  test("stays quiet on a mixed board", () => {
    const picks = ["RB1", "WR1", "TE1", "QB1", "RB2", "WR2"].map((id, i) => pick(id, i + 1));
    expect(detectRun(picks, players)).toBeNull();
  });

  test("needs enough picks to judge", () => {
    expect(detectRun([pick("RB1", 1)], players)).toBeNull();
  });
});

describe("decisiveness", () => {
  const { myShortlists } = simulateDraft();

  test("round one is a decisive pick, the last round is not", () => {
    // Separation at the top of the board collapses as the draft drains. Reporting
    // the same confidence in round fifteen as in round one would be dishonest, so
    // the engine measures the gap and says when the choice does not matter.
    const first = measureDecisiveness(shortlistAt(1));
    const last = measureDecisiveness(shortlistAt(15));
    expect(first.effectivelyTied).toBe(false);
    expect(last.effectivelyTied).toBe(true);
    expect(first.spread).toBeGreaterThan(last.spread);
  });

  test("treats a wide gap as decisive regardless of absolute size", () => {
    const d = measureDecisiveness([
      { score: 300 } as never,
      { score: 260 } as never,
      { score: 250 } as never,
      { score: 240 } as never,
      { score: 230 } as never,
    ]);
    expect(d.effectivelyTied).toBe(false);
    expect(d.spread).toBe(70);
  });

  test("treats a narrow gap as a tie even when the scores are large", () => {
    // Ten points of separation means nothing when the leader scores 300.
    const d = measureDecisiveness([
      { score: 300 } as never,
      { score: 298 } as never,
      { score: 296 } as never,
      { score: 293 } as never,
      { score: 290 } as never,
    ]);
    expect(d.effectivelyTied).toBe(true);
  });

  test("handles a shortlist shorter than five", () => {
    expect(measureDecisiveness([{ score: 40 } as never]).effectivelyTied).toBe(true);
    expect(measureDecisiveness([]).topScore).toBe(0);
  });

  function shortlistAt(round: number) {
    const entry = myShortlists[round - 1];
    if (!entry) throw new Error(`no shortlist for round ${round}`);
    return entry.scores.map((score) => ({ score }) as never);
  }
});
