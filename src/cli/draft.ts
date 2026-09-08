/**
 * `bun start` - the draft-day entrypoint.
 */

import { config } from "../config.ts";
import { DraftSession } from "../server/state.ts";
import { serve } from "../server/index.ts";
import { probeFastMode, totalSpendUsd, getUsageLog } from "../llm/recommend.ts";

const session = new DraftSession();

const { server, registry } = serve(session);
console.log(`\n  Draft assistant running at http://localhost:${server.port}`);
console.log(`  Home (pick a draft or a mock): http://localhost:${server.port}/`);
console.log(`  Draft room:                    http://localhost:${server.port}/draft`);
if (config.llm.fastMode) {
  console.log(`  FAST_MODE on - Opus fast mode, ~2.5x quicker cards at 2x price.`);
}
console.log(``);

if (!process.env.ANTHROPIC_API_KEY) {
  console.log(`  ! ANTHROPIC_API_KEY is not set - the board will work, cards will not.\n`);
}

// Settle fast mode at boot, not on your first pick. Fired without awaiting:
// a hung probe must not hold up session start (worst case it rides its full
// 30s timeout), and nothing on the boot path reads the verdict - fastModeFor()
// checks the flag at call time, and a real call racing ahead of the probe
// fails fast (maxRetries 0) into the same sticky fallback anyway.
if (config.llm.fastMode && process.env.ANTHROPIC_API_KEY) {
  void probeFastMode().then((probe) => {
    if (probe === "fast") {
      console.log(`  Fast mode confirmed - the probe was served at fast speed.`);
    } else if (probe === "accepted") {
      console.log(
        `  Fast mode accepted - but the probe was served at standard speed. Requests\n` +
          `  run fast when capacity allows and bill at whichever speed serves them.`,
      );
    } else if (probe === "unknown") {
      console.log(`  Fast-mode probe inconclusive - the first real call will settle it.`);
    }
    // "disabled": the [fast-mode] warning already explained why.
  });
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
