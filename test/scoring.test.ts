import { test, expect, describe } from "bun:test";
import {
  describeScoring,
  pprValue,
  scoreStatLine,
  scoringFormatName,
} from "../src/engine/scoring.ts";
import type { ScoringSettings } from "../src/sleeper/types.ts";

const PPR: ScoringSettings = {
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -2,
  rush_yd: 0.1,
  rush_td: 6,
  rec: 1,
  rec_yd: 0.1,
  rec_td: 6,
  fum_lost: -2,
};

describe("scoreStatLine", () => {
  test("scores a receiving line under full PPR", () => {
    // 90 catches, 1200 yards, 8 TDs = 90 + 120 + 48
    const pts = scoreStatLine({ rec: 90, rec_yd: 1200, rec_td: 8 }, PPR, "WR");
    expect(pts).toBe(258);
  });

  test("half PPR halves the reception component", () => {
    const half: ScoringSettings = { ...PPR, rec: 0.5 };
    const pts = scoreStatLine({ rec: 90, rec_yd: 1200, rec_td: 8 }, half, "WR");
    expect(pts).toBe(213); // 45 + 120 + 48
  });

  test("scores a passing line including negative stats", () => {
    // 4500 yd = 180, 35 TD = 140, 12 INT = -24
    const pts = scoreStatLine({ pass_yd: 4500, pass_td: 35, pass_int: 12 }, PPR, "QB");
    expect(pts).toBe(296);
  });

  test("applies TE premium only to tight ends", () => {
    const tePrem: ScoringSettings = { ...PPR, bonus_rec_te: 0.5 };
    const line = { rec: 80, rec_yd: 900, rec_td: 6 };
    const te = scoreStatLine(line, tePrem, "TE");
    const wr = scoreStatLine(line, tePrem, "WR");
    expect(te - wr).toBe(40); // 80 receptions x 0.5
  });

  test("ignores stats the league does not score and missing keys", () => {
    const pts = scoreStatLine({ rec: 10, tackles_solo: 99, bogus: 5 }, PPR, "WR");
    expect(pts).toBe(10);
  });

  test("an empty line scores zero", () => {
    expect(scoreStatLine({}, PPR, "WR")).toBe(0);
  });

  test("tolerates null and non-finite stat values", () => {
    const pts = scoreStatLine(
      { rec: 10, rec_yd: null, rec_td: undefined, pass_yd: Number.NaN },
      PPR,
      "WR",
    );
    expect(pts).toBe(10);
  });
});

describe("format naming", () => {
  test("identifies scoring formats", () => {
    expect(scoringFormatName(PPR)).toBe("Full PPR");
    expect(scoringFormatName({ ...PPR, rec: 0.5 })).toBe("Half PPR");
    expect(scoringFormatName({ ...PPR, rec: 0 })).toBe("Standard");
    expect(pprValue(PPR)).toBe(1);
  });

  test("flags TE premium", () => {
    expect(scoringFormatName({ ...PPR, bonus_rec_te: 0.5 })).toContain("TE premium");
  });

  test("describeScoring is deterministic across calls", () => {
    // This string lives in the cached prompt prefix; instability would silently
    // destroy the cache hit rate.
    expect(describeScoring(PPR)).toBe(describeScoring({ ...PPR }));
    expect(describeScoring(PPR)).toContain("1pt/25");
  });
});
