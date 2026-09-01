import { test, expect, describe } from "bun:test";
import { fixtureDraft, fixtureLeague, makeFixtureByes, makeFixturePlayers } from "../fixtures/index.ts";
import { buildStaticPrefix, buildVolatileTail, type VolatileInput } from "../src/llm/prompt.ts";
import { shouldCallModel, hash, summariseUsage } from "../src/llm/recommend.ts";
import { parseRosterPositions, replacementPoints, replacementRanks } from "../src/engine/replacement.ts";
import { evaluateRoster } from "../src/engine/roster.ts";
import { buildShortlist, scoreBoard, type RankablePlayer } from "../src/engine/rank.ts";
import { projectionsFromSearchRank } from "../src/data/projections.ts";
import { config } from "../src/config.ts";

const PREFIX_INPUT = {
  league: fixtureLeague,
  teams: 12,
  rounds: 15,
  draftType: "snake",
  mySlot: 7,
};

describe("static system prefix", () => {
  test("is byte-identical across repeated builds", () => {
    // This is the cache-invalidator guard. If the prefix drifts by one byte between
    // requests, every call silently pays full input price - correct output, large
    // bill, no error. Object key order and any hidden clock read would show up here.
    const a = buildStaticPrefix(PREFIX_INPUT);
    const b = buildStaticPrefix({ ...PREFIX_INPUT });
    expect(a).toBe(b);
  });

  test("is stable when the league object is structurally cloned", () => {
    const cloned = JSON.parse(JSON.stringify(fixtureLeague));
    expect(buildStaticPrefix({ ...PREFIX_INPUT, league: cloned })).toBe(
      buildStaticPrefix(PREFIX_INPUT),
    );
  });

  test("contains no date, time, or pick-number interpolation", () => {
    const prefix = buildStaticPrefix(PREFIX_INPUT);
    const year = String(new Date().getFullYear());
    // The league's own season string is legitimately present; a rendered current
    // date or timestamp is not.
    expect(prefix).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(prefix).not.toMatch(/GMT|UTC|\d{2}:\d{2}:\d{2}/);
    expect(prefix.includes(`${year}-`)).toBe(false);
  });

  test("comfortably clears Opus 5's 512-token cache minimum", () => {
    // Caches are model-scoped and each model has its own minimum cacheable prefix:
    // 512 tokens on Opus 5, 4096 on Haiku 4.5. This prefix lands near 2000 tokens,
    // so the on-clock path (Opus, $5/MTok) caches - which is where essentially all
    // the input spend is - and the background path (Haiku, $1/MTok) does not.
    //
    // Padding to 4096 purely to win Haiku caching would save roughly $0.0016 per
    // background call, about five cents across a whole draft, in exchange for two
    // thousand tokens of prose written to clear a threshold rather than to say
    // anything. Not a trade worth making.
    const prefix = buildStaticPrefix(PREFIX_INPUT);
    const estimatedTokens = prefix.length / 4;
    expect(estimatedTokens).toBeGreaterThan(512);
  });

  test("states the league's actual scoring rather than a generic default", () => {
    const prefix = buildStaticPrefix(PREFIX_INPUT);
    expect(prefix).toContain("Full PPR");
    expect(prefix).toContain("Teams: 12");
    expect(prefix).toContain("slot 7");
  });

  test("reflects a different league's settings", () => {
    const standard = {
      ...fixtureLeague,
      scoring_settings: { ...fixtureLeague.scoring_settings, rec: 0 },
    };
    const prefix = buildStaticPrefix({ ...PREFIX_INPUT, league: standard });
    expect(prefix).toContain("Standard");
    expect(prefix).not.toContain("Full PPR");
  });

  test("handles an unassigned draft slot", () => {
    const prefix = buildStaticPrefix({ ...PREFIX_INPUT, mySlot: null });
    expect(prefix).toContain("not yet assigned");
  });
});

// ---------------------------------------------------------------------------

function makeVolatile(over: Partial<VolatileInput> = {}): VolatileInput {
  const players = makeFixturePlayers();
  const byes = makeFixtureByes();
  const projections = projectionsFromSearchRank(players, fixtureLeague.scoring_settings);
  const req = parseRosterPositions(fixtureLeague.roster_positions);

  const rankable: RankablePlayer[] = [];
  for (const [id, p] of Object.entries(players)) {
    const proj = projections.get(id);
    if (!proj) continue;
    rankable.push({
      playerId: id,
      name: p.full_name ?? id,
      position: p.position ?? "NA",
      team: p.team ?? null,
      byeWeek: p.team ? (byes[p.team] ?? null) : null,
      projectedPoints: proj.points,
      adp: proj.adp,
      injuryStatus: p.injury_status ?? null,
      practiceParticipation: p.practice_participation ?? null,
      age: p.age ?? null,
      yearsExp: p.years_exp ?? null,
      depthChartOrder: p.depth_chart_order ?? null,
      trendingAdds: 0,
    });
  }

  const byPosition = new Map<string, number[]>();
  for (const p of rankable) {
    const list = byPosition.get(p.position) ?? [];
    list.push(p.projectedPoints);
    byPosition.set(p.position, list);
  }
  for (const list of byPosition.values()) list.sort((a, b) => b - a);

  const roster = evaluateRoster([], req, 15);
  const board = scoreBoard(rankable, {
    currentPick: 7,
    myNextPick: 7,
    myPickAfterNext: 18,
    roster,
    replacementPoints: replacementPoints(byPosition, replacementRanks(req, 12)),
    picksRemaining: 15,
  });

  return {
    currentPick: 7,
    currentRound: 1,
    picksUntilMyTurn: 0,
    myNextPick: 7,
    myPickAfterNext: 18,
    roster,
    rosterPlayers: [],
    candidates: buildShortlist(board, 8),
    recentPicks: [],
    projectionSource: "search_rank",
    ...over,
  };
}

describe("volatile tail", () => {
  test("renders the candidate table as rows, not repeated JSON keys", () => {
    const tail = buildVolatileTail(makeVolatile());
    expect(tail).toContain("name | pos | team | bye | proj | vorp | vona");
    expect(tail).not.toContain('"projectedPoints"');
  });

  test("stays small - this is the part billed at full price every call", () => {
    const tail = buildVolatileTail(makeVolatile());
    // Roughly 4 chars/token; a shortlist tail should be well under 2000 tokens.
    expect(tail.length / 4).toBeLessThan(2000);
  });

  test("announces when you are on the clock", () => {
    expect(buildVolatileTail(makeVolatile({ picksUntilMyTurn: 0 }))).toContain("ON THE CLOCK");
  });

  test("counts down when you are not", () => {
    const tail = buildVolatileTail(makeVolatile({ picksUntilMyTurn: 4, myNextPick: 11 }));
    expect(tail).toContain("4 picks until your turn");
  });

  test("flags degraded projections so the model discounts precision", () => {
    expect(buildVolatileTail(makeVolatile({ projectionSource: "search_rank" }))).toContain(
      "real projections were unavailable",
    );
    expect(buildVolatileTail(makeVolatile({ projectionSource: "sleeper_weekly" }))).not.toContain(
      "real projections were unavailable",
    );
  });

  test("lists unfilled starting slots", () => {
    expect(buildVolatileTail(makeVolatile())).toContain("Unfilled starting slots:");
  });

  test("reports bye-week concentration once it is a real problem", () => {
    const req = parseRosterPositions(fixtureLeague.roster_positions);
    const loaded = evaluateRoster(
      [
        { playerId: "a", position: "RB", team: "KC", byeWeek: 9 },
        { playerId: "b", position: "WR", team: "SF", byeWeek: 9 },
      ],
      req,
      13,
    );
    expect(buildVolatileTail(makeVolatile({ roster: loaded }))).toContain("Bye concentration: wk9:2");
  });

  test("includes recent picks when there are any", () => {
    const tail = buildVolatileTail(
      makeVolatile({
        recentPicks: [
          { pickNo: 5, name: "RB Player1", position: "RB", team: "KC" },
          { pickNo: 6, name: "WR Player2", position: "WR", team: "SF" },
        ],
      }),
    );
    expect(tail).toContain("5.RB RB Player1");
  });

  test("surfaces injury notes for shortlisted players", () => {
    const v = makeVolatile();
    const injured = { ...v.candidates[0]!, injuryStatus: "Questionable" };
    const tail = buildVolatileTail({ ...v, candidates: [injured, ...v.candidates.slice(1)] });
    expect(tail).toContain("## Notes");
    expect(tail).toContain("Questionable");
  });

  test("is deterministic for identical state", () => {
    expect(buildVolatileTail(makeVolatile())).toBe(buildVolatileTail(makeVolatile()));
  });
});

// ---------------------------------------------------------------------------

describe("shouldCallModel - the trigger discipline that keeps spend down", () => {
  const ids = ["a", "b", "c", "d"];

  test("calls the strong model on the clock", () => {
    const d = shouldCallModel({ picksUntilMyTurn: 0, topCandidateIds: ids, lastTopCandidateIds: null, manual: false });
    expect(d.call).toBe(true);
    expect(d.urgency).toBe("on_clock");
  });

  test("calls the strong model when the pick is imminent", () => {
    const d = shouldCallModel({
      picksUntilMyTurn: config.llm.onClockThreshold,
      topCandidateIds: ids,
      lastTopCandidateIds: ids,
      manual: false,
    });
    expect(d.call).toBe(true);
    expect(d.urgency).toBe("on_clock");
  });

  test("skips entirely when the board has not moved", () => {
    const d = shouldCallModel({ picksUntilMyTurn: 6, topCandidateIds: ids, lastTopCandidateIds: ids, manual: false });
    expect(d.call).toBe(false);
    expect(d.reason).toBe("board unchanged");
  });

  test("does a cheap background refresh when the top of the board changes", () => {
    const d = shouldCallModel({
      picksUntilMyTurn: 6,
      topCandidateIds: ["z", "b", "c"],
      lastTopCandidateIds: ids,
      manual: false,
    });
    expect(d.call).toBe(true);
    expect(d.urgency).toBe("background");
  });

  test("ignores churn below the top three", () => {
    const d = shouldCallModel({
      picksUntilMyTurn: 6,
      topCandidateIds: ["a", "b", "c", "zzz"],
      lastTopCandidateIds: ["a", "b", "c", "d"],
      manual: false,
    });
    expect(d.call).toBe(false);
  });

  test("stays quiet when your pick is far away", () => {
    const d = shouldCallModel({
      picksUntilMyTurn: 20,
      topCandidateIds: ["z"],
      lastTopCandidateIds: ids,
      manual: false,
    });
    expect(d.call).toBe(false);
    expect(d.reason).toBe("too far from your pick");
  });

  test("a manual refresh always calls, at full strength", () => {
    const d = shouldCallModel({ picksUntilMyTurn: 40, topCandidateIds: ids, lastTopCandidateIds: ids, manual: true });
    expect(d.call).toBe(true);
    expect(d.urgency).toBe("on_clock");
  });

  test("stops calling once you have no picks left", () => {
    const d = shouldCallModel({ picksUntilMyTurn: null, topCandidateIds: ids, lastTopCandidateIds: null, manual: false });
    expect(d.call).toBe(false);
  });
});

describe("usage accounting", () => {
  test("prices cache reads far below fresh input", () => {
    const fresh = summariseUsage("claude-opus-5", { input_tokens: 10_000, output_tokens: 0 }, 0);
    const cached = summariseUsage("claude-opus-5", { input_tokens: 0, cache_read_input_tokens: 10_000, output_tokens: 0 }, 0);
    expect(cached.estimatedCostUsd).toBeCloseTo(fresh.estimatedCostUsd * 0.1, 5);
  });

  test("prices a 1-hour cache write at twice fresh input", () => {
    const fresh = summariseUsage("claude-opus-5", { input_tokens: 10_000, output_tokens: 0 }, 0);
    const write = summariseUsage("claude-opus-5", { cache_creation_input_tokens: 10_000, output_tokens: 0 }, 0);
    expect(write.estimatedCostUsd).toBeCloseTo(fresh.estimatedCostUsd * 2, 5);
  });

  test("Haiku is materially cheaper than Opus for the same tokens", () => {
    const args = { input_tokens: 1000, output_tokens: 1000 };
    const opus = summariseUsage("claude-opus-5", args, 0);
    const haiku = summariseUsage("claude-haiku-4-5", args, 0);
    expect(haiku.estimatedCostUsd).toBeLessThan(opus.estimatedCostUsd / 4);
  });

  test("a realistic on-the-clock call costs a few cents", () => {
    // ~5k cached prefix, ~1.2k volatile tail, ~900 output.
    const u = summariseUsage(
      "claude-opus-5",
      { cache_read_input_tokens: 5000, input_tokens: 1200, output_tokens: 900 },
      1200,
    );
    expect(u.estimatedCostUsd).toBeGreaterThan(0.005);
    expect(u.estimatedCostUsd).toBeLessThan(0.06);
  });

  test("tolerates a missing usage object", () => {
    expect(summariseUsage("claude-opus-5", null, 0).estimatedCostUsd).toBe(0);
  });
});

describe("cache-key hash", () => {
  test("is stable and distinguishes different boards", () => {
    expect(hash("abc")).toBe(hash("abc"));
    expect(hash("abc")).not.toBe(hash("abd"));
  });

  test("handles empty input", () => {
    expect(typeof hash("")).toBe("string");
  });
});
