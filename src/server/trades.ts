/**
 * The trade analyzer behind the HTTP surface.
 *
 * Independent of the draft session on purpose: it needs the league's current
 * rosters and rest-of-season projections, not a draft, and it should work the same
 * whether a draft is being followed or not. Data loads lazily on first use - it
 * costs nothing on draft-day boot - and rosters refresh on their own when they are
 * older than a minute, because waivers and other trades move them under you.
 */

import { config } from "../config.ts";
import {
  getLeague,
  getLeagueUsers,
  getNflState,
  getPlayers,
  getRosters,
} from "../sleeper/client.ts";
import { loadCapabilities } from "../data/capabilities.ts";
import { getProjections } from "../data/projections.ts";
import { getByeWeeks } from "../data/schedule.ts";
import { easternDate, getRosProjections, rosWindow, type RosSource } from "../data/ros.ts";
import { playerImages } from "../data/photos.ts";
import { describeScoring } from "../engine/scoring.ts";
import { buildUniverse, type TeamRoster, type TradeUniverse } from "../trade/value.ts";
import {
  evaluateTrade,
  findTrades,
  tradeKey,
  TradeQueryError,
  type TradeEval,
  type TradeSort,
} from "../trade/search.ts";
import { explainTrade, profileLeague, rankedPositions, type TeamProfile } from "../trade/explain.ts";
import { buildBriefing } from "../trade/briefing.ts";
import {
  claudeReviewer,
  type ReviewEngine,
  type ReviewSource,
  type ReviewStep,
  type TradeReviewer,
  type TradeVerdict,
} from "../llm/trade-review.ts";
import type { League, LeagueUser, PlayersIndex, Roster } from "../sleeper/types.ts";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export interface TradeData {
  league: League;
  players: PlayersIndex;
  rosters: Roster[];
  users: LeagueUser[];
  weekly: Map<string, number[]>;
  weeks: number[];
  byeWeek: Map<string, number>;
  played: Set<string>;
  /** The NFL week right now. */
  nflWeek: number;
  source: RosSource;
  userId: string;
}

export interface TradeDataSource {
  /** Everything. `force` refetches projections too. */
  load(force?: boolean): Promise<TradeData>;
  /** Just the parts that change between waiver runs. */
  rosters(): Promise<{ rosters: Roster[]; users: LeagueUser[] }>;
}

/** The live league from Sleeper. */
export function liveTradeSource(): TradeDataSource {
  return {
    async load(force = false) {
      const [league, state] = await Promise.all([getLeague(config.leagueId), getNflState()]);
      if (!league) throw new Error(`Could not load league ${config.leagueId}.`);
      if (!state) throw new Error("Could not read the NFL calendar from Sleeper.");
      const window = rosWindow(state, league);
      if (!window) throw new Error("The fantasy season is over - there is nothing left to trade for.");

      const players = await getPlayers();
      const [rosters, users] = await Promise.all([
        getRosters(config.leagueId),
        getLeagueUsers(config.leagueId),
      ]);
      const ros = await getRosProjections({
        season: league.season,
        from: window.from,
        to: window.to,
        scoring: league.scoring_settings,
        players,
        force,
        fallback: async () => {
          const capabilities = await loadCapabilities();
          const season = await getProjections({
            season: league.season,
            scoring: league.scoring_settings,
            players,
            capabilities,
          });
          const teams = [...new Set(Object.values(players).map((p) => p.team).filter(Boolean))] as string[];
          const byes = await getByeWeeks({ season: league.season, teams, capabilities });
          return { season, byes };
        },
      });

      return {
        league,
        players,
        rosters: rosters ?? [],
        users: users ?? [],
        weekly: ros.weekly,
        weeks: ros.weeks,
        byeWeek: ros.byeWeek,
        played: ros.played,
        nflWeek: state.week,
        source: ros.source,
        userId: config.userId,
      };
    },
    async rosters() {
      const [rosters, users] = await Promise.all([
        getRosters(config.leagueId),
        getLeagueUsers(config.leagueId),
      ]);
      if (!rosters) throw new Error("Could not refresh rosters from Sleeper.");
      return { rosters, users: users ?? [] };
    },
  };
}

// ---------------------------------------------------------------------------
// Views - what the browser gets
// ---------------------------------------------------------------------------

export interface PlayerView {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  injuryStatus: string | null;
  reserve: boolean;
  /** Rest-of-season projected points per week. */
  perWeek: number;
  rosTotal: number;
  marketValue: number;
  /** Fraction of the window this player starts for his current team. */
  startShare: number;
  weekly: number[];
  photo: string;
  photoFallback: string | null;
  initials: string;
}

export interface TeamView {
  rosterId: number;
  manager: string;
  teamName: string;
  avatar: string | null;
  isMe: boolean;
  record: string;
  wins: number;
  losses: number;
  pointsFor: number;
  perWeek: number;
  rank: number;
  positions: TeamProfile["positions"];
  needs: string[];
  surplus: string[];
  players: PlayerView[];
}

export interface TradeOverview {
  league: {
    name: string;
    season: string;
    scoring: string;
    nflWeek: number;
    weeks: number[];
    tradeDeadline: number | null;
    deadlinePassed: boolean;
    teams: number;
  };
  positions: string[];
  source: RosSource;
  me: number;
  teams: TeamView[];
  updatedAt: number;
}

export interface PlayerRef {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  perWeek: number;
  injuryStatus: string | null;
}

export interface TradeView {
  key: string;
  partner: { rosterId: number; manager: string; teamName: string };
  give: PlayerRef[];
  get: PlayerRef[];
  myGain: number;
  theirGain: number;
  myBefore: number;
  myAfter: number;
  theirBefore: number;
  theirAfter: number;
  marketGive: number;
  marketGet: number;
  marketRatio: number;
  acceptance: number;
  expectedGain: number;
  label: TradeEval["label"];
  passes: boolean;
  alternatives: number;
  problems: string[];
  forMe: string[];
  forThem: string[];
  pitch: string;
  myPositionDelta: Record<string, number>;
  theirPositionDelta: Record<string, number>;
  weeklyDelta: number[];
  myDrops: PlayerRef[];
  theirDrops: PlayerRef[];
}

export interface TradeRequest {
  partner?: number | null;
  give?: string[];
  get?: string[];
  keep?: string[];
  maxPerSide?: number;
  sort?: TradeSort;
}

export interface TradeAnalysis {
  trades: TradeView[];
  proposal: TradeView | null;
  partners: number[];
  maxPerSide: number;
  considered: number;
  evaluated: number;
  elapsedMs: number;
  notes: string[];
}

export interface DeepRequest {
  partner?: number | null;
  give: string[];
  get: string[];
  /** Run again even if a recent analysis of this exact trade exists. */
  fresh?: boolean;
}

/** One deep analysis, running or finished. The browser polls it by id. */
export interface DeepJob {
  id: string;
  status: "running" | "done" | "error";
  /** The engine's evaluation of the trade under review. */
  trade: TradeView;
  steps: ReviewStep[];
  verdict: TradeVerdict | null;
  /** The engine's evaluation of Claude's counter-offer, when it made one. */
  counter: TradeView | null;
  /** Why a counter-offer could not be scored, if it could not. */
  counterNote: string | null;
  /** Exactly what Claude was told. */
  briefing: string;
  model: string | null;
  costUsd: number | null;
  searches: number;
  engineCalls: number;
  sources: ReviewSource[];
  error: string | null;
  /** Served from a recent run of the same trade on the same rosters. */
  reused: boolean;
  startedAt: number;
  finishedAt: number | null;
}

/** Deep analysis cannot run here - no API key, or a provider without it. */
export class DeepUnavailableError extends Error {
  override name = "DeepUnavailableError";
}

/** What the server routes need. The demo and tests provide their own. */
export interface TradeProvider {
  overview(opts?: { refresh?: boolean }): Promise<TradeOverview>;
  analyze(req: TradeRequest): Promise<TradeAnalysis>;
  startDeep?(req: DeepRequest): Promise<DeepJob>;
  deepJob?(id: string): DeepJob | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface Built {
  data: TradeData;
  universe: TradeUniverse;
  rosters: TeamRoster[];
  profiles: Map<number, TeamProfile>;
  me: number;
  rostersAt: number;
}

export class TradeService implements TradeProvider {
  private built: Built | null = null;
  private loading: Promise<Built> | null = null;
  private jobs = new Map<string, DeepJob & { key: string }>();

  constructor(
    private readonly source: TradeDataSource = liveTradeSource(),
    private readonly now: () => number = Date.now,
    private readonly reviewer: TradeReviewer = claudeReviewer(),
  ) {}

  async overview(opts: { refresh?: boolean } = {}): Promise<TradeOverview> {
    const b = await this.ensure(opts.refresh ? "all" : "rosters");
    const weeks = b.universe.weeks;
    const deadline = b.data.league.settings?.trade_deadline ?? null;
    return {
      league: {
        name: b.data.league.name,
        season: b.data.league.season,
        scoring: describeScoring(b.data.league.scoring_settings),
        nflWeek: b.data.nflWeek,
        weeks,
        tradeDeadline: deadline || null,
        deadlinePassed: deadline != null && deadline > 0 && b.data.nflWeek > deadline,
        teams: b.rosters.length,
      },
      positions: rankedPositions(b.universe),
      source: b.data.source,
      me: b.me,
      teams: b.rosters.map((r) => this.teamView(b, r)),
      updatedAt: b.rostersAt,
    };
  }

  async analyze(req: TradeRequest): Promise<TradeAnalysis> {
    const b = await this.ensure("rosters");
    const started = performance.now();
    const result = await findTrades(b.universe, b.rosters, {
      me: b.me,
      partner: req.partner ?? null,
      give: req.give,
      get: req.get,
      keep: req.keep,
      maxPerSide: req.maxPerSide,
      sort: req.sort,
    });
    const view = (t: TradeEval) => this.tradeView(b, t);
    return {
      trades: result.trades.map(view),
      proposal: result.proposal ? view(result.proposal) : null,
      partners: result.partners,
      maxPerSide: result.maxPerSide,
      considered: result.considered,
      evaluated: result.evaluated,
      elapsedMs: Math.round(performance.now() - started),
      notes: result.notes,
    };
  }

  /**
   * Start a deep analysis of one exact trade and return at once; the browser polls
   * `deepJob`. A run takes one to two minutes, longer than a request should hang.
   *
   * The same trade on the same rosters reuses a recent finished run rather than
   * paying again - unless asked for a fresh one - and a run already in flight is
   * shared rather than doubled.
   */
  async startDeep(req: DeepRequest): Promise<DeepJob> {
    const why = this.reviewer.unavailable();
    if (why) throw new DeepUnavailableError(why);

    const b = await this.ensure("rosters");
    const { mine, theirs, give, get } = this.resolveTrade(b, req);
    const key = `${tradeKey({ partner: theirs.rosterId, give, get })}|${rosterHash(mine)}|${rosterHash(theirs)}`;

    const existing = [...this.jobs.values()].find((j) => j.key === key);
    if (existing?.status === "running") return snapshot(existing);
    const fresh = existing && existing.status === "done" && this.now() - (existing.finishedAt ?? 0) < config.trade.deep.reuseMs;
    if (fresh && !req.fresh) return { ...snapshot(existing), reused: true };

    const trade = this.tradeView(b, evaluateTrade(b.universe, mine, theirs, give, get));
    const briefing = this.briefing(b, trade);
    const job: DeepJob & { key: string } = {
      id: crypto.randomUUID(),
      key,
      status: "running",
      trade,
      steps: [],
      verdict: null,
      counter: null,
      counterNote: null,
      briefing,
      model: null,
      costUsd: null,
      searches: 0,
      engineCalls: 0,
      sources: [],
      error: null,
      reused: false,
      startedAt: this.now(),
      finishedAt: null,
    };
    this.remember(job);
    void this.runDeep(b, job, mine, theirs);
    return snapshot(job);
  }

  deepJob(id: string): DeepJob | null {
    const job = this.jobs.get(id);
    return job ? snapshot(job) : null;
  }

  private async runDeep(b: Built, job: DeepJob, mine: TeamRoster, theirs: TeamRoster): Promise<void> {
    try {
      const result = await this.reviewer.review({
        briefing: job.briefing,
        trade: {
          partner: job.trade.partner.teamName,
          give: job.trade.give.map((p) => p.name),
          get: job.trade.get.map((p) => p.name),
        },
        engine: this.reviewEngine(b, mine, theirs),
        onStep: (step) => job.steps.push(step),
      });
      job.verdict = result.verdict;
      job.model = result.servedBy;
      job.costUsd = result.usage.estimatedCostUsd;
      job.searches = result.searches;
      job.engineCalls = result.engineCalls;
      job.sources = result.sources;

      // Re-score the counter with the engine, so the numbers shown beside it are
      // the engine's rather than the model's paraphrase of them.
      const counter = result.verdict.counter_offer;
      if (counter) {
        try {
          const give = counter.give.map((q) => resolvePlayer(b, q, mine.players, "your roster"));
          const get = counter.get.map((q) => resolvePlayer(b, q, theirs.players, "their roster"));
          job.counter = this.tradeView(b, evaluateTrade(b.universe, mine, theirs, give, get));
        } catch (err) {
          job.counterNote = err instanceof Error ? err.message : String(err);
        }
      }
      job.status = "done";
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.finishedAt = this.now();
    }
  }

  /** Validate a pinned trade: your players out, one partner's players in. */
  private resolveTrade(b: Built, req: DeepRequest) {
    const give = [...new Set(req.give)];
    const get = [...new Set(req.get)];
    if (!give.length || !get.length) {
      throw new TradeQueryError("Pick players on both sides to analyze a trade.");
    }
    const mine = b.rosters.find((r) => r.rosterId === b.me)!;
    const missing = give.find((id) => !mine.players.includes(id));
    if (missing) throw new TradeQueryError(`${b.universe.players.get(missing)?.name ?? missing} is not on your roster.`);
    const theirs = b.rosters.find((r) => r.rosterId !== b.me && get.every((id) => r.players.includes(id)));
    if (!theirs) throw new TradeQueryError("Players you want must all be on one other team's roster.");
    if (req.partner != null && req.partner !== theirs.rosterId) {
      throw new TradeQueryError("Players you want are not on the team you selected.");
    }
    return { mine, theirs, give, get };
  }

  private briefing(b: Built, trade: TradeView): string {
    const weeks = Math.max(1, b.universe.weeks.length);
    const freeAgents = b.universe.freeAgents
      .map((id) => b.universe.players.get(id)!)
      .filter((p) => p.position !== "K")
      .slice(0, 300)
      .map((p) => ({
        name: p.name,
        position: p.position,
        team: p.team,
        perWeek: round1(p.rosTotal / weeks),
        injuryStatus: p.injuryStatus,
      }));
    return buildBriefing({
      league: b.data.league,
      teams: b.rosters.map((r) => this.teamView(b, r)),
      positions: rankedPositions(b.universe),
      me: b.me,
      trade,
      nflWeek: b.data.nflWeek,
      weeks: b.universe.weeks,
      today: easternDate(new Date(this.now())),
      freeAgents,
    });
  }

  /** The engine, as Claude's tools see it: names in, compact JSON out. */
  private reviewEngine(b: Built, mine: TeamRoster, theirs: TeamRoster): ReviewEngine {
    const others = b.rosters.filter((r) => r.rosterId !== b.me);
    const players = (ps: PlayerRef[]) =>
      ps.map((p) => ({ player: p.name, position: p.position, per_week: p.perWeek, status: p.injuryStatus }));
    const compact = (t: TradeView) => ({
      partner: t.partner.teamName,
      you_give: players(t.give),
      you_get: players(t.get),
      your_change_per_week: t.myGain,
      their_change_per_week: t.theirGain,
      on_paper_for_them_pct: Math.round(t.marketRatio * 100),
      acceptance_pct: Math.round(t.acceptance * 100),
      clears_bar: t.passes,
      problems: t.problems,
      your_lineup_by_position: t.myPositionDelta,
      you_cut: t.myDrops.map((p) => p.name),
      they_cut: t.theirDrops.map((p) => p.name),
      notes_for_you: t.forMe,
      notes_for_them: t.forThem,
    });
    const team = (query: string) => {
      const q = query.toLowerCase().trim();
      const views = others.map((r) => this.teamView(b, r));
      const hit =
        views.find((t) => t.teamName.toLowerCase() === q || t.manager.toLowerCase() === q) ??
        views.find((t) => t.teamName.toLowerCase().includes(q) || t.manager.toLowerCase().includes(q));
      if (!hit) throw new Error(`No other team matches "${query}".`);
      return hit;
    };

    return {
      evaluate: async (give, get) => {
        const g = give.map((q) => resolvePlayer(b, q, mine.players, "your roster"));
        const h = get.map((q) => resolvePlayer(b, q, theirs.players, "their roster"));
        return compact(this.tradeView(b, evaluateTrade(b.universe, mine, theirs, g, h)));
      },
      find: async (opts) => {
        const partner = opts.team ? team(opts.team).rosterId : null;
        const give = (opts.give ?? []).map((q) => resolvePlayer(b, q, mine.players, "your roster"));
        const get = (opts.get ?? []).map((q) =>
          resolvePlayer(b, q, others.flatMap((r) => r.players), "another team's roster"),
        );
        const result = await findTrades(b.universe, b.rosters, {
          me: b.me,
          partner,
          give,
          get,
          maxPerSide: opts.maxPerSide,
          limit: 5,
        });
        const view = (t: TradeEval) => compact(this.tradeView(b, t));
        return {
          exact_trade: result.proposal ? view(result.proposal) : null,
          trades: result.trades.map(view),
          notes: result.notes,
        };
      },
      team: async (query) => {
        const t = team(query);
        return {
          team: t.teamName,
          manager: t.manager,
          record: t.record,
          projected_per_week: t.perWeek,
          projected_rank: t.rank,
          position_ranks: Object.fromEntries(Object.entries(t.positions).map(([p, s]) => [p, s.rank])),
          needs: t.needs,
          surplus: t.surplus,
          players: t.players.map((p) => ({
            player: `${p.position} ${p.name}${p.team ? ` (${p.team})` : ""}`,
            per_week: p.perWeek,
            starts_pct: Math.round(p.startShare * 100),
            status: [p.reserve ? "IR slot" : "", p.injuryStatus ?? ""].filter(Boolean).join(", ") || null,
            weekly: p.weekly,
          })),
        };
      },
    };
  }

  /** Keep a bounded history: the oldest finished runs go first. */
  private remember(job: DeepJob & { key: string }): void {
    this.jobs.set(job.id, job);
    while (this.jobs.size > 30) {
      const oldest = [...this.jobs.values()].find((j) => j.status !== "running");
      if (!oldest) break;
      this.jobs.delete(oldest.id);
    }
  }

  /**
   * Load everything once; afterwards refresh rosters when stale. Concurrent
   * callers share one in-flight load rather than each hitting Sleeper.
   */
  private async ensure(level: "rosters" | "all"): Promise<Built> {
    if (this.loading) return this.loading;
    const fresh = this.built && this.now() - this.built.rostersAt < config.trade.rosterMaxAgeMs;
    if (this.built && level === "rosters" && fresh) return this.built;

    this.loading = (async () => {
      try {
        let data: TradeData;
        if (!this.built || level === "all") {
          data = await this.source.load(level === "all");
        } else {
          try {
            const { rosters, users } = await this.source.rosters();
            data = { ...this.built.data, rosters, users };
          } catch (err) {
            // A blip refreshing rosters is not worth failing a search over -
            // minute-old rosters are almost always still right. Next call retries.
            console.warn(`[trades] roster refresh failed, using cached: ${err instanceof Error ? err.message : err}`);
            return this.built;
          }
        }
        this.built = build(data, this.now());
        return this.built;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private teamView(b: Built, r: TeamRoster): TeamView {
    const profile = b.profiles.get(r.rosterId)!;
    const raw = b.data.rosters.find((x) => x.roster_id === r.rosterId);
    const user = b.data.users.find((u) => u.user_id === raw?.owner_id);
    const s = raw?.settings ?? {};
    const reserve = new Set(r.reserve);
    const weeks = Math.max(1, b.universe.weeks.length);

    const players = r.players
      .map((id) => this.playerView(b, id, reserve.has(id), profile.startShare.get(id) ?? 0, weeks))
      .filter((p): p is PlayerView => p != null)
      .sort((a, b2) => POSITION_ORDER(a.position) - POSITION_ORDER(b2.position) || b2.perWeek - a.perWeek);

    return {
      rosterId: r.rosterId,
      manager: user?.display_name ?? user?.username ?? `Roster ${r.rosterId}`,
      teamName: (user?.metadata?.team_name as string | undefined) || user?.display_name || `Team ${r.rosterId}`,
      avatar: avatarUrl(user),
      isMe: r.rosterId === b.me,
      record: `${s.wins ?? 0}-${s.losses ?? 0}${s.ties ? `-${s.ties}` : ""}`,
      wins: s.wins ?? 0,
      losses: s.losses ?? 0,
      pointsFor: (s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100,
      perWeek: round1(profile.perWeek),
      rank: profile.rank,
      positions: profile.positions,
      needs: profile.needs,
      surplus: profile.surplus,
      players,
    };
  }

  private playerView(b: Built, id: string, reserve: boolean, startShare: number, weeks: number): PlayerView | null {
    const p = b.universe.players.get(id);
    const raw = b.data.players[id];
    if (!p) return null;
    const images = playerImages(
      raw ?? { player_id: id, espn_id: null, first_name: null, last_name: null, full_name: p.name, position: p.position },
    );
    return {
      playerId: id,
      name: p.name,
      position: p.position,
      team: p.team,
      injuryStatus: p.injuryStatus,
      reserve,
      perWeek: round1(p.rosTotal / weeks),
      rosTotal: p.rosTotal,
      marketValue: p.marketValue,
      startShare: Math.round(startShare * 100) / 100,
      weekly: p.weekly.map(round1),
      photo: images.primary,
      photoFallback: images.fallback,
      initials: images.initials,
    };
  }

  private tradeView(b: Built, t: TradeEval): TradeView {
    const managerName = (rosterId: number) => {
      const raw = b.data.rosters.find((x) => x.roster_id === rosterId);
      const user = b.data.users.find((u) => u.user_id === raw?.owner_id);
      return user?.display_name ?? user?.username ?? `Roster ${rosterId}`;
    };
    const teamName = (rosterId: number) => {
      const raw = b.data.rosters.find((x) => x.roster_id === rosterId);
      const user = b.data.users.find((u) => u.user_id === raw?.owner_id);
      return (user?.metadata?.team_name as string | undefined) || managerName(rosterId);
    };
    const weeks = Math.max(1, b.universe.weeks.length);
    const ref = (id: string): PlayerRef => {
      const p = b.universe.players.get(id);
      return {
        playerId: id,
        name: p?.name ?? id,
        position: p?.position ?? "",
        team: p?.team ?? null,
        perWeek: round1((p?.rosTotal ?? 0) / weeks),
        injuryStatus: p?.injuryStatus ?? null,
      };
    };
    const ex = explainTrade(
      { u: b.universe, rosters: b.rosters, profiles: b.profiles, me: b.me, managerName },
      t,
    );
    return {
      key: `${t.partner}|${[...t.give].sort().join(",")}|${[...t.get].sort().join(",")}`,
      partner: { rosterId: t.partner, manager: managerName(t.partner), teamName: teamName(t.partner) },
      give: t.give.map(ref),
      get: t.get.map(ref),
      myGain: round2(t.myGain),
      theirGain: round2(t.theirGain),
      myBefore: round1(t.myBefore),
      myAfter: round1(t.myAfter),
      theirBefore: round1(t.theirBefore),
      theirAfter: round1(t.theirAfter),
      marketGive: round1(t.marketGive),
      marketGet: round1(t.marketGet),
      marketRatio: round2(t.marketRatio),
      acceptance: round2(t.acceptance),
      expectedGain: round2(t.expectedGain),
      label: t.label,
      passes: t.passes,
      alternatives: t.alternatives,
      problems: t.problems,
      forMe: ex.forMe,
      forThem: ex.forThem,
      pitch: ex.pitch,
      myPositionDelta: ex.me.positionDelta,
      theirPositionDelta: ex.them.positionDelta,
      weeklyDelta: ex.me.weeklyDelta,
      myDrops: t.myDrops.map(ref),
      theirDrops: t.theirDrops.map(ref),
    };
  }
}

function build(data: TradeData, now: number): Built {
  const rosters: TeamRoster[] = data.rosters.map((r) => ({
    rosterId: r.roster_id,
    players: [...(r.players ?? [])],
    reserve: [...(r.reserve ?? [])],
  }));
  const mine = data.rosters.find(
    (r) => r.owner_id === data.userId || (r.co_owners ?? []).includes(data.userId),
  );
  if (!mine) throw new Error("You do not have a roster in this league.");

  const universe = buildUniverse({
    league: data.league,
    rosters,
    players: data.players,
    weekly: data.weekly,
    weeks: data.weeks,
    byeWeek: data.byeWeek,
    played: data.played,
  });
  return {
    data,
    universe,
    rosters,
    profiles: profileLeague(universe, rosters),
    me: mine.roster_id,
    rostersAt: now,
  };
}

/** Sleeper avatars: a custom team image URL when set, else the account avatar. */
function avatarUrl(user: LeagueUser | undefined): string | null {
  const custom = user?.metadata?.avatar;
  if (typeof custom === "string" && custom.startsWith("http")) return custom;
  return user?.avatar ? `${config.sleeper.cdnBase}/avatars/thumbs/${user.avatar}` : null;
}

/**
 * A player id from what Claude typed: an id, a full name, or a distinctive part
 * of one, looked up only within `pool` so a name can never resolve to the wrong
 * team's player.
 */
function resolvePlayer(b: Built, query: string, pool: string[], where: string): string {
  const q = normaliseName(query);
  const named = pool.map((id) => ({ id, name: normaliseName(b.universe.players.get(id)?.name ?? id) }));
  const hit =
    named.find((p) => p.id === query.trim()) ??
    named.find((p) => p.name === q) ??
    onlyOne(named.filter((p) => p.name.includes(q) || q.includes(p.name))) ??
    onlyOne(named.filter((p) => p.name.split(" ").at(-1) === q.split(" ").at(-1)));
  if (!hit) throw new Error(`No player matching "${query}" on ${where}.`);
  return hit.id;
}

const onlyOne = <T>(xs: T[]): T | undefined => (xs.length === 1 ? xs[0] : undefined);
const normaliseName = (s: string) =>
  s.toLowerCase().replace(/[.'’]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();
const rosterHash = (r: TeamRoster) => Bun.hash([...r.players].sort().join(",")).toString(36);
const snapshot = (job: DeepJob & { key?: string }): DeepJob => {
  const { key: _key, ...rest } = job;
  return { ...rest, steps: [...job.steps], sources: [...job.sources] };
};

const ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];
const POSITION_ORDER = (pos: string) => {
  const i = ORDER.indexOf(pos);
  return i < 0 ? ORDER.length : i;
};

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
