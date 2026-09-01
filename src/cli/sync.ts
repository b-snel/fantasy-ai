/**
 * `bun run sync` - pull everything the draft needs and cache it to disk.
 *
 * Run this the day of your draft. It front-loads the slow, large, and rate-limited
 * fetches so draft day itself only polls the tiny picks endpoint.
 */

import { config } from "../config.ts";
import { getLeague, getNflState, getPlayers, getTrending, resolveDraft, writeCache } from "../sleeper/client.ts";
import { loadCapabilities } from "../data/capabilities.ts";
import { getProjections } from "../data/projections.ts";
import { getByeWeeks } from "../data/schedule.ts";
import { NFL_TEAMS } from "../../fixtures/index.ts";
import { describeScoring } from "../engine/scoring.ts";

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  console.log("Syncing draft data...\n");

  const capabilities = await loadCapabilities();
  if (capabilities.checkedAt === "never") {
    console.log("  ! doctor has not been run. Run `bun run doctor` first for best results.\n");
  }

  const state = await getNflState();
  const league = await getLeague(config.leagueId);
  if (!league) throw new Error(`Could not load league ${config.leagueId}`);
  const season = state?.season ?? league.season;

  console.log(`  league      ${league.name} (${league.total_rosters} teams, ${league.status})`);
  console.log(`  scoring     ${describeScoring(league.scoring_settings)}`);

  const draft = await resolveDraft(league);
  console.log(`  draft       ${draft.type}, ${draft.settings.rounds} rounds, status ${draft.status}`);

  const players = await getPlayers({ force });
  console.log(`  players     ${Object.keys(players).length} cached`);

  const projections = await getProjections({
    season,
    scoring: league.scoring_settings,
    players,
    capabilities,
    force,
  });
  const source = projections.values().next().value?.source ?? "none";
  console.log(`  projections ${projections.size} players (source: ${source})`);

  const teams = [...new Set(Object.values(players).map((p) => p.team).filter(Boolean))] as string[];
  const byes = await getByeWeeks({
    season,
    teams: teams.length ? teams : NFL_TEAMS,
    capabilities,
    force,
  });
  console.log(`  bye weeks   ${Object.keys(byes).length} teams`);

  const trending = await getTrending("add", 24, 100).catch(() => null);
  if (trending?.length) {
    await writeCache(`${config.paths.dataDir}/trending.json`, trending);
    console.log(`  trending    ${trending.length} players`);
  }

  console.log(`\nDone. Run \`bun start\` when the draft opens.`);
  if (source === "search_rank") {
    console.log(
      `\nNote: real projections were unavailable, so values are modelled from\n` +
        `Sleeper's relevance ranking. Ordering will be sensible; point totals are approximate.`,
    );
  }
}

main().catch((err) => {
  console.error("\nsync failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
