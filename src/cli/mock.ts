/**
 * `bun run mock` - replay a simulated snake draft through the full pipeline.
 *
 * This is the only way to exercise the whole system without a live draft, and it is
 * how the pipeline was verified in an environment with no access to Sleeper at all.
 * Every other manager drafts by a simple ADP-with-noise heuristic; at each of your
 * picks the real engine runs and prints the shortlist it would send to the model.
 *
 *   bun run mock              simulate a full draft, print your picks
 *   bun run mock --verbose    also print the board at every one of your turns
 *   bun run mock --llm        additionally call the model at your first three picks
 */

import { fixtureDraft, fixtureLeague, makeFixtureByes, makeFixturePlayers } from "../../fixtures/index.ts";
import { computeBoard } from "../engine/board.ts";
import { projectionsFromSearchRank } from "../data/projections.ts";
import { buildDraftShape, rosterOfPick } from "../engine/snake.ts";
import { config } from "../config.ts";
import type { Draft, DraftPick, Roster } from "../sleeper/types.ts";
import { recommend, totalSpendUsd } from "../llm/recommend.ts";
import { buildVolatileTail } from "../llm/prompt.ts";

const VERBOSE = process.argv.includes("--verbose");
const USE_LLM = process.argv.includes("--llm");

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Deterministic RNG so a mock run is reproducible and diffable. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main(): Promise<void> {
  const players = makeFixturePlayers();
  const byeWeeks = makeFixtureByes();
  const projections = projectionsFromSearchRank(players, fixtureLeague.scoring_settings);

  const draft: Draft = { ...fixtureDraft, status: "drafting" };
  const shape = buildDraftShape(draft, []);
  const totalPicks = shape.teams * shape.rounds;

  const rosters: Roster[] = Array.from({ length: shape.teams }, (_, i) => ({
    roster_id: i + 1,
    owner_id: i + 1 === 7 ? config.userId : `u${i + 1}`,
    league_id: fixtureLeague.league_id,
    players: [],
    starters: [],
  }));

  const picks: DraftPick[] = [];
  const rand = mulberry32(424242);

  // Other managers pick near ADP with noise, which produces realistic runs and the
  // occasional faller - exactly the conditions the engine needs to be tested under.
  const adpOrder = [...projections.values()]
    .filter((p) => p.adp != null)
    .sort((a, b) => (a.adp ?? 0) - (b.adp ?? 0))
    .map((p) => p.playerId);

  console.log(`\n${BOLD}Mock draft${RESET} ${DIM}${shape.teams} teams, ${shape.rounds} rounds, you are slot 7 (roster 7)${RESET}\n`);

  let llmCalls = 0;

  for (let pickNo = 1; pickNo <= totalPicks; pickNo++) {
    const roster = rosterOfPick(pickNo, shape);
    const state = computeBoard({
      league: fixtureLeague,
      draft,
      picks,
      tradedPicks: [],
      rosters,
      players,
      projections,
      byeWeeks,
      trending: new Map(),
      news: new Map(),
      userId: config.userId,
    });

    if (roster != null && roster === state.myRosterId) {
      printMyTurn(state, pickNo);

      if (USE_LLM && llmCalls < 3) {
        llmCalls++;
        await callModel(state, pickNo);
      }

      // In the simulation, take the engine's top recommendation.
      const choice = state.shortlist[0];
      if (!choice) break;
      picks.push(makePick(draft, pickNo, roster, choice.playerId, players, shape.teams));
      console.log(`  ${GREEN}-> drafted ${choice.name} (${choice.position})${RESET}\n`);
      continue;
    }

    // Everyone else: best available near ADP, with noise.
    const drafted = new Set(picks.map((p) => p.player_id));
    const candidates = adpOrder.filter((id) => !drafted.has(id)).slice(0, 8);
    const choice = candidates[Math.floor(rand() * Math.min(4, candidates.length))] ?? candidates[0];
    if (!choice) break;
    picks.push(makePick(draft, pickNo, roster ?? 0, choice, players, shape.teams));
  }

  console.log(`${BOLD}Final roster${RESET}`);
  const final = computeBoard({
    league: fixtureLeague,
    draft,
    picks,
    tradedPicks: [],
    rosters,
    players,
    projections,
    byeWeeks,
    trending: new Map(),
    news: new Map(),
    userId: config.userId,
  });
  for (const p of final.myPlayers) {
    console.log(`  ${p.position.padEnd(4)} ${p.playerId.padEnd(8)} ${p.team ?? ""} ${DIM}bye ${p.byeWeek ?? "-"}${RESET}`);
  }
  const counts = Object.entries(final.roster.countsByPosition)
    .filter(([, n]) => n > 0)
    .map(([pos, n]) => `${pos}${n}`)
    .join(" ");
  console.log(`\n  ${counts}`);
  console.log(`  ${DIM}${picks.length} total picks simulated${RESET}`);
  if (USE_LLM) console.log(`  ${DIM}model spend: $${totalSpendUsd().toFixed(4)}${RESET}`);
  console.log();
}

function printMyTurn(state: ReturnType<typeof computeBoard>, pickNo: number): void {
  const round = Math.ceil(pickNo / state.shape.teams);
  console.log(
    `${BOLD}${CYAN}Pick ${pickNo}${RESET} ${DIM}(round ${round})${RESET}` +
      (state.turn.myPickAfterNext ? ` ${DIM}next at ${state.turn.myPickAfterNext}${RESET}` : ""),
  );

  if (state.positionalRun) {
    const r = state.positionalRun;
    console.log(`  ${YELLOW}run:${RESET} ${r.count} of the last ${r.window} picks were ${r.position}`);
  }
  for (const w of state.tierWarnings) {
    console.log(
      `  ${YELLOW}tier:${RESET} only ${w.remaining} left in ${w.position} tier ${w.tier}` +
        ` ${DIM}(${w.cliff.toFixed(0)}-pt drop after)${RESET}`,
    );
  }

  const header = "  name           pos  proj  vorp  vona  tier  left  surv  adpD  score  flag";
  console.log(DIM + header + RESET);
  for (const c of state.shortlist.slice(0, VERBOSE ? 12 : 6)) {
    console.log(
      "  " +
        c.name.padEnd(14).slice(0, 14) +
        " " +
        c.position.padEnd(4) +
        " " +
        c.projectedPoints.toFixed(0).padStart(5) +
        " " +
        c.vorp.toFixed(0).padStart(5) +
        " " +
        c.vona.toFixed(0).padStart(5) +
        " " +
        String(c.tier).padStart(5) +
        " " +
        String(c.tierRemaining).padStart(5) +
        " " +
        c.survival.toFixed(2).padStart(5) +
        " " +
        (c.adpDelta == null ? "    -" : c.adpDelta.toFixed(0).padStart(5)) +
        " " +
        c.score.toFixed(0).padStart(6) +
        "  " +
        DIM +
        c.reason +
        RESET,
    );
  }
}

async function callModel(state: ReturnType<typeof computeBoard>, pickNo: number): Promise<void> {
  const vol = {
    currentPick: pickNo,
    currentRound: Math.ceil(pickNo / state.shape.teams),
    picksUntilMyTurn: 0,
    myNextPick: pickNo,
    myPickAfterNext: state.turn.myPickAfterNext,
    roster: state.roster,
    rosterPlayers: state.myPlayers.map((p) => ({
      name: p.playerId,
      position: p.position,
      team: p.team ?? null,
      byeWeek: p.byeWeek ?? null,
    })),
    candidates: state.shortlist,
    recentPicks: state.recentPicks,
    projectionSource: state.projectionSource,
  };

  if (process.argv.includes("--dry")) {
    console.log(`\n${DIM}--- volatile tail (${buildVolatileTail(vol).length} chars) ---${RESET}`);
    console.log(buildVolatileTail(vol));
    return;
  }

  try {
    const { recommendation, usage, cached } = await recommend({
      prefix: {
        league: fixtureLeague,
        teams: state.shape.teams,
        rounds: state.shape.rounds,
        draftType: state.shape.type,
        mySlot: state.mySlot,
      },
      volatile: vol,
      urgency: "on_clock",
    });

    console.log(`\n  ${BOLD}${recommendation.board_read}${RESET}`);
    for (const card of recommendation.cards) {
      const star = card.player_id === recommendation.top_pick_player_id ? `${GREEN}*${RESET}` : " ";
      console.log(`  ${star} ${BOLD}${card.name}${RESET} - ${card.verdict}`);
      for (const line of card.rationale) console.log(`      ${DIM}- ${line}${RESET}`);
      console.log(`      ${YELLOW}risk:${RESET} ${card.risk} ${DIM}(${card.confidence})${RESET}`);
    }
    console.log(
      `  ${DIM}${cached ? "cached" : `${usage.model} · ${usage.cacheReadTokens} cache-read · ` +
        `${usage.inputTokens} fresh · ${usage.outputTokens} out · ` +
        `$${usage.estimatedCostUsd.toFixed(4)} · ${usage.latencyMs}ms`}${RESET}\n`,
    );
  } catch (err) {
    console.log(`  ${YELLOW}model call failed:${RESET} ${err instanceof Error ? err.message : err}\n`);
  }
}

function makePick(
  draft: Draft,
  pickNo: number,
  rosterId: number,
  playerId: string,
  players: ReturnType<typeof makeFixturePlayers>,
  teams: number,
): DraftPick {
  const player = players[playerId];
  return {
    draft_id: draft.draft_id,
    pick_no: pickNo,
    round: Math.ceil(pickNo / teams),
    draft_slot: ((pickNo - 1) % teams) + 1,
    roster_id: rosterId,
    player_id: playerId,
    picked_by: null,
    is_keeper: null,
    metadata: {
      first_name: player?.first_name ?? undefined,
      last_name: player?.last_name ?? undefined,
      position: player?.position ?? undefined,
      team: player?.team ?? undefined,
    },
  };
}

main().catch((err) => {
  console.error("mock failed:", err);
  process.exit(1);
});
