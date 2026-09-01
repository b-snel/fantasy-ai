/**
 * ADP extraction.
 *
 * The key names here are taken from a real 2026 projections response, not guessed:
 * `adp_dd_ppr` and `pos_adp_dd_ppr` live inside `stats`. The original code looked
 * for `adp_ppr` at the top level, found nothing, and fell through to null - which
 * does not fail loudly, it just flattens every survival probability to 0.5 and
 * makes VONA meaningless while the board still renders normally.
 */

import { test, expect, describe } from "bun:test";
import {
  adpFormatOf,
  checkAdpSanity,
  extractAdp,
  formatPreference,
  isUsableAdpKey,
} from "../src/data/adp.ts";
import type { ScoringSettings } from "../src/sleeper/types.ts";

const FULL_PPR: ScoringSettings = { rec: 1 };
const HALF_PPR: ScoringSettings = { rec: 0.5 };
const STANDARD: ScoringSettings = { rec: 0 };

describe("adpFormatOf", () => {
  test("reads the format out of real Sleeper key names", () => {
    expect(adpFormatOf("adp_dd_ppr")).toBe("ppr");
    expect(adpFormatOf("adp_dd_half_ppr")).toBe("half_ppr");
    expect(adpFormatOf("adp_dd_std")).toBe("std");
  });

  test("half_ppr wins over ppr, since the key contains both", () => {
    // "adp_dd_half_ppr".includes("ppr") is true, so naive matching mislabels it.
    expect(adpFormatOf("adp_dd_half_ppr")).toBe("half_ppr");
  });

  test("an unadorned key has no declared format", () => {
    expect(adpFormatOf("adp")).toBe("unknown");
  });
});

describe("isUsableAdpKey", () => {
  test("accepts overall ADP", () => {
    expect(isUsableAdpKey("adp_dd_ppr")).toBe(true);
    expect(isUsableAdpKey("adp")).toBe(true);
  });

  test("rejects positional ADP", () => {
    // pos_adp is "the 5th running back", not "pick 5". Feeding it to the survival
    // model would claim every position's fifth player goes at pick five.
    expect(isUsableAdpKey("pos_adp_dd_ppr")).toBe(false);
    expect(isUsableAdpKey("pos_adp")).toBe(false);
  });

  test("rejects ADP for a different game", () => {
    expect(isUsableAdpKey("adp_dynasty_ppr")).toBe(false);
    expect(isUsableAdpKey("adp_rookie")).toBe(false);
    expect(isUsableAdpKey("adp_2qb")).toBe(false);
    expect(isUsableAdpKey("adp_superflex")).toBe(false);
  });

  test("rejects keys that are not ADP at all", () => {
    expect(isUsableAdpKey("pts_half_ppr")).toBe(false);
    expect(isUsableAdpKey("gp")).toBe(false);
    expect(isUsableAdpKey("rec_yd")).toBe(false);
  });
});

describe("formatPreference", () => {
  test("prefers the league's own format", () => {
    expect(formatPreference(FULL_PPR)[0]).toBe("ppr");
    expect(formatPreference(HALF_PPR)[0]).toBe("half_ppr");
    expect(formatPreference(STANDARD)[0]).toBe("std");
  });

  test("half PPR falls back to full PPR before standard", () => {
    expect(formatPreference(HALF_PPR)).toEqual(["half_ppr", "ppr", "std", "unknown"]);
  });
});

describe("extractAdp against a real payload shape", () => {
  /** Shaped like an actual row: ADP lives in `stats`, alongside pos_adp and points. */
  const realRow = {
    player_id: "4046",
    week: 1,
    season: "2026",
    season_type: "regular",
    category: "proj",
    stats: {
      adp_dd_ppr: 12.4,
      pos_adp_dd_ppr: 3,
      pts_half_ppr: 18.2,
      gp: 1,
      rec: 5.1,
      rec_yd: 64,
    },
  };

  test("finds ADP nested inside stats", () => {
    const found = extractAdp(realRow, FULL_PPR);
    expect(found?.value).toBe(12.4);
    expect(found?.key).toBe("adp_dd_ppr");
  });

  test("never picks the positional ADP sitting right next to it", () => {
    // pos_adp_dd_ppr is 3, a far more attractive-looking small number.
    expect(extractAdp(realRow, FULL_PPR)?.value).not.toBe(3);
  });

  test("a half-PPR league still uses PPR ADP when that is all there is", () => {
    const found = extractAdp(realRow, HALF_PPR);
    expect(found?.key).toBe("adp_dd_ppr");
  });

  test("prefers the matching format when several are offered", () => {
    const row = {
      stats: { adp_dd_ppr: 12.4, adp_dd_half_ppr: 14.1, adp_dd_std: 19.8 },
    };
    expect(extractAdp(row, HALF_PPR)?.key).toBe("adp_dd_half_ppr");
    expect(extractAdp(row, FULL_PPR)?.key).toBe("adp_dd_ppr");
    expect(extractAdp(row, STANDARD)?.key).toBe("adp_dd_std");
  });

  test("finds ADP at the top level too", () => {
    expect(extractAdp({ adp: 30, stats: {} }, FULL_PPR)?.value).toBe(30);
  });

  test("returns null when there is genuinely no ADP", () => {
    expect(extractAdp({ stats: { pts_ppr: 12, gp: 1 } }, FULL_PPR)).toBeNull();
  });

  test("ignores zero, negative and non-numeric values", () => {
    expect(extractAdp({ stats: { adp_dd_ppr: 0 } }, FULL_PPR)).toBeNull();
    expect(extractAdp({ stats: { adp_dd_ppr: -1 } }, FULL_PPR)).toBeNull();
    expect(extractAdp({ stats: { adp_dd_ppr: "12" } }, FULL_PPR)).toBeNull();
  });

  test("skips dynasty ADP even when it is the only thing present", () => {
    // Better to fall back to search_rank than to rank a redraft off dynasty values.
    expect(extractAdp({ stats: { adp_dynasty_ppr: 5 } }, FULL_PPR)).toBeNull();
  });

  test("is deterministic when two keys tie on format", () => {
    const row = { stats: { adp_zz_ppr: 20, adp_aa_ppr: 10 } };
    expect(extractAdp(row, FULL_PPR)?.key).toBe(extractAdp(row, FULL_PPR)?.key);
    expect(extractAdp(row, FULL_PPR)?.key).toBe("adp_aa_ppr");
  });

  test("handles a row with no stats object", () => {
    expect(extractAdp({ player_id: "1" }, FULL_PPR)).toBeNull();
  });
});

describe("checkAdpSanity", () => {
  test("accepts a plausible overall-ADP distribution", () => {
    const values = Array.from({ length: 200 }, (_, i) => i + 1);
    const s = checkAdpSanity(values);
    expect(s.ok).toBe(true);
    expect(s.warning).toBeNull();
  });

  test("flags positional ADP by how crowded the early picks are", () => {
    // Six positions each numbered from 1, which is what pos_adp_* actually looks
    // like across a full pool. Range alone would not catch this - receivers reach
    // well past 100 - but the first round ends up holding 72 players instead of 12.
    const values: number[] = [];
    for (let pos = 0; pos < 6; pos++) {
      for (let rank = 1; rank <= 40; rank++) values.push(rank);
    }
    const s = checkAdpSanity(values);
    expect(s.ok).toBe(false);
    expect(s.warning).toContain("positional");
  });

  test("does not cry positional over a small sample", () => {
    // A short list is not evidence of anything; density needs a real pool.
    expect(checkAdpSanity([1, 2, 3, 20, 45, 90]).ok).toBe(true);
  });

  test("accepts a realistically clustered overall ADP", () => {
    // Real ADP has ties and gaps; it is not a clean 1..N sequence.
    const values = Array.from({ length: 200 }, (_, i) => Math.round((i + 1) * 1.15));
    expect(checkAdpSanity(values).ok).toBe(true);
  });

  test("flags a distribution that never starts near pick one", () => {
    const s = checkAdpSanity([50, 80, 120, 200]);
    expect(s.ok).toBe(false);
    expect(s.warning).toContain("should start near 1");
  });

  test("reports an empty set rather than pretending it is fine", () => {
    const s = checkAdpSanity([]);
    expect(s.ok).toBe(false);
    expect(s.count).toBe(0);
  });

  test("ignores nulls and nonsense in the input", () => {
    const s = checkAdpSanity([1, Number.NaN, 0, -5, 150]);
    expect(s.count).toBe(2);
    expect(s.ok).toBe(true);
  });
});
