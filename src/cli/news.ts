/**
 * `bun run news` - sweep the top players for recent news, once, before the draft.
 *
 * Deliberately a separate command rather than part of `sync`: it is the only step
 * that costs real money, and it should be a decision rather than a side effect.
 */

import { config } from "../config.ts";
import { getLeague, getPlayers } from "../sleeper/client.ts";
import { loadCapabilities } from "../data/capabilities.ts";
import { getProjections } from "../data/projections.ts";
import { sweepNews } from "../data/news.ts";

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 150;

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("\n  ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.\n");
    process.exit(1);
  }

  const league = await getLeague(config.leagueId);
  if (!league) throw new Error(`Could not load league ${config.leagueId}`);

  const players = await getPlayers();
  const projections = await getProjections({
    season: league.season,
    scoring: league.scoring_settings,
    players,
    capabilities: await loadCapabilities(),
  });

  // Sweep in value order so the budget goes to players you might actually draft.
  const ranked = [...projections.values()]
    .sort((a, b) => (a.adp ?? 9999) - (b.adp ?? 9999))
    .map((p) => p.playerId);

  console.log(`\n  Sweeping news for the top ${limit} players using ${config.llm.newsModel}...\n`);

  const result = await sweepNews({
    players,
    playerIds: ranked,
    limit,
    onProgress: (done, total, usage) => {
      console.log(
        `  ${String(done).padStart(4)}/${total}  $${usage.estimatedCostUsd.toFixed(4)}  ${usage.latencyMs}ms`,
      );
    },
  });

  console.log(`\n  ${result.news.size} players have notes (${result.batches} batches).`);
  console.log(`  Total cost: $${result.totalCostUsd.toFixed(3)}`);
  console.log(`  Cached to ${config.paths.news}\n`);

  for (const [id, note] of [...result.news].slice(0, 8)) {
    console.log(`    ${(players[id]?.full_name ?? id).padEnd(24)} ${note}`);
  }
  if (result.news.size > 8) console.log(`    ... and ${result.news.size - 8} more\n`);
}

main().catch((err) => {
  console.error("\n  news sweep failed:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
