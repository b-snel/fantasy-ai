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
import { getRosProjections, rosWindow, type RosSource } from "../data/ros.ts";
import { playerImages } from "../data/photos.ts";
import { describeScoring } from "../engine/scoring.ts";
import { buildUniverse, type TeamRoster, type TradeUniverse } from "../trade/value.ts";
import { findTrades, type TradeEval, type TradeSort } from "../trade/search.ts";
import { explainTrade, profileLeague, rankedPositions, type TeamProfile } from "../trade/explain.ts";
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

/** What the server routes need. The demo and tests provide their own. */
export interface TradeProvider {
  overview(opts?: { refresh?: boolean }): Promise<TradeOverview>;
  analyze(req: TradeRequest): Promise<TradeAnalysis>;
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

  constructor(
    private readonly source: TradeDataSource = liveTradeSource(),
    private readonly now: () => number = Date.now,
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

const ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];
const POSITION_ORDER = (pos: string) => {
  const i = ORDER.indexOf(pos);
  return i < 0 ? ORDER.length : i;
};

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
