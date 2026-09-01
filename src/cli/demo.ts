/**
 * `bun run demo` - serve the real UI against fixture data.
 *
 * No Sleeper, no API key, no draft required. This exists because the UI is the one
 * part of the system that unit tests cannot judge, and because the environment this
 * was built in cannot reach Sleeper at all. It drives the same server and the same
 * renderer as draft day, with a scripted board underneath.
 *
 *   bun run demo             hold at a mid-draft state
 *   bun run demo --advance   step a pick every few seconds, to watch it update
 */

import { fixtureDraft, fixtureLeague, makeFixtureByes, makeFixturePlayers } from "../../fixtures/index.ts";
import { projectionsFromSearchRank } from "../data/projections.ts";
import { playerImages } from "../data/photos.ts";
import { computeBoard } from "../engine/board.ts";
import { buildDraftShape, rosterOfPick } from "../engine/snake.ts";
import { config } from "../config.ts";
import { createServer, SubscriberRegistry } from "../server/index.ts";
import type { DraftSession, LiveState } from "../server/state.ts";
import type { Draft, DraftPick, Roster } from "../sleeper/types.ts";
import type { Recommendation } from "../llm/schema.ts";

const ADVANCE = process.argv.includes("--advance");
const START_AT_PICK = Number(process.env.DEMO_PICK ?? 30);

const players = makeFixturePlayers();
const byeWeeks = makeFixtureByes();
const projections = projectionsFromSearchRank(players, fixtureLeague.scoring_settings);
const draft: Draft = { ...fixtureDraft, status: "drafting", last_picked: Date.now() - 25_000 };
const shape = buildDraftShape(draft, []);

const rosters: Roster[] = Array.from({ length: shape.teams }, (_, i) => ({
  roster_id: i + 1,
  owner_id: i + 1 === 7 ? config.userId : `u${i + 1}`,
  league_id: fixtureLeague.league_id,
  players: [],
  starters: [],
}));

const users = rosters.map((r, i) => ({
  user_id: String(r.owner_id),
  display_name: i + 1 === 7 ? "Tugger_Woods" : `Manager ${i + 1}`,
}));

/** Deterministic filler picks up to the starting point. */
const picks: DraftPick[] = [];
const adpOrder = [...projections.values()]
  .filter((p) => p.adp != null)
  .sort((a, b) => (a.adp ?? 0) - (b.adp ?? 0))
  .map((p) => p.playerId);

function advanceOnePick(): void {
  const pickNo = picks.length + 1;
  if (pickNo > shape.teams * shape.rounds) return;
  const drafted = new Set(picks.map((p) => p.player_id));
  const chosen = adpOrder.find((id) => !drafted.has(id));
  if (!chosen) return;
  const player = players[chosen];
  picks.push({
    draft_id: draft.draft_id,
    pick_no: pickNo,
    round: Math.ceil(pickNo / shape.teams),
    draft_slot: ((pickNo - 1) % shape.teams) + 1,
    roster_id: rosterOfPick(pickNo, shape) ?? 0,
    player_id: chosen,
    metadata: {
      first_name: player?.first_name ?? undefined,
      last_name: player?.last_name ?? undefined,
      position: player?.position ?? undefined,
      team: player?.team ?? undefined,
    },
  });
}

for (let i = 0; i < START_AT_PICK; i++) advanceOnePick();

/** A canned recommendation so the cards render without an API key. */
function fakeRecommendation(shortlist: ReturnType<typeof computeBoard>["shortlist"]): Recommendation | null {
  const top = shortlist.slice(0, 4);
  if (!top.length) return null;
  return {
    board_read: `Receivers are going fast — four of the last six picks. Tier 2 running backs are down to two.`,
    top_pick_player_id: top[0]!.playerId,
    cards: top.map((c, i) => ({
      player_id: c.playerId,
      name: c.name,
      verdict:
        i === 0
          ? `Best value on the board and he will not last to your next pick.`
          : `Solid fallback if ${top[0]!.name} goes before you pick.`,
      rationale: [
        `${Math.round(c.vona)} points of value over the next ${c.position} you would get at your following pick.`,
        `Only ${c.tierRemaining} left in ${c.position} tier ${c.tier}.`,
        `${Math.round(c.survival * 100)}% chance he lasts to pick ${shortlist[0]?.playerId ? "your next" : "later"}.`,
      ],
      risk:
        c.injuryStatus
          ? `Carrying a ${c.injuryStatus.toLowerCase()} designation.`
          : `Projection leans on a target share he has not held for a full season.`,
      confidence: (i === 0 ? "high" : i === 1 ? "medium" : "low") as "high" | "medium" | "low",
    })),
  };
}

function buildState(): LiveState {
  const board = computeBoard({
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

  const onClockRoster = board.turn.onTheClock;
  const onClockOwner = rosters.find((r) => r.roster_id === onClockRoster)?.owner_id;

  return {
    status: "ready",
    error: null,
    league: {
      name: fixtureLeague.name,
      teams: shape.teams,
      rounds: shape.rounds,
      scoring: board.projectionSource,
    },
    draftStatus: draft.status,
    currentPick: board.turn.currentPick,
    currentRound: board.turn.currentRound,
    totalPicks: board.totalPicks,
    onTheClockName: users.find((u) => u.user_id === String(onClockOwner))?.display_name ?? null,
    isMyTurn: board.turn.isMyTurn,
    picksUntilMyTurn: board.turn.picksUntilMyTurn,
    myNextPick: board.turn.myNextPick,
    myPickAfterNext: board.turn.myPickAfterNext,
    pickTimerSeconds: draft.settings.pick_timer ?? null,
    lastPickedAt: draft.last_picked ?? null,
    roster: board.myPlayers.map((p) => ({
      playerId: p.playerId,
      name: players[p.playerId]?.full_name ?? p.playerId,
      position: p.position,
      team: p.team ?? null,
      byeWeek: p.byeWeek ?? null,
    })),
    unfilledSlots: Object.values(board.roster.needs)
      .filter((n) => n.unfilled > 0)
      .sort((a, b) => b.urgency - a.urgency)
      .map((n) => `${n.position}${n.unfilled > 1 ? ` x${n.unfilled}` : ""}`),
    candidates: board.shortlist.map((c) => {
      const images = playerImages(players[c.playerId]!);
      return {
        playerId: c.playerId,
        name: c.name,
        position: c.position,
        team: c.team,
        byeWeek: c.byeWeek,
        projectedPoints: c.projectedPoints,
        vorp: c.vorp,
        vona: c.vona,
        tier: c.tier,
        tierRemaining: c.tierRemaining,
        survival: c.survival,
        adpDelta: c.adpDelta,
        score: c.score,
        reason: c.reason,
        injuryStatus: c.injuryStatus,
        photo: images.primary,
        photoFallback: images.fallback,
        initials: images.initials,
      };
    }),
    recentPicks: board.recentPicks.map((p) => ({
      ...p,
      mine: picks.find((x) => x.pick_no === p.pickNo)?.roster_id === board.myRosterId,
    })),
    positionalRun: board.positionalRun,
    tierWarnings: board.tierWarnings,
    effectivelyTied: board.decisiveness.effectivelyTied,
    recommendation: fakeRecommendation(board.shortlist),
    recommendationStale: false,
    lastCallReason: "demo mode - canned recommendation, no API call",
    projectionSource: board.projectionSource,
    spendUsd: 0.0312,
    lastUsage: {
      model: "claude-opus-5",
      inputTokens: 1180,
      cacheReadTokens: 4960,
      cacheWriteTokens: 0,
      outputTokens: 870,
      estimatedCostUsd: 0.0312,
      latencyMs: 2140,
    },
    updatedAt: Date.now(),
  };
}

const listeners = new Set<(s: LiveState) => void>();

const session = {
  getState: () => buildState(),
  subscribe: (fn: (s: LiveState) => void) => {
    listeners.add(fn);
    fn(buildState());
    return () => listeners.delete(fn);
  },
  refresh: async () => {
    for (const fn of listeners) fn(buildState());
  },
} as unknown as DraftSession;

const registry = new SubscriberRegistry();
const app = createServer(session, registry);
const server = Bun.serve({ port: config.port, fetch: app.fetch });

console.log(`\n  Demo UI at http://localhost:${server.port}`);
console.log(`  Fixture data, canned recommendation, no API key needed.`);
console.log(`  Pick ${picks.length + 1} of ${shape.teams * shape.rounds}.\n`);

if (ADVANCE) {
  setInterval(() => {
    advanceOnePick();
    draft.last_picked = Date.now();
    for (const fn of listeners) fn(buildState());
  }, 4000);
  console.log(`  Advancing a pick every 4s.\n`);
}
