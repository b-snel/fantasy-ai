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
import { rosterOfMadePick } from "../engine/snake.ts";
import {
  cacheWarning,
  recommend,
  shouldCallModel,
  totalSpendUsd,
  type CallUsage,
  type Urgency,
} from "../llm/recommend.ts";
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
  /** Which draft this session follows, and whether it is a mock. */
  draftId: string | null;
  isMock: boolean;
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
  /** The pick the recommendation was computed for - lets the UI show freshness. */
  recommendationForPick: number | null;
  recommendationStale: boolean;
  lastCallReason: string;
  projectionSource: string;
  spendUsd: number;
  lastUsage: CallUsage | null;
  /** Non-null when the prompt-cache prefix looks like it is silently drifting. */
  cacheWarning: string | null;
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

/** How long to sit out after a failed model call before automatic retries resume. */
const FAILURE_COOLDOWN_MS = 15_000;

export class DraftSession {
  private league: League | null = null;
  private draft: Draft | null = null;
  /** Explicit draft to follow (a mock, or SLEEPER_DRAFT_ID); null = the league's. */
  private draftIdOverride: string | null = config.draftId;
  /**
   * Bumped on every switchTo. Async callbacks capture the epoch they started
   * under and drop their results if a switch happened while they were in flight
   * - otherwise a slow fetch for the old draft could clobber the new one.
   */
  private epoch = 0;
  private players: PlayersIndex = {};
  private projections: ProjectionTable = new Map();
  private byeWeeks: ByeWeeks = {};
  private rosters: Roster[] = [];
  private users: LeagueUser[] = [];
  private tradedPicks: TradedPick[] = [];
  private picks: DraftPick[] = [];
  private trending = new Map<string, number>();
  private news = new Map<string, string>();

  /** Monotonic pick-poll counter; stale overlapping fetches lose the write. */
  private pollSeq = 0;

  private recommendation: Recommendation | null = null;
  private recommendationForPick: number | null = null;
  private lastUsage: CallUsage | null = null;
  private lastTopIds: string[] | null = null;
  private lastCallReason = "not called yet";
  private lastFailureAt = 0;
  /** Urgency of the call in flight, or null. On-clock supersedes background. */
  private inFlightUrgency: Urgency | null = null;
  /** Monotonic call counter; a superseded call's result loses the write. */
  private callSeq = 0;
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
    await this.boot(++this.epoch);
  }

  /** The draft this session is following right now. */
  currentDraftId(): string | null {
    return this.draft?.draft_id ?? this.draftIdOverride;
  }

  /**
   * Point the session at a different draft - a mock from the home page, or back
   * to the league's own. Subscribers stay connected; they simply start receiving
   * the new draft's states.
   */
  async switchTo(draftId: string): Promise<void> {
    if (draftId === this.currentDraftId() && this.state.status === "ready") return;
    const epoch = ++this.epoch; // strands every in-flight callback for the old draft
    this.stop();
    this.draftIdOverride = draftId;
    this.draft = null;
    this.picks = [];
    this.tradedPicks = [];
    this.recommendation = null;
    this.recommendationForPick = null;
    this.lastTopIds = null;
    this.lastUsage = null;
    this.lastFailureAt = 0;
    // Strand any in-flight recommendation: its finally must not clear the new
    // session's flags, and the new session must not start blocked by it.
    this.callSeq++;
    this.inFlightUrgency = null;
    this.stale = false;
    this.state = emptyState();
    this.emit();
    await this.boot(epoch);
  }

  private async boot(epoch: number): Promise<void> {
    try {
      await this.loadStaticData(epoch);
      if (epoch !== this.epoch) return;
      await this.pollPicks();
      if (epoch !== this.epoch) return;
      this.timers.push(setInterval(() => void this.pollPicks(), config.sleeper.pickPollMs));
      this.timers.push(setInterval(() => void this.pollDraft(), config.sleeper.draftPollMs));
      this.timers.push(setInterval(() => void this.pollTrending(), config.sleeper.trendingPollMs));
    } catch (err) {
      if (epoch !== this.epoch) return;
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
    const epoch = this.epoch;
    try {
      return await ask(question, () => this.toolContext());
    } finally {
      // Spend and cache health moved; reflect them in the snapshot immediately
      // rather than waiting for the next poll. Epoch-guarded: if the session
      // switched drafts while the answer was in flight, rendering here would
      // stamp a half-booted session "ready" before its first pick fetch.
      if (epoch === this.epoch) this.recompute();
    }
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

  private async loadStaticData(epoch: number): Promise<void> {
    const capabilities = await loadCapabilities();

    const league = await getLeague(config.leagueId);
    if (!league) throw new Error(`Could not load league ${config.leagueId}. Check the id and your network.`);
    if (epoch !== this.epoch) return;
    this.league = league;

    if (this.draftIdOverride) {
      const draft = await getDraft(this.draftIdOverride);
      if (!draft) throw new Error(`Draft ${this.draftIdOverride} could not be loaded from Sleeper.`);
      if (epoch !== this.epoch) return;
      this.draft = draft;
    } else {
      const draft = await resolveDraft(league);
      if (epoch !== this.epoch) return;
      this.draft = draft;
    }
    this.players = await getPlayers();
    if (epoch !== this.epoch) return;
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
    const epoch = this.epoch;
    const fresh = await getDraft(this.draft.draft_id).catch(() => null);
    if (epoch !== this.epoch) return;
    if (fresh) this.draft = fresh;
  }

  private async pollTrending(): Promise<void> {
    const rows = await getTrending("add", 24, 100).catch(() => null);
    if (rows) this.trending = new Map(rows.map((r) => [r.player_id, r.count]));
  }

  private async pollPicks(): Promise<void> {
    if (!this.draft || !this.league) return;
    // A complete draft keeps polling on the normal path, deliberately. An
    // earlier "poll once then go quiet" optimization froze the live completion
    // transition on a pre-completion snapshot (pollDraft flips the status
    // without recomputing) and could permanently drop final picks fetched
    // during a transient blip. Polling a finished draft costs one localhost
    // fetch per tick and guarantees the every-poll snapshot pulse the client's
    // stall watchdog is built on. Only the model is gated off below.
    const done = this.draft.status === "complete";

    const epoch = this.epoch;
    const seq = ++this.pollSeq;
    const fresh = await getDraftPicks(this.draft.draft_id).catch(() => null);
    if (epoch !== this.epoch) return;
    // Overlapping polls can resolve out of order when Sleeper is slow; only the
    // most recently launched fetch may write, so the board never rolls back.
    if (fresh && seq === this.pollSeq) this.picks = fresh;

    this.recompute();
    if (!done) await this.maybeRecommend(false);
  }

  private recompute(): void {
    if (!this.league || !this.draft) return;
    this.state = this.render(this.currentBoard());
    this.emit();
  }

  private async maybeRecommend(manual: boolean): Promise<void> {
    if (!this.league || !this.draft) return;
    if (this.draft.status === "complete") return;

    const board = this.currentBoard();
    const topIds = board.shortlist.map((p) => p.playerId);
    const decision = shouldCallModel({
      picksUntilMyTurn: board.turn.picksUntilMyTurn,
      topCandidateIds: topIds,
      lastTopCandidateIds: this.lastTopIds,
      manual,
    });

    // An in-flight call only blocks peers of equal or lower urgency. A
    // background Haiku refresh must never gate the on-clock call: in a fast
    // mock, six CPU picks can land while it is mid-answer, and queueing the
    // pick that matters behind an answer for a dead board spends your clock on
    // nothing. The stranded call still completes and bills; the callSeq guard
    // below discards its result. Manual refresh counts as on-clock urgency, so
    // Refresh genuinely forces a new call unless one is already running hot.
    if (this.inFlightUrgency !== null) {
      const supersedes =
        decision.call && decision.urgency === "on_clock" && this.inFlightUrgency === "background";
      if (!supersedes) {
        // Say why a manual refresh appeared to do nothing.
        if (manual) this.lastCallReason = "already thinking - the in-flight answer lands first";
        return;
      }
    }

    // Back off after a failed call instead of retrying on every 2-second poll.
    // This has to sit here rather than in the board fingerprint: the on-clock
    // branch of shouldCallModel fires unconditionally, so a persistent error
    // (revoked key, bad params) inside three picks of your turn would otherwise
    // storm the expensive model for the whole pick timer. A cooldown also keeps
    // transient blips (429/529/network) self-healing - the next poll after it
    // lapses retries even on an unchanged board. Manual refresh always goes
    // through: a human clicking the button IS the retry.
    const sinceFailure = Date.now() - this.lastFailureAt;
    if (decision.call && !manual && sinceFailure < FAILURE_COOLDOWN_MS) {
      const wait = Math.ceil((FAILURE_COOLDOWN_MS - sinceFailure) / 1000);
      this.lastCallReason = `last call failed - retrying in ~${wait}s`;
      this.state = this.render(board);
      this.emit();
      return;
    }

    this.lastCallReason = decision.reason;
    if (!decision.call) {
      this.state = { ...this.render(board), lastCallReason: decision.reason };
      this.emit();
      return;
    }

    const seq = ++this.callSeq; // strands any superseded call's result
    this.inFlightUrgency = decision.urgency;
    this.stale = true;
    this.state = { ...this.render(board), recommendationStale: true, lastCallReason: decision.reason };
    this.emit();

    const epoch = this.epoch;
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

      // The session may have switched drafts while the model was thinking, or a
      // hotter call may have superseded this one; a recommendation for a dead
      // board must not land on the live one.
      if (epoch !== this.epoch || seq !== this.callSeq) return;
      this.recommendation = result.recommendation;
      this.recommendationForPick = board.turn.currentPick;
      // An in-process cache hit carries an all-zero usage block; overwriting the
      // last real call's numbers with it would blank the cost display mid-draft.
      // Say where the answer came from so the stale-looking numbers make sense.
      if (!result.cached) this.lastUsage = result.usage;
      else this.lastCallReason = `${decision.reason} - served from local cache, no API call`;
      this.lastTopIds = topIds;
      this.lastFailureAt = 0;
    } catch (err) {
      // A superseded or switched-away call's failure is nobody's news: the
      // newer call owns the status line and the cooldown clock.
      if (epoch !== this.epoch || seq !== this.callSeq) return;
      this.lastCallReason = `model call failed: ${err instanceof Error ? err.message : err}`;
      this.lastFailureAt = Date.now();
    } finally {
      // Only the call that still owns the flags may clear them - a superseded
      // call finishing late must not mark the superseding call's work done.
      if (seq === this.callSeq) {
        this.inFlightUrgency = null;
        this.stale = false;
        // Same epoch guard as ask(): never render across a draft switch.
        if (epoch === this.epoch) this.recompute();
      }
    }
  }

  private render(board: BoardState): LiveState {
    const league = this.league!;
    const draft = this.draft!;

    const onClockRoster = board.turn.onTheClock;
    const onClockUser = this.rosters.find((r) => r.roster_id === onClockRoster)?.owner_id;
    // In a mock draft the roster ids belong to the mock, not the league, so the
    // league-roster name join is wrong for everyone - but "You" is always right.
    const onClockName =
      onClockRoster != null && onClockRoster === board.myRosterId
        ? "You"
        : this.users.find((u) => u.user_id === onClockUser)?.display_name ??
          (onClockRoster != null ? `Roster ${onClockRoster}` : null);

    return {
      status: "ready",
      error: null,
      draftId: draft.draft_id,
      isMock: draft.league_id == null,
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
      recentPicks: board.recentPicks.map((p) => {
        // Mock-draft picks carry roster_id null; resolve through the slot map.
        const made = this.picks.find((x) => x.pick_no === p.pickNo);
        return {
          ...p,
          mine: made != null && rosterOfMadePick(made, board.shape) === board.myRosterId,
        };
      }),
      positionalRun: board.positionalRun,
      tierWarnings: board.tierWarnings,
      effectivelyTied: board.decisiveness.effectivelyTied,
      recommendation: this.recommendation,
      recommendationForPick: this.recommendationForPick,
      recommendationStale: this.stale,
      lastCallReason: this.lastCallReason,
      projectionSource: board.projectionSource,
      spendUsd: totalSpendUsd(),
      lastUsage: this.lastUsage,
      cacheWarning: cacheWarning(),
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
    draftId: null,
    isMock: false,
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
    recommendationForPick: null,
    recommendationStale: false,
    lastCallReason: "starting up",
    projectionSource: "unknown",
    spendUsd: 0,
    lastUsage: null,
    cacheWarning: null,
    updatedAt: Date.now(),
  };
}
