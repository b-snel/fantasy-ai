import { test, expect, describe } from "bun:test";
import { projectionsFromSearchRank } from "../src/data/projections.ts";
import { deriveByeWeeks } from "../src/data/schedule.ts";
import { initialsFor, playerImages } from "../src/data/photos.ts";
import type { PlayersIndex, ScoringSettings } from "../src/sleeper/types.ts";

const PPR: ScoringSettings = { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6 };

function makePlayers(specs: Array<[string, string, number]>): PlayersIndex {
  const out: PlayersIndex = {};
  for (const [id, position, search_rank] of specs) {
    out[id] = { player_id: id, position, search_rank, active: true, full_name: `P ${id}` };
  }
  return out;
}

describe("projectionsFromSearchRank (the always-available fallback)", () => {
  test("preserves positional ordering", () => {
    const players = makePlayers([
      ["a", "RB", 1],
      ["b", "RB", 5],
      ["c", "RB", 30],
    ]);
    const table = projectionsFromSearchRank(players, PPR);
    expect(table.get("a")!.points).toBeGreaterThan(table.get("b")!.points);
    expect(table.get("b")!.points).toBeGreaterThan(table.get("c")!.points);
  });

  test("marks its source so the UI can flag degraded data", () => {
    const table = projectionsFromSearchRank(makePlayers([["a", "RB", 1]]), PPR);
    expect(table.get("a")!.source).toBe("search_rank");
  });

  test("scales receiving positions up under PPR", () => {
    const players = makePlayers([["wr", "WR", 1]]);
    const ppr = projectionsFromSearchRank(players, PPR).get("wr")!.points;
    const std = projectionsFromSearchRank(players, { ...PPR, rec: 0 }).get("wr")!.points;
    expect(ppr).toBeGreaterThan(std);
  });

  test("skips inactive players and sentinel ranks", () => {
    const players: PlayersIndex = {
      live: { player_id: "live", position: "RB", search_rank: 10, active: true },
      retired: { player_id: "retired", position: "RB", search_rank: 11, active: false },
      unranked: { player_id: "unranked", position: "RB", search_rank: 9999999, active: true },
      noRank: { player_id: "noRank", position: "RB", search_rank: null, active: true },
    };
    const table = projectionsFromSearchRank(players, PPR);
    expect(table.has("live")).toBe(true);
    expect(table.has("retired")).toBe(false);
    expect(table.has("unranked")).toBe(false);
    expect(table.has("noRank")).toBe(false);
  });

  test("ignores non-fantasy positions", () => {
    const table = projectionsFromSearchRank(makePlayers([["ls", "LS", 1]]), PPR);
    expect(table.size).toBe(0);
  });

  test("ranks each position on its own curve", () => {
    // A QB and RB with the same global search_rank are each their position's best.
    const table = projectionsFromSearchRank(makePlayers([["qb", "QB", 20], ["rb", "RB", 21]]), PPR);
    expect(table.get("qb")!.points).toBeGreaterThan(table.get("rb")!.points);
  });

  test("is deterministic", () => {
    const players = makePlayers([["a", "RB", 3], ["b", "RB", 3]]);
    const first = [...projectionsFromSearchRank(players, PPR).entries()].map(([k, v]) => [k, v.points]);
    const second = [...projectionsFromSearchRank(players, PPR).entries()].map(([k, v]) => [k, v.points]);
    expect(first).toEqual(second);
  });
});

describe("deriveByeWeeks", () => {
  test("finds the week a team does not play", () => {
    // A complete 3-week, 4-team round robin where each week one pair sits out,
    // mirroring the shape of a real schedule: every team appears in every week
    // except its own bye.
    const games = [
      { week: 1, home: "KC", away: "SF" }, // DAL, BUF bye
      { week: 2, home: "KC", away: "DAL" }, // SF, BUF bye
      { week: 2, home: "SF", away: "BUF" }, // (SF and BUF do play in week 2)
      { week: 3, home: "SF", away: "DAL" },
      { week: 3, home: "KC", away: "BUF" },
    ];
    const byes = deriveByeWeeks(games, ["KC", "SF", "DAL", "BUF"]);
    expect(byes.KC).toBeUndefined(); // plays all three weeks
    expect(byes.DAL).toBe(1);
    expect(byes.BUF).toBe(1);
    expect(byes.SF).toBeUndefined();
  });

  test("returns the first missing week when a team is absent more than once", () => {
    const byes = deriveByeWeeks(
      [
        { week: 1, home: "KC", away: "SF" },
        { week: 4, home: "KC", away: "SF" },
      ],
      ["KC"],
    );
    expect(byes.KC).toBe(2);
  });

  test("ignores teams absent from the schedule entirely", () => {
    expect(deriveByeWeeks([{ week: 1, home: "KC", away: "SF" }], ["NYJ"]).NYJ).toBeUndefined();
  });

  test("handles an empty schedule", () => {
    expect(deriveByeWeeks([], ["KC"])).toEqual({});
  });
});

describe("player images", () => {
  test("uses the Sleeper CDN by player id, with an ESPN fallback", () => {
    const img = playerImages({
      player_id: "4046",
      espn_id: 3139477,
      first_name: "Patrick",
      last_name: "Mahomes",
      full_name: "Patrick Mahomes",
      position: "QB",
    });
    expect(img.primary).toBe("https://sleepercdn.com/content/nfl/players/4046.jpg");
    expect(img.fallback).toContain("a.espncdn.com");
    expect(img.initials).toBe("PM");
  });

  test("team defenses resolve to a team logo", () => {
    const img = playerImages({
      player_id: "KC",
      espn_id: null,
      first_name: null,
      last_name: null,
      full_name: "Kansas City",
      position: "DEF",
    });
    expect(img.primary).toContain("team_logos/nfl/kc.png");
    expect(img.fallback).toBeNull();
  });

  test("omits the ESPN fallback when there is no espn_id", () => {
    const img = playerImages({
      player_id: "9999",
      espn_id: null,
      first_name: "Rook",
      last_name: "Ie",
      full_name: "Rook Ie",
      position: "WR",
    });
    expect(img.fallback).toBeNull();
  });

  test("derives initials from whatever name fields exist", () => {
    expect(initialsFor({ player_id: "1", first_name: "Ja'Marr", last_name: "Chase", full_name: null })).toBe("JC");
    expect(initialsFor({ player_id: "2", first_name: null, last_name: null, full_name: "Amon-Ra St. Brown" })).toBe("AB");
    expect(initialsFor({ player_id: "3", first_name: null, last_name: null, full_name: null })).toBe("3");
  });
});
