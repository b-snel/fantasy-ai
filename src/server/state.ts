/**
 * The live draft loop.
 *
 * Polls Sleeper, recomputes the board, and decides when a recommendation is worth
 * paying for. The engine runs on every poll because it is free; the model is
 * consulted only when its answer could change what you do.
 */

import { config } from "../config.ts";
import {
  getDraft,
  getDraftPicks,
  getLeague,
  getLeagueUsers,
  getPlayers,
  getRosters,
  getTradedPicks,
  getTrending,
  resolveDraft,
} from "../sleeper/client.ts";
import { loadCapabilities } from "../data/capabilities.ts";
import { getProjections, type ProjectionTable } from "../data/projections.ts";
import { getByeWeeks, type ByeWeeks } from "../data/schedule.ts";
import { loadNews } from "../data/news.ts";
import { playerImages } from "../data/photos.ts";
import { computeBoard, type BoardState } from "../engine/board.ts";
import { recommend, shouldCallModel, totalSpendUsd, type CallUsage } from "../llm/recommend.ts";
import { ask, type AskResult } from "../llm/ask.ts";
import { describeScoring } from "../engine/scoring.ts";
import type { ToolContext } from "../tools/index.ts";
import type { Recommendation } from "../llm/schema.ts";
import type {
  Draft,
  DraftPick,
  League,
  LeagueUser,
  PlayersIndex,
  Roster,
  TradedPick,
} from "../sleeper/types.ts";

export interface LiveState {
  status: "starting" | "ready" | "error";
  error: string | null;
  league: { name: string; teams: number; rounds: number; scoring: string } | null;
  draftStatus: string;
  currentPick: number;
  currentRound: number;
  totalPicks: number;
  onTheClockName: string | null;
  isMyTurn: boolean;
  picksUntilMyTurn: number | null;
  myNextPick: number | null;
  myPickAfterNext: number | null;
  pickTimerSeconds: number | null;
  /** Epoch ms of the last pick, for the countdown. */
  lastPickedAt: number | null;
  roster: Array<{ playerId: string; name: string; position: string; team: string | null; byeWeek: number | null }>;
  unfilledSlots: string[];
  candidates: CandidateView[];
  recentPicks: Array<{ pickNo: number; name: string; position: string; team: string | null; mine: boolean }>;
  positionalRun: { position: string; count: number; window: number } | null;
  tierWarnings: Array<{ position: string; tier: number; remaining: number; cliff: number }>;
  effectivelyTied: boolean;
  recommendation: Recommendation | null;
  recommendationStale: boolean;
  lastCallReason: string;
  projectionSource: string;
  spendUsd: number;
  lastUsage: CallUsage | null;
  updatedAt: number;
}

export interface CandidateView {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  byeWeek: number | null;
  projectedPoints: number;
  vorp: number;
  vona: number;
  tier: number;
  tierRemaining: number;
  survival: number;
  adpDelta: number | null;
  score: number;
  reason: string;
  injuryStatus: string | null;
  photo: string;
  photoFallback: string | null;
  initials: string;
}

type Listener = (state: LiveState) => void;

export class DraftSession {
  private league: League | null = null;
  private draft: Draft | null = null;
  private players: PlayersIndex = {};
  private projections: ProjectionTable = new Map();
  private byeWeeks: ByeWeeks = {};
  private rosters: Roster[] = [];
  private users: LeagueUser[] = [];
  private tradedPicks: TradedPick[] = [];
  private picks: DraftPick[] = [];
  private trending = new Map<string, number>();
  private news = new Map<string, string>();

  private recommendation: Recommendation | null = null;
  private lastUsage: CallUsage | null = null;
  private lastTopIds: string[] | null = null;
  private lastCallReason = "not called yet";
  private inFlight = false;
  private stale = false;

  private state: LiveState = emptyState();
  private listeners = new Set<Listener>();
  private timers: ReturnType<typeof setInterval>[] = [];

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  getState(): LiveState {
    return this.state;
  }

  async start(): Promise<void> {
    try {
      await this.loadStaticData();
      await this.pollPicks();
      this.timers.push(setInterval(() => void this.pollPicks(), config.sleeper.pickPollMs));
      this.timers.push(setInterval(() => void this.pollDraft(), config.sleeper.draftPollMs));
      this.timers.push(setInterval(() => void this.pollTrending(), config.sleeper.trendingPollMs));
    } catch (err) {
      this.state = {
        ...this.state,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
      this.emit();
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Force a fresh recommendation regardless of the trigger rules. */
  async refresh(): Promise<void> {
    await this.maybeRecommend(true);
  }

  /**
   * Answer a free-form question with the tool loop.
   *
   * The context is rebuilt per tool call rather than captured once, so a pick that
   * lands mid-question is reflected in the answer instead of silently stale.
   */
  async ask(question: string): Promise<AskResult> {
    if (!this.league || !this.draft) throw new Error("Draft data is still loading.");
    return ask(question, () => this.toolContext());
  }

  private toolContext(): ToolContext {
    const league = this.league!;
    return {
      board: this.currentBoard(),
      leagueName: league.name,
      scoringSummary: describeScoring(league.scoring_settings),
    };
  }

  /** The board as of right now. */
  private currentBoard(): BoardState {
    return computeBoard({
      league: this.league!,
      draft: this.draft!,
      picks: this.picks,
      tradedPicks: this.tradedPicks,
      rosters: this.rosters,
      players: this.players,
      projections: this.projections,
      byeWeeks: this.byeWeeks,
      trending: this.trending,
      news: this.news,
      userId: config.userId,
    });
  }

  private async loadStaticData(): Promise<void> {
    const capabilities = await loadCapabilities();

    const league = await getLeague(config.leagueId);
    if (!league) throw new Error(`Could not load league ${config.leagueId}. Check the id and your network.`);
    this.league = league;

    this.draft = await resolveDraft(league);
    this.players = await getPlayers();
    this.rosters = (await getRosters(config.leagueId)) ?? [];
    this.users = (await getLeagueUsers(config.leagueId)) ?? [];
    this.tradedPicks = (await getTradedPicks(this.draft.draft_id)) ?? [];

    this.projections = await getProjections({
      season: league.season,
      scoring: league.scoring_settings,
      players: this.players,
      capabilities,
    });

    const teams = [...new Set(Object.values(this.players).map((p) => p.team).filter(Boolean))] as string[];
    this.byeWeeks = await getByeWeeks({ season: league.season, teams, capabilities });

    this.news = await loadNews();

    await this.pollTrending();
  }

  private async pollDraft(): Promise<void> {
    if (!this.draft) return;
    const fresh = await getDraft(this.draft.draft_id).catch(() => null);
    if (fresh) this.draft = fresh;
  }

  private async pollTrending(): Promise<void> {
    const rows = await getTrending("add", 24, 100).catch(() => null);
    if (rows) this.trending = new Map(rows.map((r) => [r.player_id, r.count]));
  }

  private async pollPicks(): Promise<void> {
    if (!this.draft || !this.league) return;
    if (this.draft.status === "complete") return;

    const fresh = await getDraftPicks(this.draft.draft_id).catch(() => null);
    if (fresh) this.picks = fresh;

    this.recompute();
    await this.maybeRecommend(false);
  }

  private recompute(): void {
    if (!this.league || !this.draft) return;
    this.state = this.render(this.currentBoard());
    this.emit();
  }

  private async maybeRecommend(manual: boolean): Promise<void> {
    if (!this.league || !this.draft || this.inFlight) return;
    if (this.draft.status === "complete") return;

    const board = this.currentBoard();
    const topIds = board.shortlist.map((p) => p.playerId);
    const decision = shouldCallModel({
      picksUntilMyTurn: board.turn.picksUntilMyTurn,
      topCandidateIds: topIds,
      lastTopCandidateIds: this.lastTopIds,
      manual,
    });

    this.lastCallReason = decision.reason;
    if (!decision.call) {
      this.state = { ...this.render(board), lastCallReason: decision.reason };
      this.emit();
      return;
    }

    this.inFlight = true;
    this.stale = true;
    this.state = { ...this.render(board), recommendationStale: true, lastCallReason: decision.reason };
    this.emit();

    try {
      const result = await recommend({
        prefix: {
          league: this.league,
          teams: board.shape.teams,
          rounds: board.shape.rounds,
          draftType: board.shape.type,
          mySlot: board.mySlot,
        },
        volatile: {
          currentPick: board.turn.currentPick,
          currentRound: board.turn.currentRound,
          picksUntilMyTurn: board.turn.picksUntilMyTurn,
          myNextPick: board.turn.myNextPick,
          myPickAfterNext: board.turn.myPickAfterNext,
          roster: board.roster,
          rosterPlayers: board.myPlayers.map((p) => ({
            name: this.players[p.playerId]?.full_name ?? p.playerId,
            position: p.position,
            team: p.team ?? null,
            byeWeek: p.byeWeek ?? null,
          })),
          candidates: board.shortlist,
          recentPicks: board.recentPicks,
          projectionSource: board.projectionSource,
          effectivelyTied: board.decisiveness.effectivelyTied,
        },
        urgency: decision.urgency,
      });

      this.recommendation = result.recommendation;
      this.lastUsage = result.usage;
      this.lastTopIds = topIds;
    } catch (err) {
      this.lastCallReason = `model call failed: ${err instanceof Error ? err.message : err}`;
    } finally {
      this.inFlight = false;
      this.stale = false;
      this.recompute();
    }
  }

  private render(board: BoardState): LiveState {
    const league = this.league!;
    const draft = this.draft!;

    const onClockRoster = board.turn.onTheClock;
    const onClockUser = this.rosters.find((r) => r.roster_id === onClockRoster)?.owner_id;
    const onClockName =
      this.users.find((u) => u.user_id === onClockUser)?.display_name ??
      (onClockRoster != null ? `Roster ${onClockRoster}` : null);

    return {
      status: "ready",
      error: null,
      league: {
        name: league.name,
        teams: board.shape.teams,
        rounds: board.shape.rounds,
        scoring: board.projectionSource,
      },
      draftStatus: draft.status,
      currentPick: board.turn.currentPick,
      currentRound: board.turn.currentRound,
      totalPicks: board.totalPicks,
      onTheClockName: onClockName,
      isMyTurn: board.turn.isMyTurn,
      picksUntilMyTurn: board.turn.picksUntilMyTurn,
      myNextPick: board.turn.myNextPick,
      myPickAfterNext: board.turn.myPickAfterNext,
      pickTimerSeconds: draft.settings.pick_timer ?? null,
      lastPickedAt: draft.last_picked ?? null,
      roster: board.myPlayers.map((p) => ({
        playerId: p.playerId,
        name: this.players[p.playerId]?.full_name ?? p.playerId,
        position: p.position,
        team: p.team ?? null,
        byeWeek: p.byeWeek ?? null,
      })),
      unfilledSlots: Object.values(board.roster.needs)
        .filter((n) => n.unfilled > 0)
        .sort((a, b) => b.urgency - a.urgency)
        .map((n) => `${n.position}${n.unfilled > 1 ? ` x${n.unfilled}` : ""}`),
      candidates: board.shortlist.map((c) => this.toCandidateView(c)),
      recentPicks: board.recentPicks.map((p) => ({
        ...p,
        mine: this.picks.find((x) => x.pick_no === p.pickNo)?.roster_id === board.myRosterId,
      })),
      positionalRun: board.positionalRun,
      tierWarnings: board.tierWarnings,
      effectivelyTied: board.decisiveness.effectivelyTied,
      recommendation: this.recommendation,
      recommendationStale: this.stale,
      lastCallReason: this.lastCallReason,
      projectionSource: board.projectionSource,
      spendUsd: totalSpendUsd(),
      lastUsage: this.lastUsage,
      updatedAt: Date.now(),
    };
  }

  private toCandidateView(c: BoardState["shortlist"][number]): CandidateView {
    const player = this.players[c.playerId];
    const images = playerImages(
      player ?? {
        player_id: c.playerId,
        espn_id: null,
        first_name: null,
        last_name: null,
        full_name: c.name,
        position: c.position,
      },
    );
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
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }
}

function emptyState(): LiveState {
  return {
    status: "starting",
    error: null,
    league: null,
    draftStatus: "unknown",
    currentPick: 0,
    currentRound: 0,
    totalPicks: 0,
    onTheClockName: null,
    isMyTurn: false,
    picksUntilMyTurn: null,
    myNextPick: null,
    myPickAfterNext: null,
    pickTimerSeconds: null,
    lastPickedAt: null,
    roster: [],
    unfilledSlots: [],
    candidates: [],
    recentPicks: [],
    positionalRun: null,
    tierWarnings: [],
    effectivelyTied: false,
    recommendation: null,
    recommendationStale: false,
    lastCallReason: "starting up",
    projectionSource: "unknown",
    spendUsd: 0,
    lastUsage: null,
    updatedAt: Date.now(),
  };
}
