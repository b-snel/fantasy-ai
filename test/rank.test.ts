import { test, expect, describe } from "bun:test";
import { parseRosterPositions } from "../src/engine/replacement.ts";
import { evaluateRoster } from "../src/engine/roster.ts";
import {
  buildShortlist,
  expectedBestAtPick,
  scoreBoard,
  survivalProbability,
  type BoardContext,
  type RankablePlayer,
} from "../src/engine/rank.ts";

const REQ = parseRosterPositions([
  "QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF",
  "BN", "BN", "BN", "BN", "BN", "BN",
]);

function player(over: Partial<RankablePlayer> & { playerId: string }): RankablePlayer {
  return {
    name: `Player ${over.playerId}`,
    position: "RB",
    team: "SF",
    byeWeek: 9,
    projectedPoints: 200,
    adp: 50,
    injuryStatus: null,
    practiceParticipation: null,
    age: 26,
    yearsExp: 4,
    depthChartOrder: 1,
    trendingAdds: 0,
    ...over,
  };
}

function ctx(over: Partial<BoardContext> = {}): BoardContext {
  return {
    currentPick: 25,
    myNextPick: 25,
    myPickAfterNext: 48,
    roster: evaluateRoster([], REQ, 13),
    replacementPoints: { QB: 250, RB: 120, WR: 130, TE: 100, K: 100, DEF: 90 },
    picksRemaining: 13,
    ...over,
  };
}

describe("survivalProbability", () => {
  test("a player whose ADP is far ahead of the pick is long gone", () => {
    expect(survivalProbability(5, 60)).toBeLessThan(0.01);
  });

  test("a player whose ADP is far behind the pick is certainly there", () => {
    expect(survivalProbability(150, 20)).toBeGreaterThan(0.99);
  });

  test("at exactly ADP it is a coin flip", () => {
    expect(survivalProbability(40, 40)).toBeCloseTo(0.5, 5);
  });

  test("uncertainty widens later in the draft", () => {
    // 10 picks past ADP: an early pick is more certainly gone than a late one.
    expect(survivalProbability(10, 20)).toBeLessThan(survivalProbability(120, 130));
  });

  test("unknown ADP yields no information rather than a guess", () => {
    expect(survivalProbability(null, 30)).toBe(0.5);
  });

  test("is monotonically decreasing in target pick", () => {
    let prev = 1;
    for (let pick = 1; pick <= 120; pick += 10) {
      const s = survivalProbability(60, pick);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
  });
});

describe("expectedBestAtPick", () => {
  test("returns the top player's value when he is certain to last", () => {
    const got = expectedBestAtPick([{ vorp: 100, adp: 200 }, { vorp: 50, adp: 210 }], 20);
    expect(got).toBeCloseTo(100, 0);
  });

  test("falls back toward lesser players when the top ones will be gone", () => {
    const got = expectedBestAtPick([{ vorp: 100, adp: 1 }, { vorp: 40, adp: 200 }], 60);
    expect(got).toBeGreaterThan(35);
    expect(got).toBeLessThan(45);
  });

  test("an empty position pool is worth nothing", () => {
    expect(expectedBestAtPick([], 30)).toBe(0);
  });

  test("a deeper position holds its value better across the gap", () => {
    const deep = Array.from({ length: 20 }, (_, i) => ({ vorp: 100 - i, adp: 20 + i * 3 }));
    const thin = [{ vorp: 100, adp: 20 }, { vorp: 10, adp: 200 }];
    expect(expectedBestAtPick(deep, 70)).toBeGreaterThan(expectedBestAtPick(thin, 70));
  });
});

describe("scoreBoard", () => {
  test("computes VORP against the position's replacement level", () => {
    const board = scoreBoard([player({ playerId: "a", projectedPoints: 220 })], ctx());
    expect(board[0]!.vorp).toBe(100); // 220 - RB replacement 120
  });

  test("ranks a higher projection above a lower one, all else equal", () => {
    const board = scoreBoard(
      [
        player({ playerId: "low", projectedPoints: 180 }),
        player({ playerId: "high", projectedPoints: 260 }),
      ],
      ctx(),
    );
    expect(board[0]!.playerId).toBe("high");
  });

  test("penalises injured players", () => {
    const board = scoreBoard(
      [
        player({ playerId: "healthy" }),
        player({ playerId: "hurt", injuryStatus: "Out" }),
      ],
      ctx(),
    );
    const healthy = board.find((p) => p.playerId === "healthy")!;
    const hurt = board.find((p) => p.playerId === "hurt")!;
    expect(hurt.score).toBeLessThan(healthy.score);
    expect(hurt.components.injury).toBeLessThan(0);
  });

  test("an IR designation is penalised more than questionable", () => {
    const board = scoreBoard(
      [
        player({ playerId: "q", injuryStatus: "Questionable" }),
        player({ playerId: "ir", injuryStatus: "IR" }),
      ],
      ctx(),
    );
    const q = board.find((p) => p.playerId === "q")!;
    const ir = board.find((p) => p.playerId === "ir")!;
    expect(ir.components.injury).toBeLessThan(q.components.injury);
  });

  test("rewards the last player above a real tier cliff", () => {
    const board = scoreBoard(
      [
        player({ playerId: "cliff", projectedPoints: 240 }),
        player({ playerId: "below", projectedPoints: 200 }), // 40-point gap
      ],
      ctx(),
    );
    expect(board.find((p) => p.playerId === "cliff")!.components.tierBreak).toBeGreaterThan(0);
  });

  test("reports ADP delta relative to the current pick", () => {
    const board = scoreBoard([player({ playerId: "a", adp: 40 })], ctx({ currentPick: 25 }));
    expect(board[0]!.adpDelta).toBe(15); // falling 15 picks past his ADP
  });

  test("penalises stacking a third starter on one bye week", () => {
    const loaded = evaluateRoster(
      [
        { playerId: "x", position: "RB", team: "KC", byeWeek: 9 },
        { playerId: "y", position: "WR", team: "KC", byeWeek: 9 },
      ],
      REQ,
      13,
    );
    const board = scoreBoard(
      [player({ playerId: "a", byeWeek: 9, team: "DAL" })],
      ctx({ roster: loaded }),
    );
    expect(board[0]!.components.byeConflict).toBeLessThan(0);
  });

  test("gives a small bonus for stacking with a team you already own", () => {
    const withQb = evaluateRoster(
      [{ playerId: "qb", position: "QB", team: "BUF", byeWeek: 7 }],
      REQ,
      13,
    );
    const board = scoreBoard(
      [player({ playerId: "wr", position: "WR", team: "BUF" })],
      ctx({ roster: withQb }),
    );
    expect(board[0]!.components.stack).toBeGreaterThan(0);
  });

  test("is deterministic — same input, same order", () => {
    const players = [
      player({ playerId: "a", projectedPoints: 200 }),
      player({ playerId: "b", projectedPoints: 200 }),
      player({ playerId: "c", projectedPoints: 200 }),
    ];
    const first = scoreBoard(players, ctx()).map((p) => p.playerId);
    const second = scoreBoard([...players].reverse(), ctx()).map((p) => p.playerId);
    expect(first).toEqual(second);
  });

  test("handles an empty board", () => {
    expect(scoreBoard([], ctx())).toEqual([]);
  });

  test("VONA is zero when there is no following pick to wait for", () => {
    const board = scoreBoard([player({ playerId: "a" })], ctx({ myPickAfterNext: null }));
    expect(board[0]!.vona).toBe(0);
  });
});

describe("buildShortlist", () => {
  test("returns at most the requested size plus the guaranteed extras", () => {
    const players = Array.from({ length: 40 }, (_, i) =>
      player({ playerId: `p${i}`, projectedPoints: 300 - i * 5 }),
    );
    const list = buildShortlist(scoreBoard(players, ctx()), 8);
    expect(list.length).toBeGreaterThanOrEqual(8);
    expect(list.length).toBeLessThanOrEqual(11);
  });

  test("never repeats a player", () => {
    const players = Array.from({ length: 20 }, (_, i) =>
      player({ playerId: `p${i}`, position: i % 2 ? "WR" : "RB", projectedPoints: 300 - i * 4 }),
    );
    const list = buildShortlist(scoreBoard(players, ctx()), 6);
    expect(new Set(list.map((p) => p.playerId)).size).toBe(list.length);
  });

  test("surfaces an upside pick that the blend would otherwise bury", () => {
    const players = [
      ...Array.from({ length: 8 }, (_, i) =>
        player({ playerId: `vet${i}`, projectedPoints: 260 - i, yearsExp: 8, adp: 10 + i }),
      ),
      player({ playerId: "rookie", projectedPoints: 165, yearsExp: 0, adp: 130 }),
    ];
    const list = buildShortlist(scoreBoard(players, ctx()), 8);
    expect(list.some((p) => p.playerId === "rookie")).toBe(true);
  });

  test("covers an unfilled position even during a run at another", () => {
    // A board dominated by RBs, with the roster still needing a QB.
    const players = [
      ...Array.from({ length: 12 }, (_, i) =>
        player({ playerId: `rb${i}`, position: "RB", projectedPoints: 260 - i * 2 }),
      ),
      player({ playerId: "qb1", position: "QB", projectedPoints: 300 }),
    ];
    const list = buildShortlist(scoreBoard(players, ctx()), 5);
    expect(list.some((p) => p.position === "QB")).toBe(true);
  });

  test("handles an empty board", () => {
    expect(buildShortlist([], 8)).toEqual([]);
  });
});
