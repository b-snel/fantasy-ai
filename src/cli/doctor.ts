/**
 * `bun run doctor` — probe every endpoint this app can use and report what works.
 *
 * Several data sources here are undocumented; some are documented but were never
 * verified against this specific league. Rather than discover that on draft day,
 * this command hits all of them once, prints a readable report, and writes
 * data/capabilities.json so the adapters know which chain to use.
 *
 * It is also the fastest way to hand back a diagnosis when something breaks.
 */

import { config } from "../config.ts";
import {
  getDraft,
  getJson,
  getLeague,
  getLeagueUsers,
  getNflState,
  getRosters,
  getTradedPicks,
  getTrending,
  resolveDraft,
} from "../sleeper/client.ts";
import { describeScoring } from "../engine/scoring.ts";
import { parseRosterPositions } from "../engine/replacement.ts";
import { saveCapabilities, type Capabilities } from "../data/capabilities.ts";
import { checkAdpSanity, extractAdp } from "../data/adp.ts";
import { myRosterIdFromDraft } from "../engine/snake.ts";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

type Outcome = "ok" | "fail" | "warn";

const results: Array<{ name: string; outcome: Outcome; detail: string }> = [];

function record(name: string, outcome: Outcome, detail: string): void {
  const mark = outcome === "ok" ? `${GREEN}✓${RESET}` : outcome === "warn" ? `${YELLOW}!${RESET}` : `${RED}✗${RESET}`;
  console.log(`  ${mark} ${name.padEnd(38)} ${DIM}${detail}${RESET}`);
  results.push({ name, outcome, detail });
}

/** HEAD a URL and report whether it serves the content type we expect. */
async function probeImage(name: string, url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(12_000) });
    const type = res.headers.get("content-type") ?? "";
    const length = res.headers.get("content-length") ?? "?";
    if (res.ok && type.startsWith("image/")) {
      record(name, "ok", `${res.status} ${type} ${length}b`);
      return true;
    }
    record(name, "fail", `${res.status} ${type || "no content-type"}`);
    return false;
  } catch (err) {
    record(name, "fail", err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function probeJson(name: string, url: string): Promise<unknown | null> {
  try {
    const data = await getJson<unknown>(url, { retries: 0, timeoutMs: 20_000 });
    if (data == null) {
      record(name, "fail", "empty or 404");
      return null;
    }
    const count = Array.isArray(data) ? `${data.length} rows` : `${Object.keys(data as object).length} keys`;
    record(name, "ok", count);
    return data;
  } catch (err) {
    record(name, "fail", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}Sleeper draft assistant — connectivity and capability check${RESET}`);
  console.log(`${DIM}league ${config.leagueId} · user ${config.username} (${config.userId})${RESET}\n`);

  const notes: string[] = [];

  // -- Documented API -------------------------------------------------------
  console.log(`${BOLD}Documented API (api.sleeper.app)${RESET}`);

  const state = await getNflState().catch(() => null);
  record(
    "GET /state/nfl",
    state ? "ok" : "fail",
    state ? `season ${state.season} ${state.season_type} week ${state.week}` : "unreachable",
  );

  const league = await getLeague(config.leagueId).catch(() => null);
  if (!league) {
    record("GET /league/{id}", "fail", "could not load your league — nothing else will work");
    console.log(`\n${RED}Stopping: the league endpoint is the foundation for everything.${RESET}`);
    console.log(`${DIM}Check the league id in src/config.ts and your network.${RESET}\n`);
    process.exit(1);
  }
  record("GET /league/{id}", "ok", `"${league.name}" · ${league.total_rosters} teams · ${league.status}`);

  const req = parseRosterPositions(league.roster_positions);
  console.log(`      ${DIM}scoring:  ${describeScoring(league.scoring_settings)}${RESET}`);
  console.log(`      ${DIM}starters: ${JSON.stringify(req.starters)} flex ${JSON.stringify(req.flex)} bench ${req.benchSlots}${RESET}`);

  const users = await getLeagueUsers(config.leagueId).catch(() => null);
  const me = users?.find((u) => u.user_id === config.userId);
  record(
    "GET /league/{id}/users",
    users ? (me ? "ok" : "warn") : "fail",
    users ? (me ? `found you: ${me.display_name}` : `${users.length} users, but your user_id is not among them`) : "unreachable",
  );
  if (users && !me) notes.push("your user_id was not found in the league users list — check SLEEPER_USER_ID");

  const rosters = await getRosters(config.leagueId).catch(() => null);
  const myRoster = rosters?.find((r) => r.owner_id === config.userId);
  record(
    "GET /league/{id}/rosters",
    rosters ? (myRoster ? "ok" : "warn") : "fail",
    rosters
      ? myRoster
        ? `your roster_id is ${myRoster.roster_id} (${myRoster.players?.length ?? 0} players)`
        : `${rosters.length} rosters, none owned by you`
      : "unreachable",
  );

  const draft = await resolveDraft(league).catch(() => null);
  if (draft) {
    const s = draft.settings;
    record(
      "GET /draft/{id}",
      "ok",
      `${draft.type} · ${s.teams} teams · ${s.rounds} rounds · timer ${s.pick_timer ?? "?"}s · ${draft.status}`,
    );
    if (draft.type !== "snake" && draft.type !== "linear") {
      notes.push(`draft type is "${draft.type}" — this build targets snake/linear drafts`);
      record("draft type", "warn", `"${draft.type}" is not a snake draft`);
    }
    if (s.reversal_round) {
      console.log(`      ${DIM}reversal_round ${s.reversal_round} (third-round-reversal style)${RESET}`);
    }

    const mySlot = draft.draft_order?.[config.userId];
    const myRosterFromDraft = myRosterIdFromDraft(draft, config.userId);
    record(
      "draft order",
      draft.draft_order ? (mySlot ? "ok" : "warn") : "warn",
      draft.draft_order
        ? mySlot
          ? `you draft from slot ${mySlot} (roster ${myRosterFromDraft})`
          : "order is set but your user is not in it"
        : "not set yet (normal before the draft opens)",
    );

    await probeJson(`GET /draft/{id}/picks`, `${config.sleeper.apiBase}/draft/${draft.draft_id}/picks`);
    const traded = await getTradedPicks(draft.draft_id).catch(() => null);
    record("GET /draft/{id}/traded_picks", traded ? "ok" : "warn", `${traded?.length ?? 0} traded picks`);
  } else {
    record("GET /draft/{id}", "fail", "no draft found for this league");
    notes.push("no draft object — the league may not have scheduled its draft yet");
  }

  const trending = await getTrending("add", 24, 10).catch(() => null);
  const trendingOk = Array.isArray(trending) && trending.length > 0;
  record("GET /players/nfl/trending/add", trendingOk ? "ok" : "warn", `${trending?.length ?? 0} rows`);

  console.log(`\n${BOLD}Player dump${RESET}`);
  const playersOk = await probeJson("GET /players/nfl (~5MB)", `${config.sleeper.apiBase}/players/nfl`);

  // -- Undocumented data host ----------------------------------------------
  console.log(`\n${BOLD}Undocumented data host (api.sleeper.com)${RESET}`);
  console.log(`${DIM}  These power real projections and ADP. If they fail the app still works,${RESET}`);
  console.log(`${DIM}  falling back to search_rank — coarser, but from the documented API.${RESET}`);

  const season = state?.season ?? league.season;
  const positionQuery = ["QB", "RB", "WR", "TE", "K", "DEF"].map((p) => `position[]=${p}`).join("&");

  const bulk = await probeJson(
    "projections/nfl/{season}/{week}",
    `${config.sleeper.dataBase}/projections/nfl/${season}/1?season_type=regular&${positionQuery}`,
  );
  const bulkProjections = Array.isArray(bulk) && bulk.length > 0;
  if (bulkProjections) {
    const sample = bulk[0] as Record<string, unknown>;
    const statKeys = Object.keys((sample.stats as object) ?? {}).slice(0, 8);
    console.log(`      ${DIM}sample keys: ${Object.keys(sample).slice(0, 8).join(", ")}${RESET}`);
    console.log(`      ${DIM}stat keys:   ${statKeys.join(", ")}${RESET}`);
    /*
     * ADP deserves a real report rather than a one-line yes/no.
     *
     * It is the input behind survival probability and VONA, and when it is absent
     * nothing breaks loudly - every survival estimate just flattens to 0.5 and the
     * board keeps rendering. An earlier version of this check only looked at the
     * top level, reported "none found", and was wrong: the fields live in `stats`.
     */
    const stats = (sample.stats as Record<string, unknown>) ?? {};
    const allAdp = [
      ...Object.entries(sample),
      ...Object.entries(stats),
    ].filter(([k]) => k.toLowerCase().includes("adp"));

    if (allAdp.length) {
      console.log(
        `      ${DIM}adp keys:    ${allAdp
          .map(([k, v]) => `${k}=${typeof v === "number" ? v : String(v)}`)
          .join(", ")}${RESET}`,
      );
    } else {
      console.log(`      ${DIM}adp keys:    none${RESET}`);
    }

    // One extraction pass serves both the field report and the sanity check, so
    // the two can never disagree. The first row may be a sentinel-capped player
    // (every K and DEF is), which extracts to nothing - report the first that has one.
    const extracted = (bulk as Array<Record<string, unknown>>)
      .map((r) => extractAdp(r, league.scoring_settings))
      .filter((x): x is NonNullable<typeof x> => x != null);
    const chosen = extracted[0];
    if (chosen) {
      const values = extracted.map((x) => x.value);
      const sanity = checkAdpSanity(values, league.total_rosters);

      record(
        "ADP field selected",
        sanity.ok ? "ok" : "warn",
        sanity.ok
          ? `${chosen.key} · ${sanity.count} players · range ${sanity.min.toFixed(1)}-${sanity.max.toFixed(1)}`
          : `${chosen.key} · ${sanity.warning}`,
      );
      if (!sanity.ok) {
        notes.push(`ADP from ${chosen.key} failed its sanity check: ${sanity.warning}`);
      }
    } else {
      record("ADP field selected", "warn", "none usable — falling back to search_rank ordering");
      notes.push(
        "no usable overall ADP in the projections payload — survival and VONA will " +
          "fall back to search_rank ordering, which is coarser",
      );
    }
  }

  const seasonProj = await probeJson(
    "projections/nfl/player/{id}",
    `${config.sleeper.dataBase}/projections/nfl/player/4046?season_type=regular&season=${season}`,
  );

  const schedule = await probeJson(
    "schedule/nfl/regular/{season}",
    `${config.sleeper.dataBase}/schedule/nfl/regular/${season}`,
  );

  // -- CDN images -----------------------------------------------------------
  console.log(`\n${BOLD}Images (sleepercdn.com)${RESET}`);
  const samplePlayerId = "4046"; // Patrick Mahomes — a stable, well-known id
  const playerPhotos = await probeImage(
    "content/nfl/players/{id}.jpg",
    `${config.sleeper.cdnBase}/content/nfl/players/${samplePlayerId}.jpg`,
  );
  const playerPhotoThumbs = await probeImage(
    "content/nfl/players/thumb/{id}.jpg",
    `${config.sleeper.cdnBase}/content/nfl/players/thumb/${samplePlayerId}.jpg`,
  );
  const teamLogos = await probeImage(
    "images/team_logos/nfl/{team}.png",
    `${config.sleeper.cdnBase}/images/team_logos/nfl/kc.png`,
  );
  if (!teamLogos) notes.push("team logo path does not work — the UI will use position badges instead");

  // -- Anthropic ------------------------------------------------------------
  console.log(`\n${BOLD}Anthropic API${RESET}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    record("ANTHROPIC_API_KEY", "fail", "not set — copy .env.example to .env and add your key");
    notes.push("ANTHROPIC_API_KEY is not set; recommendation cards will not work");
  } else {
    record("ANTHROPIC_API_KEY", "ok", `set (${process.env.ANTHROPIC_API_KEY.slice(0, 12)}…)`);
  }

  // -- Write capabilities ---------------------------------------------------
  const capabilities: Capabilities = {
    checkedAt: new Date().toISOString(),
    bulkProjections,
    playerProjections: seasonProj != null,
    schedule: Array.isArray(schedule) && schedule.length > 0,
    playerPhotos,
    playerPhotoThumbs,
    teamLogos,
    trending: trendingOk,
    notes,
  };
  await saveCapabilities(capabilities);

  // -- Summary --------------------------------------------------------------
  const failed = results.filter((r) => r.outcome === "fail");
  const warned = results.filter((r) => r.outcome === "warn");

  console.log(`\n${BOLD}Summary${RESET}`);
  console.log(`  ${results.filter((r) => r.outcome === "ok").length} ok · ${warned.length} warnings · ${failed.length} failures`);
  console.log(`  ${DIM}wrote ${config.paths.capabilities}${RESET}`);

  if (!bulkProjections) {
    console.log(`\n  ${YELLOW}Projections are unavailable — falling back to search_rank.${RESET}`);
    console.log(`  ${DIM}The board will still rank sensibly, but point estimates will be modelled${RESET}`);
    console.log(`  ${DIM}from Sleeper's relevance ordering rather than real projections.${RESET}`);
  }
  if (!playersOk) {
    console.log(`\n  ${RED}The player dump failed. Nothing works without it — retry before drafting.${RESET}`);
  }
  for (const note of notes) console.log(`  ${YELLOW}note:${RESET} ${note}`);
  console.log();

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${RED}doctor crashed:${RESET}`, err);
  process.exit(1);
});
