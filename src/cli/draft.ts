/**
 * `bun start` - the draft-day entrypoint.
 */

import { config } from "../config.ts";
import { DraftSession } from "../server/state.ts";
import { serve } from "../server/index.ts";
import { totalSpendUsd, getUsageLog } from "../llm/recommend.ts";

const session = new DraftSession();

const { server, registry } = serve(session);
console.log(`\n  Draft assistant running at http://localhost:${server.port}`);
console.log(`  Open it on a second monitor, or on your phone at http://<this-machine>:${server.port}\n`);

if (!process.env.ANTHROPIC_API_KEY) {
  console.log(`  ! ANTHROPIC_API_KEY is not set - the board will work, cards will not.\n`);
}

await session.start();

const state = session.getState();
if (state.status === "error") {
  console.error(`  Failed to start: ${state.error}\n`);
  process.exit(1);
}

console.log(`  ${state.league?.name} - pick ${state.currentPick}/${state.totalPicks}, status ${state.draftStatus}`);
console.log(`  Polling every ${config.sleeper.pickPollMs}ms. Ctrl-C to stop.\n`);

function shutdown(): void {
  session.stop();
  registry.stop();
  const calls = getUsageLog().length;
  console.log(`\n  ${calls} model call${calls === 1 ? "" : "s"}, $${totalSpendUsd().toFixed(4)} total.\n`);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
