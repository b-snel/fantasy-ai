/**
 * The waiver analyzer behind the HTTP surface.
 *
 * Built on the trade analyzer's data - the same rosters and rest-of-season weekly
 * projections, through the same TradeDataSource - plus what only the wire needs:
 * league transactions and Sleeper-wide trending (who is on waivers, what claims
 * cost here), recent box scores (usage context), the NFL schedule (whose game has
 * kicked off), and the fantasy schedule (playoff odds and which weeks matter).
 *
 * Independent of the draft session, lazy, and refreshed when rosters are older
 * than a minute, exactly like TradeService. Overview and analyze are pure engine
 * work over cached data; the one paid step, the news check, runs as a background
 * job so a slow model call can never outlive the HTTP connection.
 */

import { config } from "../config.ts";
import { getMatchups } from "../sleeper/client.ts";
import { getLeagueActivity, mergeActivity, type LeagueActivity } from "../data/activity.ts";
import { getUsage, type UsageIndex } from "../data/usage.ts";
import { getTeamSchedule, type TeamSchedule } from "../data/schedule.ts";
import { easternDate, lastFantasyWeek, type RosSource } from "../data/ros.ts";
import { playerImages } from "../data/photos.ts";
import { describeScoring } from "../engine/scoring.ts";
import { buildUniverse, rosterBreakdown, type TeamRoster, type TradeUniverse } from "../trade/value.ts";
import { liveTradeSource, type TradeData, type TradeDataSource } from "./trades.ts";
import { availabilityOf, gameStarted, irEligible, waiverCalendar, type Availability, type WaiverCalendar } from "../waiver/availability.ts";
import { faabMarket, suggestBid, type BidAdvice, type FaabMarket } from "../waiver/market.ts";
import { simulateSeason, weekLeverage, type Leverage, type SeasonInput } from "../waiver/odds.ts";
import { activePlayers, findMoves, type WaiverMove, type WaiverQuery, type SearchContext } from "../waiver/search.ts";
import { buildPlan, canWait, returnWeek, type PlanStep } from "../waiver/plan.ts";
import { cutCandidates, holesForWeek, lineupCheck, streamsForWeek, type Cut, type Hole, type LineupFix } from "../waiver/streams.ts";
import { floorTable, weekZero as weekZeroOf, weeklyPoints, type FloorTable, type WeekZero } from "../waiver/universe.ts";
import { fmtCount, holeLine, moveReasons, scheduleStrip, usageLine, type StripWeek } from "../waiver/explain.ts";
import { liveNewsProvider, type MoveVerdict, type NewsCandidate, type NewsItem, type NewsProvider } from "../waiver/news.ts";
import type { LeagueUser, Roster } from "../sleeper/types.ts";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export interface WaiverExtras {
  activity: LeagueActivity;
  usage: UsageIndex;
  schedule: TeamSchedule;
  /** Regular-season fantasy weeks in the window -> pairs of roster ids. */
  matchups: Map<number, Array<[number, number]>>;
  /** Points each roster has scored so far this week. */
  scoredThisWeek: Map<number, number>;
}

/** Everything beyond the trade data. Live, or the fixture league for tests and the demo. */
export interface WaiverExtrasSource {
  load(data: TradeData, force: boolean): Promise<WaiverExtras>;
  /** The parts that move between refreshes: transactions, trending, game status, live points. */
  refresh(data: TradeData, previous: WaiverExtras): Promise<WaiverExtras>;
}

export function liveWaiverExtras(): WaiverExtrasSource {
  const weekly = async (data: TradeData) => {
    const last = (data.league.settings?.playoff_week_start ?? 15) - 1;
    const regular = data.weeks.filter((w) => w <= last);
    const pages = await Promise.all(regular.map((w) => getMatchups(config.leagueId, w).catch(() => null)));
    const matchups = new Map<number, Array<[number, number]>>();
    let scoredThisWeek = new Map<number, number>();
    regular.forEach((week, i) => {
      // A failed fetch is an unknown week, not a week with no games - leaving it
      // out lets the season simulation give it an average weight instead of zero.
      if (pages[i] == null) {
        console.warn(`[waivers] fantasy matchups for week ${week} failed - weighting it as an average week`);
        return;
      }
      const rows = pages[i]!;
      const byId = new Map<number, number[]>();
      for (const m of rows) {
        if (m.matchup_id == null) continue;
        byId.set(m.matchup_id, [...(byId.get(m.matchup_id) ?? []), m.roster_id]);
      }
      matchups.set(week, [...byId.values()].filter((p) => p.length === 2).map((p) => [p[0]!, p[1]!] as [number, number]));
      if (week === data.nflWeek) scoredThisWeek = new Map(rows.map((m) => [m.roster_id, m.points ?? 0]));
    });
    return { matchups, scoredThisWeek };
  };
  return {
    async load(data, force) {
      const [activity, usage, schedule, sched] = await Promise.all([
        getLeagueActivity({ leagueId: config.leagueId, throughWeek: data.nflWeek }),
        getUsage({
          season: data.league.season,
          throughWeek: data.nflWeek - 1,
          scoring: data.league.scoring_settings,
          players: data.players,
          force,
        }),
        getTeamSchedule({ season: data.league.season, force }),
        weekly(data),
      ]);
      return { activity, usage, schedule, ...sched };
    },
    async refresh(data, previous) {
      const [activity, schedule, current] = await Promise.all([
        getLeagueActivity({ leagueId: config.leagueId, throughWeek: data.nflWeek }),
        getTeamSchedule({ season: data.league.season }),
        getMatchups(config.leagueId, data.nflWeek).catch(() => null),
      ]);
      // A Sleeper blip must not swap good data for empty: an empty schedule
      // unlocks every game, and missing transactions forget who is on waivers.
      if (activity.failedWeeks.length) console.warn(`[waivers] transactions for week(s) ${activity.failedWeeks.join(", ")} failed - keeping the last good copy`);
      return {
        ...previous,
        activity: mergeActivity(previous.activity, activity),
        schedule: Object.keys(schedule).length ? schedule : previous.schedule,
        scoredThisWeek: current ? new Map(current.map((m) => [m.roster_id, m.points ?? 0])) : previous.scoredThisWeek,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Views - what the browser and the CLI get
// ---------------------------------------------------------------------------

export type Horizon = "auto" | "week" | "season" | "playoffs";

export interface AvailabilityView {
  mode: Availability["mode"];
  /** e.g. "Free agent - add now, locks ~Sun 1:00pm ET". */
  label: string;
  processesAt: number | null;
  locksAt: number | null;
}

export interface PlayerCard {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  injuryStatus: string | null;
  /** Projected points per week over the window. */
  perWeek: number;
  weekly: number[];
  strip: StripWeek[];
  usage: string | null;
  trendingAdds: number | null;
  trendingDrops: number | null;
  photo: string;
  photoFallback: string | null;
  initials: string;
}

export interface RosterRow extends PlayerCard {
  reserve: boolean;
  /** Weighted pts/wk your lineup loses if he is cut. */
  cutCost: number;
  /** Weeks he starts in your best lineup. */
  starts: number;
  /** In Sleeper's saved lineup this week. */
  starting: boolean;
  /** His game this week has started - he cannot be dropped or moved. */
  locked: boolean;
}

export interface MoveView {
  key: string;
  add: PlayerCard;
  drop: PlayerCard | null;
  irMove: PlayerCard | null;
  gain: number;
  gainTotal: number;
  gainThisWeek: number;
  pointsTotal: number;
  weeklyDelta: number[];
  kind: WaiverMove["kind"];
  /** NFL week carrying most of the value. */
  peakWeek: number;
  peakShare: number;
  canWait: boolean;
  startWeek: number;
  availability: AvailabilityView;
  bid: BidAdvice | null;
  reasons: string[];
  dropOptions: Array<{ player: PlayerCard | null; gain: number }>;
  /** Folded streams for the same week and position, best first. */
  alternatives: Array<{ player: PlayerCard; gain: number; availability: AvailabilityView }>;
  news: { note: string; outlook: NewsItem["outlook"] } | null;
  verdict: { verdict: MoveVerdict["verdict"]; reason: string } | null;
}

export type PlanStepView =
  | { kind: "lineup"; text: string; start: PlayerCard[]; sit: PlayerCard[]; gain: number }
  | { kind: "ir-healthy"; text: string; player: PlayerCard }
  | { kind: "ir-move"; text: string; player: PlayerCard }
  | { kind: "add"; text: string; move: MoveView }
  | { kind: "claim"; text: string; move: MoveView; fallbacks: MoveView[] }
  | { kind: "later"; text: string; week: number; move: MoveView; alternatives: MoveView[]; nowCost: number }
  | { kind: "return"; text: string; week: number; player: PlayerCard; cut: PlayerCard | null };

export interface StreamWeekView {
  week: number;
  holes: string[];
  streams: Array<{ player: PlayerCard; gain: number; points: number; replaces: string | null; availability: AvailabilityView }>;
}

export interface TeamLine {
  rosterId: number;
  teamName: string;
  manager: string;
  avatar: string | null;
  isMe: boolean;
  record: string;
  pointsFor: number;
  faabLeft: number | null;
  priority: number | null;
  playoffOdds: number;
  /** Positions with a hole this week or next. */
  holes: string[];
}

export interface WaiverOverview {
  league: {
    name: string;
    season: string;
    scoring: string;
    nflWeek: number;
    weeks: number[];
    faab: boolean;
    budget: number;
    lastRun: number | null;
    nextRun: number;
    nextRunLabel: string;
    clearHours: number;
    playoffWeekStart: number | null;
    teams: number;
    /** Positions a lineup slot can use - the ones worth filtering by. */
    positions: string[];
  };
  me: number;
  team: {
    teamName: string;
    manager: string;
    record: string;
    faabLeft: number | null;
    priority: number | null;
    playoffOdds: number;
    titleOdds: number;
    /** Expected lineup points per week, no further moves. */
    perWeek: number;
    players: RosterRow[];
  };
  /** Week weights for the default (auto) horizon, with the season situation behind them. */
  leverage: { weights: number[]; alive: number[]; margins: Array<number | null>; note: string };
  alerts: Array<{ cls: "warn" | "run" | "tier"; text: string }>;
  holes: string[];
  cuts: Array<{ player: PlayerCard; cost: number; starts: number }>;
  league_table: TeamLine[];
  market: {
    winning: FaabMarket["winning"];
    clearingByBidders: FaabMarket["clearingByBidders"];
    byPosition: FaabMarket["byPosition"];
  };
  source: RosSource;
  newsAvailable: boolean;
  updatedAt: number;
}

export interface WaiverRequest {
  horizon?: Horizon;
  positions?: string[];
  keep?: string[];
  add?: string | null;
  drop?: string | null;
}

export interface WaiverAnalysis {
  horizon: Horizon;
  weights: number[];
  plan: PlanStepView[];
  moves: MoveView[];
  proposal: MoveView | null;
  streams: StreamWeekView[];
  considered: number;
  evaluated: number;
  elapsedMs: number;
  notes: string[];
  news: { summary: string | null } | null;
}

export interface NewsJobView {
  status: "idle" | "running" | "done" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  costUsd: number;
  searches: number;
  cachedPlayers: number;
  summary: string | null;
  items: Array<{ playerId: string; name: string; note: string; outlook: NewsItem["outlook"] }>;
  verdicts: Array<{ add: string; name: string; verdict: MoveVerdict["verdict"]; reason: string }>;
}

/** What the server routes need. Tests provide fakes. */
export interface WaiverProvider {
  overview(opts?: { refresh?: boolean }): Promise<WaiverOverview>;
  analyze(req: WaiverRequest): Promise<WaiverAnalysis>;
  /** Start a news check over the last analysis (or return the one in flight). */
  startNews(req: WaiverRequest): Promise<NewsJobView>;
  newsStatus(): NewsJobView;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface Built {
  data: TradeData;
  extras: WaiverExtras;
  /** Trade universe with byes patched from the schedule. */
  base: TradeUniverse;
  table: FloorTable;
  rosters: TeamRoster[];
  me: number;
  calendar: WaiverCalendar;
  market: FaabMarket;
  leverage: Leverage;
  playoffOdds: Map<number, number>;
  locked: Set<string>;
  irEligibleMine: string[];
  healthyInIr: string[];
  returns: Array<{ playerId: string; weekIndex: number }>;
  lineup: LineupFix | null;
  availability: Map<string, Availability>;
  holesBy: Map<number, Map<number, Hole[]>>;
  /** Per roster: this week's open slots and frozen starters. */
  weekZero: Map<number, WeekZero>;
  rostersAt: number;
  /** Eastern date of the full load - a new day reloads projections and the week. */
  loadedOn: string;
}

export class WaiverService implements WaiverProvider {
  private built: Built | null = null;
  private loading: Promise<Built> | null = null;
  private loadingLevel: "rosters" | "all" | null = null;
  private news: NewsJobView = emptyJob();
  private newsRun: Promise<void> | null = null;
  private newsNotes = new Map<string, NewsItem>();
  private newsVerdicts = new Map<string, MoveVerdict>();
  private newsSummary: string | null = null;
  private newsLoaded = false;
  /** Eastern day the in-memory notes belong to. */
  private newsDay: string | null = null;

  constructor(
    private readonly source: TradeDataSource = liveTradeSource(),
    private readonly extrasSource: WaiverExtrasSource = liveWaiverExtras(),
    private readonly newsProvider: NewsProvider | null = liveNewsProvider(),
    private readonly now: () => number = Date.now,
  ) {}

  async overview(opts: { refresh?: boolean } = {}): Promise<WaiverOverview> {
    const b = await this.ensure(opts.refresh ? "all" : "rosters");
    await this.loadCachedNews();
    const weeks = b.base.weeks;
    const raw = b.data.rosters.find((r) => r.roster_id === b.me);
    const mine = b.rosters.find((r) => r.rosterId === b.me)!;
    const settings = b.data.league.settings ?? {};
    const faab = settings.waiver_type === 2;
    const weights = b.leverage.weights;
    const cuts = cutCandidates(b.base, b.table, mine, weights, new Set(), b.weekZero.get(b.me));
    const flat = rosterBreakdown({ ...b.base, noFloorWeeks: b.base.weeks.length }, mine.players);
    const starters = new Set(raw?.starters ?? []);

    const alerts: WaiverOverview["alerts"] = [];
    if (b.lineup) {
      alerts.push({
        cls: "warn",
        text: `Your week ${b.data.nflWeek} lineup leaves ${b.lineup.gain.toFixed(1)} projected points on the bench - start ${b.lineup.start.map((s) => this.name(b, s.playerId)).join(", ")}`,
      });
    }
    for (const id of b.healthyInIr) {
      alerts.push({ cls: "warn", text: `${this.name(b, id)} is in IR without an IR designation - move him out; Sleeper may block your adds until you do` });
    }
    for (const h of b.holesBy.get(b.me)?.get(0) ?? []) alerts.push({ cls: "run", text: holeLine(b.base, h) });
    for (const h of b.holesBy.get(b.me)?.get(1) ?? []) alerts.push({ cls: "tier", text: holeLine(b.base, h) });
    if (b.leverage.playoffOdds < 0.1) {
      alerts.push({
        cls: "tier",
        text: `Playoff odds ${pct(b.leverage.playoffOdds)}: the ranking leans on the next few weeks, and FAAB is worth spending`,
      });
    }
    if (b.data.source === "season_fallback") {
      alerts.push({ cls: "warn", text: "Weekly projections unavailable - using season totals, so byes and injury timing are approximate" });
    }

    const holes = [0, 1].flatMap((i) => (b.holesBy.get(b.me)?.get(i) ?? []).map((h) => holeLine(b.base, h)));
    const players: RosterRow[] = mine.players
      .map((id) => {
        const card = this.card(b, id);
        if (!card) return null;
        const cut = cuts.find((c) => c.playerId === id);
        return {
          ...card,
          reserve: mine.reserve.includes(id),
          cutCost: cut?.cost ?? 0,
          starts: flat.starts.get(id) ?? 0,
          starting: starters.has(id),
          locked: b.locked.has(id),
        } satisfies RosterRow;
      })
      .filter((r): r is RosterRow => r != null)
      .sort((a, c) => POSITION_ORDER(a.position) - POSITION_ORDER(c.position) || c.perWeek - a.perWeek);

    return {
      league: {
        name: b.data.league.name,
        season: b.data.league.season,
        scoring: describeScoring(b.data.league.scoring_settings),
        nflWeek: b.data.nflWeek,
        weeks,
        faab,
        budget: settings.waiver_budget ?? 0,
        lastRun: b.calendar.lastRun,
        nextRun: b.calendar.nextRun,
        nextRunLabel: formatEt(b.calendar.nextRun),
        clearHours: Math.round(b.calendar.clearMs / 3_600_000),
        playoffWeekStart: settings.playoff_week_start ?? null,
        teams: b.rosters.length,
        positions: ORDER.filter((pos) => b.base.slots.some((slot) => slot.eligible.includes(pos))),
      },
      me: b.me,
      team: {
        teamName: this.teamName(b, b.me),
        manager: this.managerName(b, b.me),
        record: record(raw),
        faabLeft: faab ? (b.market.budgets.get(b.me) ?? 0) : null,
        priority: b.market.priority.get(b.me) ?? null,
        playoffOdds: round3(b.leverage.playoffOdds),
        titleOdds: round3(b.leverage.titleOdds),
        perWeek: round1(flat.total / Math.max(1, weeks.length)),
        players,
      },
      leverage: {
        weights: weights.map(round2),
        alive: b.leverage.alive.map(round2),
        margins: b.leverage.margins.map((m) => (m == null ? null : round1(m))),
        note: leverageNote(b),
      },
      alerts,
      holes,
      cuts: cuts.slice(0, 6).map((c) => ({ player: this.card(b, c.playerId)!, cost: c.cost, starts: c.starts })),
      league_table: b.rosters.map((r) => this.teamLine(b, r)),
      market: {
        winning: b.market.winning,
        clearingByBidders: b.market.clearingByBidders,
        byPosition: b.market.byPosition,
      },
      source: b.data.source,
      newsAvailable: this.newsProvider != null,
      updatedAt: b.rostersAt,
    };
  }

  async analyze(req: WaiverRequest): Promise<WaiverAnalysis> {
    const b = await this.ensure("rosters");
    await this.loadCachedNews();
    const started = performance.now();
    const horizon: Horizon = req.horizon ?? "auto";
    const weights = horizonWeights(b, horizon);
    const mine = b.rosters.find((r) => r.rosterId === b.me)!;
    const ctx: SearchContext = {
      base: b.base,
      table: b.table,
      weights,
      mine,
      irEligible: b.irEligibleMine,
      locked: b.locked,
      startWeek: (id) => this.availability(b, id).startWeek,
      canDrop: (add, drop) => this.canDrop(b, add, drop),
      weekZero: b.weekZero.get(b.me),
    };
    const query: WaiverQuery = {
      keep: req.keep,
      positions: req.positions,
      add: req.add ?? null,
      drop: req.drop ?? null,
    };

    const result = await findMoves(ctx, query);
    const cuts = cutCandidates(b.base, b.table, mine, weights, new Set(req.keep ?? []), b.weekZero.get(b.me));
    const view = (m: WaiverMove, pool: WaiverMove[] = result.moves) => this.moveView(b, m, pool, cuts);
    const steps = await buildPlan({
      ctx,
      query,
      availability: (id) => this.availability(b, id),
      bid: (m, alternatives) => this.bid(b, m, alternatives),
      lineup: b.lineup,
      healthyInIr: b.healthyInIr,
      irEligible: b.irEligibleMine,
      returns: b.returns,
    });

    const streams: StreamWeekView[] = [0, 1]
      .filter((i) => i < b.base.weeks.length)
      .map((i) => ({
        week: b.base.weeks[i]!,
        holes: (b.holesBy.get(b.me)?.get(i) ?? []).map((h) => holeLine(b.base, h)),
        streams: streamsForWeek(b.base, b.table, mine, i, {
          startWeek: (id) => this.availability(b, id).startWeek,
          weekZero: b.weekZero.get(b.me),
        })
          .slice(0, 8)
          .map((s) => ({
            player: this.card(b, s.add)!,
            gain: s.gain,
            points: s.points,
            replaces: s.replaces ? this.name(b, s.replaces) : null,
            availability: this.availabilityView(b, s.add),
          })),
      }));

    return {
      horizon,
      weights: weights.map(round2),
      plan: steps.map((s) => this.stepView(b, s, result.moves, cuts, weights)),
      moves: result.moves.map((m) => view(m)),
      proposal: result.proposal ? view(result.proposal) : null,
      streams,
      considered: result.considered,
      evaluated: result.evaluated,
      elapsedMs: Math.round(performance.now() - started),
      notes: result.notes,
      news: this.newsLoaded ? { summary: this.newsSummary } : null,
    };
  }

  // -------------------------------------------------------------------------
  // News: a background job over the current shortlist
  // -------------------------------------------------------------------------

  async startNews(req: WaiverRequest): Promise<NewsJobView> {
    if (!this.newsProvider) throw new Error("The news check is not available in this mode.");
    // Take the slot before the first await: two clicks at once must start one
    // paid call, not two.
    if (this.newsRun || this.news.status === "running") return this.news;
    // The job view's status is about this job; its notes are always today's.
    this.news = { ...this.jobContent(), status: "running", startedAt: this.now() };
    let analysis: WaiverAnalysis;
    try {
      analysis = await this.analyze(req);
    } catch (err) {
      this.news = {
        ...this.jobContent(),
        status: "error",
        startedAt: this.news.startedAt,
        finishedAt: this.now(),
        error: err instanceof Error ? err.message : String(err),
      };
      throw err;
    }
    const b = this.built!;
    const moves = analysis.moves.slice(0, config.waiver.newsCandidates);
    const candidates = new Map<string, NewsCandidate>();
    const put = (card: PlayerCard | null, role: NewsCandidate["role"], context: string) => {
      if (!card || candidates.has(card.playerId)) return;
      candidates.set(card.playerId, {
        playerId: card.playerId,
        name: card.name,
        position: card.position,
        team: card.team,
        role,
        context,
      });
    };
    for (const m of moves) {
      put(m.add, "add", `${m.add.perWeek.toFixed(1)} pts/wk projected${m.add.injuryStatus ? `, listed ${m.add.injuryStatus}` : ""}`);
      if (m.drop) put(m.drop, "drop", `${m.drop.perWeek.toFixed(1)} pts/wk; cutting him costs the lineup ~nothing`);
    }
    const mine = b.rosters.find((r) => r.rosterId === b.me)!;
    for (const id of mine.players) {
      const p = b.base.players.get(id);
      if (p?.injuryStatus && !mine.reserve.includes(id)) put(this.card(b, id), "starter", `yours; listed ${p.injuryStatus}`);
    }

    const today = easternDate(new Date(this.now()));
    const provider = this.newsProvider;
    if (!candidates.size) {
      this.news = { ...this.jobContent(), status: "done", startedAt: this.news.startedAt, finishedAt: this.now() };
      return this.news;
    }
    this.newsRun = (async () => {
      try {
        const out = await provider.check({
          today,
          leagueLine: `${b.data.league.name}, ${b.rosters.length} teams, ${describeScoring(b.data.league.scoring_settings)}, FAAB.`,
          teamLine: `My team is ${record(b.data.rosters.find((r) => r.roster_id === b.me))} with ${pct(b.leverage.playoffOdds)} playoff odds.`,
          candidates: [...candidates.values()],
          moves: moves.map((m) => ({
            add: m.add.playerId,
            drop: m.drop?.playerId ?? null,
            summary: `+${m.gain.toFixed(1)} pts/wk weighted, ${m.kind === "stream" ? `a week ${m.peakWeek} stream` : "a hold"}`,
          })),
        });
        if (this.newsDay !== today) this.resetNews(today);
        for (const it of out.items) this.newsNotes.set(it.playerId, it);
        for (const v of out.verdicts) this.newsVerdicts.set(v.add, v);
        this.newsSummary = out.summary ?? this.newsSummary;
        this.newsLoaded = true;
        this.news = {
          ...this.jobContent(),
          status: "done",
          startedAt: this.news.startedAt,
          finishedAt: this.now(),
          error: null,
          costUsd: out.costUsd,
          searches: out.searches,
          cachedPlayers: out.cachedPlayers,
        };
      } catch (err) {
        this.news = {
          ...this.jobContent(),
          status: "error",
          startedAt: this.news.startedAt,
          finishedAt: this.now(),
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        this.newsRun = null;
      }
    })();
    return this.news;
  }

  newsStatus(): NewsJobView {
    return this.news;
  }

  /** Forget another day's notes - yesterday's news is not news. */
  private resetNews(day: string): void {
    this.newsNotes.clear();
    this.newsVerdicts.clear();
    this.newsSummary = null;
    this.newsLoaded = false;
    this.newsDay = day;
    // Never touch a check that is starting or running - that view is its claim
    // on the one paid call allowed at a time.
    if (!this.newsRun && this.news.status !== "running") this.news = emptyJob();
  }

  /** Today's notes from an earlier run (or an earlier process) cost nothing to show. */
  private async loadCachedNews(): Promise<void> {
    if (!this.newsProvider) return;
    const today = easternDate(new Date(this.now()));
    if (this.newsDay !== today) this.resetNews(today);
    if (this.newsLoaded) return;
    try {
      const c = await this.newsProvider.cached(today);
      for (const it of c.items) if (it.note) this.newsNotes.set(it.playerId, it);
      for (const v of c.verdicts) this.newsVerdicts.set(v.add, v);
      this.newsSummary = c.summary;
      this.newsLoaded = c.items.length > 0 || c.verdicts.length > 0;
      if (this.newsLoaded && this.news.status === "idle") this.news = { ...this.jobContent(), status: "done" };
    } catch {
      // A missing or unreadable cache is just no news yet.
    }
  }

  private jobContent(): NewsJobView {
    const name = (id: string) => this.built?.base.players.get(id)?.name ?? id;
    return {
      ...emptyJob(),
      summary: this.newsSummary,
      items: [...this.newsNotes.values()].filter((i) => i.note).map((i) => ({ playerId: i.playerId, name: name(i.playerId), note: i.note, outlook: i.outlook })),
      verdicts: [...this.newsVerdicts.values()].map((v) => ({ add: v.add, name: name(v.add), verdict: v.verdict, reason: v.reason })),
    };
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async ensure(level: "rosters" | "all"): Promise<Built> {
    if (this.loading) {
      // A refresh asked for while a rosters-only update runs must still happen.
      if (level === "all" && this.loadingLevel !== "all") {
        await this.loading.catch(() => {});
        return this.ensure("all");
      }
      return this.loading;
    }
    const fresh = this.built && this.now() - this.built.rostersAt < config.trade.rosterMaxAgeMs;
    // A server left up overnight moves on with the calendar: a new Eastern day
    // means new "already played" games and, sometimes, a new NFL week.
    const newDay = this.built != null && this.built.loadedOn !== easternDate(new Date(this.now()));
    if (this.built && level === "rosters" && fresh && !newDay) return this.built;

    const previous = this.built;
    this.loadingLevel = level === "all" || !previous || newDay ? "all" : "rosters";
    this.loading = (async () => {
      try {
        let data: TradeData;
        let extras: WaiverExtras;
        if (this.loadingLevel === "all" || !previous) {
          data = await this.source.load(level === "all");
          extras = await this.extrasSource.load(data, level === "all");
        } else {
          try {
            const { rosters, users } = await this.source.rosters();
            data = { ...previous.data, rosters, users };
            extras = await this.extrasSource.refresh(data, previous.extras);
          } catch (err) {
            // Minute-old rosters are almost always still right; next call retries.
            console.warn(`[waivers] refresh failed, using cached: ${err instanceof Error ? err.message : err}`);
            return previous;
          }
        }
        this.built = build(data, extras, this.now());
        return this.built;
      } finally {
        this.loading = null;
        this.loadingLevel = null;
      }
    })();
    return this.loading;
  }

  // -------------------------------------------------------------------------
  // View helpers
  // -------------------------------------------------------------------------

  private availability(b: Built, id: string): Availability {
    let a = b.availability.get(id);
    if (!a) {
      a = availabilityOf(id, b.base.players.get(id)?.team ?? null, {
        calendar: b.calendar,
        schedule: b.extras.schedule,
        nflWeek: b.data.nflWeek,
        activity: b.extras.activity,
      });
      b.availability.set(id, a);
    }
    return a;
  }

  /**
   * Can `drop` be cut when the claim on `add` processes? Bench lock is checked
   * at that moment - an instant add now, a fresh-drop claim ~23h out (still this
   * week), and nothing at all for a claim in the next weekly run.
   */
  private canDrop(b: Built, add: string, drop: string): boolean {
    const a = this.availability(b, add);
    const when = a.mode === "free_agent" ? this.now() : (a.processesAt ?? this.now());
    if (when >= b.calendar.nextRun) return true;
    return !gameStarted(b.base.players.get(drop)?.team ?? null, b.data.nflWeek, b.extras.schedule, when);
  }

  private availabilityView(b: Built, id: string): AvailabilityView {
    const a = this.availability(b, id);
    const label =
      a.mode === "free_agent"
        ? `Free agent - add now${a.locksAt ? `, locks ~${formatEt(a.locksAt)}` : ""}`
        : a.mode === "waivers"
          ? `On waivers until ~${formatEt(a.processesAt!)}`
          : `Locked - claim in the ${formatEt(a.processesAt!)} run`;
    return { mode: a.mode, label, processesAt: a.processesAt, locksAt: a.locksAt };
  }

  private bid(b: Built, m: WaiverMove, alternatives: WaiverMove[]): BidAdvice | null {
    if (b.data.league.settings?.waiver_type !== 2) return null;
    const a = this.availability(b, m.add);
    if (a.mode === "free_agent" && !canWait(m)) return null;
    const pos = b.base.players.get(m.add)?.position ?? "";
    const week = canWait(m) ? m.peakWeek : a.startWeek;
    const rivals = [...(b.holesBy.entries())]
      .filter(([rid, byWeek]) => rid !== b.me && (byWeek.get(week) ?? []).some((h) => h.eligible.includes(pos)))
      .map(([rid]) => rid)
      .filter((rid) => (b.market.budgets.get(rid) ?? 0) > 0 || (b.market.priority.get(rid) ?? 99) < (b.market.priority.get(b.me) ?? 99));
    const bestAlt = alternatives.reduce((best, x) => Math.max(best, x.gainTotal), 0);
    const similar = alternatives.filter((x) => x.gainTotal >= m.gainTotal * 0.8).map((x) => this.name(b, x.add));
    return suggestBid({
      market: b.market,
      me: b.me,
      position: pos,
      alternatives: similar,
      demand: {
        trendingAdds: b.extras.activity.trendingAdds.get(m.add) ?? 0,
        freshDrop: a.mode === "waivers",
        rivalsWithHole: rivals,
      },
      worthPoints: Math.max(0, m.gainTotal - bestAlt),
      playoffOdds: b.leverage.playoffOdds,
    });
  }

  private card(b: Built, id: string): PlayerCard | null {
    const p = b.base.players.get(id);
    if (!p) return null;
    const raw = b.data.players[id];
    const images = playerImages(
      raw ?? { player_id: id, espn_id: null, first_name: null, last_name: null, full_name: p.name, position: p.position },
    );
    const weeks = Math.max(1, b.base.weeks.length);
    return {
      playerId: id,
      name: p.name,
      position: p.position,
      team: p.team,
      injuryStatus: p.injuryStatus,
      perWeek: round1(p.rosTotal / weeks),
      weekly: p.weekly.map(round1),
      strip: scheduleStrip(b.base, id, b.extras.schedule),
      usage: usageLine(b.extras.usage.lines.get(id)),
      trendingAdds: b.extras.activity.trendingAdds.get(id) ?? null,
      trendingDrops: b.extras.activity.trendingDrops.get(id) ?? null,
      photo: images.primary,
      photoFallback: images.fallback,
      initials: images.initials,
    };
  }

  private moveView(b: Built, m: WaiverMove, pool: WaiverMove[], cuts: Cut[]): MoveView {
    // The options that make him replaceable: the folded streams for the same
    // week, or for a hold the other listed adds at his position.
    const pos = b.base.players.get(m.add)?.position;
    const alternatives = m.alternatives.length
      ? m.alternatives
      : pool.filter((x) => x.add !== m.add && b.base.players.get(x.add)?.position === pos).slice(0, 3);
    const note = this.newsNotes.get(m.add);
    const verdict = this.newsVerdicts.get(m.add);
    return {
      key: `${m.add}>${m.drop ?? ""}`,
      add: this.card(b, m.add)!,
      drop: m.drop ? this.card(b, m.drop) : null,
      irMove: m.irMove ? this.card(b, m.irMove) : null,
      gain: round2(m.gain),
      gainTotal: round1(m.gainTotal),
      gainThisWeek: round1(m.gainThisWeek),
      pointsTotal: round1(m.pointsTotal),
      weeklyDelta: m.weeklyDelta.map(round1),
      kind: m.kind,
      peakWeek: b.base.weeks[m.peakWeek] ?? 0,
      peakShare: round2(m.peakShare),
      canWait: canWait(m),
      startWeek: m.startWeek,
      availability: this.availabilityView(b, m.add),
      bid: this.bid(b, m, alternatives),
      reasons: moveReasons(
        {
          u: b.base,
          cuts,
          holes: b.holesBy.get(b.me) ?? new Map(),
          managerName: (rid) => this.teamName(b, rid),
          formatTime: formatEt,
        },
        m,
        this.availability(b, m.add),
      ),
      dropOptions: m.dropOptions.map((o) => ({ player: o.playerId ? this.card(b, o.playerId) : null, gain: round2(o.gain) })),
      alternatives: m.alternatives.map((x) => ({
        player: this.card(b, x.add)!,
        gain: round2(x.gain),
        availability: this.availabilityView(b, x.add),
      })),
      news: note?.note ? { note: note.note, outlook: note.outlook } : null,
      verdict: verdict ? { verdict: verdict.verdict, reason: verdict.reason } : null,
    };
  }

  private stepView(b: Built, s: PlanStep, pool: WaiverMove[], cuts: Cut[], weights: number[]): PlanStepView {
    const name = (id: string | null) => (id ? this.name(b, id) : "nobody");
    // A step's reasons ("dead weight", "costs 0.3/wk") are about the roster it
    // was planned on, after the steps before it - not the roster you have now.
    const stepCuts =
      "roster" in s && s.roster
        ? cutCandidates(b.base, b.table, s.roster, weights, new Set(), b.weekZero.get(b.me))
        : cuts;
    const mv = (m: WaiverMove) => this.moveView(b, m, pool, stepCuts);
    switch (s.kind) {
      case "lineup":
        return {
          kind: "lineup",
          text: `Fix your week ${b.data.nflWeek} lineup: start ${s.fix.start.map((x) => name(x.playerId)).join(", ")}${s.fix.sit.length ? `; sit ${s.fix.sit.map((x) => name(x.playerId)).join(", ")}` : ""} (+${s.fix.gain.toFixed(1)} pts)`,
          start: s.fix.start.map((x) => this.card(b, x.playerId)!).filter(Boolean),
          sit: s.fix.sit.map((x) => this.card(b, x.playerId)!).filter(Boolean),
          gain: s.fix.gain,
        };
      case "ir-healthy":
        return {
          kind: "ir-healthy",
          text: `Move ${name(s.playerId)} out of IR - he no longer has an IR designation${
            s.cut ? (s.cut === s.playerId ? `; with a full roster, cutting him costs least` : `; cut ${name(s.cut)} to make room`) : ""
          }`,
          player: this.card(b, s.playerId)!,
        };
      case "ir-move":
        return { kind: "ir-move", text: `Move ${name(s.playerId)} to IR to open a roster spot`, player: this.card(b, s.playerId)! };
      case "add": {
        const v = mv(s.move);
        return {
          kind: "add",
          text: `Add ${name(s.move.add)}${s.move.drop ? `, drop ${name(s.move.drop)}` : ""} - free agent, no bid needed${s.availability.locksAt ? ` (locks ~${formatEt(s.availability.locksAt)})` : ""}`,
          move: v,
        };
      }
      case "claim": {
        // The step's bid is the one to place; a fallback bidding more would
        // process first, so each is capped at the primary's.
        const v = { ...mv(s.move), bid: s.bid };
        const bid = s.bid ? `$${s.bid.amount}` : "a claim";
        const cap = s.bid?.amount ?? 0;
        return {
          kind: "claim",
          text: `Claim ${name(s.move.add)} for ${bid}${s.move.drop ? `, dropping ${name(s.move.drop)}` : ""} - processes ~${formatEt(s.availability.processesAt ?? b.calendar.nextRun)}${s.fallbacks.length ? `; if you lose him, ${s.fallbacks.map((f) => name(f.add)).join(", then ")} at no more than ${bid}` : ""}`,
          move: v,
          fallbacks: s.fallbacks.map((f) => {
            const fv = mv(f);
            return fv.bid && fv.bid.amount > cap ? { ...fv, bid: { ...fv.bid, amount: cap } } : fv;
          }),
        };
      }
      case "later": {
        const v = { ...mv(s.move), bid: s.bid };
        const pos = b.base.players.get(s.move.add)?.position ?? "";
        const h = s.holes[0];
        const hole = h ? `${h.slot} hole (${name(h.usual)} ${h.reason === "bye" ? "on bye" : h.reason})` : `${pos} upgrade`;
        const others = s.alternatives.length ? ` (or ${s.alternatives.map((a) => name(a.add)).join(", ")})` : "";
        const free = s.availability.mode === "free_agent";
        const cutText = s.cut ? `cutting ${name(s.cut)}` : "using your open spot";
        // When grabbing him now costs nothing, say that first: waiting only
        // risks losing him to the next run.
        const text =
          free && s.nowCost < 0.1
            ? `Week ${s.week} ${hole}: add ${name(s.move.add)}${others} now for $0 - ${cutText} costs you nothing. Or wait and claim him after he locks, in the ${formatEt(b.calendar.nextRun)} run${s.bid ? ` (~$${s.bid.amount})` : ""}.`
            : `Week ${s.week} ${hole}: ${name(s.move.add)}${others} is the best fill. It can wait for the ${formatEt(b.calendar.nextRun)} run${s.bid ? ` (bid ~$${s.bid.amount} once he locks)` : ""} - adding him now means ${cutText}, which costs ~${s.nowCost.toFixed(1)} pts/wk.`;
        return {
          kind: "later",
          text,
          week: s.week,
          move: v,
          alternatives: s.alternatives.map(mv),
          nowCost: s.nowCost,
        };
      }
      case "return":
        return {
          kind: "return",
          text: `${name(s.playerId)} is projected back from IR in week ${s.week}${s.cut ? ` - you will need to cut someone (cheapest: ${name(s.cut)})` : ""}`,
          week: s.week,
          player: this.card(b, s.playerId)!,
          cut: s.cut ? this.card(b, s.cut) : null,
        };
    }
  }

  private teamLine(b: Built, r: TeamRoster): TeamLine {
    const raw = b.data.rosters.find((x) => x.roster_id === r.rosterId);
    const user = this.user(b, r.rosterId);
    const s = raw?.settings ?? {};
    const holes = [0, 1].flatMap((i) => (b.holesBy.get(r.rosterId)?.get(i) ?? []).map((h) => `wk${b.base.weeks[i]} ${h.slot}`));
    return {
      rosterId: r.rosterId,
      teamName: this.teamName(b, r.rosterId),
      manager: this.managerName(b, r.rosterId),
      avatar: avatarUrl(user),
      isMe: r.rosterId === b.me,
      record: record(raw),
      pointsFor: (s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100,
      faabLeft: b.data.league.settings?.waiver_type === 2 ? (b.market.budgets.get(r.rosterId) ?? 0) : null,
      priority: b.market.priority.get(r.rosterId) ?? null,
      // Your own row uses the same (larger) simulation as your header.
      playoffOdds: round3(r.rosterId === b.me ? b.leverage.playoffOdds : (b.playoffOdds.get(r.rosterId) ?? 0)),
      holes: [...new Set(holes)],
    };
  }

  private user(b: Built, rosterId: number): LeagueUser | undefined {
    const raw = b.data.rosters.find((x) => x.roster_id === rosterId);
    return b.data.users.find((u) => u.user_id === raw?.owner_id);
  }

  private managerName(b: Built, rosterId: number): string {
    const user = this.user(b, rosterId);
    return user?.display_name ?? user?.username ?? `Roster ${rosterId}`;
  }

  private teamName(b: Built, rosterId: number): string {
    const user = this.user(b, rosterId);
    return (user?.metadata?.team_name as string | undefined) || user?.display_name || `Team ${rosterId}`;
  }

  private name(b: Built, id: string): string {
    return b.base.players.get(id)?.name ?? id;
  }
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

function build(data: TradeData, extras: WaiverExtras, now: number): Built {
  const rosters: TeamRoster[] = data.rosters.map((r) => ({
    rosterId: r.roster_id,
    players: [...(r.players ?? [])],
    reserve: [...(r.reserve ?? [])],
  }));
  const mineRaw = data.rosters.find((r) => r.owner_id === data.userId || (r.co_owners ?? []).includes(data.userId));
  if (!mineRaw) throw new Error("You do not have a roster in this league.");
  const me = mineRaw.roster_id;
  const settings = data.league.settings ?? {};

  const base = buildUniverse({
    league: data.league,
    rosters,
    players: data.players,
    weekly: data.weekly,
    weeks: data.weeks,
    byeWeek: data.byeWeek,
    played: data.played,
  });
  // Byes the projections did not mark (defenses, mostly) come from the schedule.
  for (const p of base.players.values()) {
    if (p.byeWeek != null || !p.team) continue;
    const games = extras.schedule[p.team];
    if (!games) continue;
    const bye = base.weeks.find((w) => !games[w]);
    if (bye != null) p.byeWeek = bye;
  }
  const table = floorTable(base);
  const mine = rosters.find((r) => r.rosterId === me)!;

  // This week as Sleeper will let each team play it: who has kicked off holds
  // his slot, and only the open slots are still to play.
  const weekZero = new Map<number, WeekZero>();
  for (const r of data.rosters) {
    const ids = r.players ?? [];
    const lockedIds = new Set(ids.filter((id) => gameStarted(base.players.get(id)?.team ?? null, data.nflWeek, extras.schedule, now)));
    weekZero.set(r.roster_id, weekZeroOf(base, data.league.roster_positions, r.starters ?? [], lockedIds));
  }

  // The season: every team's expected lineup with normal streaming (the trade
  // universe's floor) - rivals do stream, and so would you. This week counts
  // only the slots still to play; what has been scored is added from Sleeper.
  const expected = new Map(rosters.map((r) => [r.rosterId, weeklyPoints(base, r.players, weekZero.get(r.rosterId))]));
  const standings = new Map(
    data.rosters.map((r) => [
      r.roster_id,
      {
        wins: r.settings?.wins ?? 0,
        losses: r.settings?.losses ?? 0,
        ties: r.settings?.ties ?? 0,
        pointsFor: (r.settings?.fpts ?? 0) + (r.settings?.fpts_decimal ?? 0) / 100,
      },
    ]),
  );
  const season: SeasonInput = {
    weeks: base.weeks,
    lastRegularWeek: (settings.playoff_week_start ?? lastFantasyWeek(data.league) + 1) - 1,
    playoffTeams: settings.playoff_teams ?? 6,
    rosterIds: rosters.map((r) => r.rosterId),
    standings,
    schedule: extras.matchups,
    expected,
    scoredThisWeek: extras.scoredThisWeek,
    sd: config.waiver.weeklySd,
    sims: config.waiver.sims,
  };
  const leverage = weekLeverage(season, me, config.waiver.winValue);
  const playoffOdds = simulateSeason({ ...season, sims: Math.min(2000, config.waiver.sims) }).playoffs;

  const calendar = waiverCalendar(extras.activity, settings, now);
  const market = faabMarket({
    activity: extras.activity,
    budget: settings.waiver_budget ?? 0,
    rosters: data.rosters.map((r) => ({
      rosterId: r.roster_id,
      budgetUsed: r.settings?.waiver_budget_used ?? 0,
      waiverPosition: r.settings?.waiver_position ?? null,
    })),
    positionOf: (id) => data.players[id]?.position ?? null,
  });

  const locked = new Set(
    mine.players.filter((id) => gameStarted(base.players.get(id)?.team ?? null, data.nflWeek, extras.schedule, now)),
  );
  const reserveFree = Math.max(0, base.reserveLimit - mine.reserve.length);
  // Only players projected out this week: moving a Doubtful starter who may
  // still play to IR would cost his points (an IR slot does not score).
  const irEligibleMine = reserveFree
    ? activePlayers(mine).filter(
        (id) => irEligible(data.players[id], settings) && !locked.has(id) && (base.players.get(id)?.weekly[0] ?? 0) <= 0,
      )
    : [];
  const healthyInIr = mine.reserve.filter((id) => !irEligible(data.players[id], settings));
  const returns = mine.reserve
    .filter((id) => !healthyInIr.includes(id))
    .map((id) => ({ playerId: id, weekIndex: returnWeek({ base }, id) ?? -1 }))
    .filter((r) => r.weekIndex >= 0);

  const holesBy = new Map<number, Map<number, Hole[]>>();
  for (const r of rosters) {
    const byWeek = new Map<number, Hole[]>();
    for (const i of [0, 1]) {
      if (i < base.weeks.length) byWeek.set(i, holesForWeek(base, table, r, i, weekZero.get(r.rosterId)));
    }
    holesBy.set(r.rosterId, byWeek);
  }

  return {
    data,
    extras,
    base,
    table,
    rosters,
    me,
    calendar,
    market,
    leverage,
    playoffOdds,
    locked,
    irEligibleMine,
    healthyInIr,
    returns,
    lineup: lineupCheck(base, table, mine, mineRaw.starters ?? [], data.league.roster_positions, locked),
    availability: new Map(),
    holesBy,
    weekZero,
    rostersAt: now,
    loadedOn: easternDate(new Date(now)),
  };
}

/** Week weights for a horizon. */
function horizonWeights(b: Built, horizon: Horizon): number[] {
  const weeks = b.base.weeks;
  const playoffStart = b.data.league.settings?.playoff_week_start ?? null;
  switch (horizon) {
    case "week":
      return weeks.map((_, i) => (i === 0 ? 1 : 0));
    case "season":
      return weeks.map(() => 1);
    case "playoffs": {
      const w = weeks.map((wk) => (playoffStart != null && wk >= playoffStart ? 1 : 0));
      return w.some((x) => x > 0) ? w : weeks.map(() => 1);
    }
    default:
      return b.leverage.weights;
  }
}

function leverageNote(b: Built): string {
  const l = b.leverage;
  const weeks = b.base.weeks;
  const top = l.weights
    .map((w, i) => ({ w, week: weeks[i]! }))
    .sort((a, c) => c.w - a.w)
    .slice(0, 3)
    .map((x) => x.week)
    .sort((a, c) => a - c);
  return (
    `Playoff odds ${pct(l.playoffOdds)}, title odds ${pct(l.titleOdds)} from ${config.waiver.sims.toLocaleString()} simulated seasons. ` +
    `A point matters most in weeks ${top.join(", ")}.`
  );
}

function record(raw: Roster | undefined): string {
  const s = raw?.settings ?? {};
  return `${s.wins ?? 0}-${s.losses ?? 0}${s.ties ? `-${s.ties}` : ""}`;
}

/** Sleeper avatars: a custom team image URL when set, else the account avatar. */
function avatarUrl(user: LeagueUser | undefined): string | null {
  const custom = user?.metadata?.avatar;
  if (typeof custom === "string" && custom.startsWith("http")) return custom;
  return user?.avatar ? `${config.sleeper.cdnBase}/avatars/thumbs/${user.avatar}` : null;
}

/** "Wed 3:08am ET" */
export function formatEt(epochMs: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epochMs));
  return `${parts.replace(" AM", "am").replace(" PM", "pm")} ET`;
}

function emptyJob(): NewsJobView {
  return {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    error: null,
    costUsd: 0,
    searches: 0,
    cachedPlayers: 0,
    summary: null,
    items: [],
    verdicts: [],
  };
}

const ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];
const POSITION_ORDER = (pos: string) => {
  const i = ORDER.indexOf(pos);
  return i < 0 ? ORDER.length : i;
};

const pct = (p: number): string => (p > 0 && p < 0.01 ? "under 1%" : `about ${Math.round(p * 100)}%`);
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
export { fmtCount };
