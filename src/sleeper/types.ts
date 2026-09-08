/**
 * Sleeper API types.
 *
 * Field names were recovered from typed open-source clients generated against real
 * API responses (primarily github.com/lum8rjack/sleeper-go). The Sleeper API is
 * read-only and requires no auth. Documented rate limit: stay under 1000 calls/min.
 *
 * Anything Sleeper may omit is typed optional/nullable — the live payloads are far
 * looser than the docs suggest, and a draft assistant must not crash on a null.
 */

export type NflTeam = string; // "KC", "SF", ... ; null for free agents
export type PlayerId = string; // Sleeper's own id, e.g. "4046"; also "KC" for DEF

/** GET /v1/players/nfl — a map of player_id -> Player. ~5MB; fetch at most once/day. */
export type PlayersIndex = Record<PlayerId, Player>;

export interface Player {
  player_id: PlayerId;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  /** Primary position: QB/RB/WR/TE/K/DEF, plus non-fantasy positions. */
  position?: string | null;
  /** Roster slots the player is eligible for — handles dual eligibility. */
  fantasy_positions?: string[] | null;
  team?: NflTeam | null;
  status?: string | null; // "Active", "Inactive", "Injured Reserve", ...
  active?: boolean | null;
  age?: number | null;
  years_exp?: number | null;
  number?: number | null;
  height?: string | null;
  weight?: string | null;
  college?: string | null;
  depth_chart_position?: string | null;
  depth_chart_order?: number | null;
  injury_status?: string | null; // "Questionable" | "Doubtful" | "Out" | "IR" | "PUP" | "Sus"
  injury_body_part?: string | null;
  injury_notes?: string | null;
  practice_participation?: string | null;
  practice_description?: string | null;
  news_updated?: number | null; // epoch ms
  /** Sleeper's own overall relevance ordering. Lower = more relevant. Our fallback value signal. */
  search_rank?: number | null;
  search_full_name?: string | null;
  espn_id?: number | null;
  yahoo_id?: number | null;
  rotowire_id?: number | null;
  sportradar_id?: string | null;
  gsis_id?: string | null;
}

/** GET /v1/league/{league_id} */
export interface League {
  league_id: string;
  name: string;
  season: string;
  season_type: string;
  status: string; // "pre_draft" | "drafting" | "in_season" | "complete"
  sport: string;
  total_rosters: number;
  /** Ordered slot list, e.g. ["QB","RB","RB","WR","WR","TE","FLEX","K","DEF","BN",...] */
  roster_positions: string[];
  scoring_settings: ScoringSettings;
  settings: LeagueSettings;
  draft_id: string;
  previous_league_id?: string | null;
  avatar?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Scoring is an open map: Sleeper adds keys (bonus_rec_te, bonus_rush_yd_100, ...)
 * that no fixed interface captures. We name the common ones for readability and
 * accept the rest, so league-accurate scoring works without a schema update.
 */
export interface ScoringSettings extends Record<string, number | undefined> {
  pass_yd?: number;
  pass_td?: number;
  pass_int?: number;
  pass_2pt?: number;
  rush_yd?: number;
  rush_td?: number;
  rush_2pt?: number;
  /** Points per reception: 1 = full PPR, 0.5 = half, 0/absent = standard. */
  rec?: number;
  rec_yd?: number;
  rec_td?: number;
  rec_2pt?: number;
  fum_lost?: number;
  bonus_rec_te?: number;
}

export interface LeagueSettings extends Record<string, number | undefined> {
  num_teams?: number;
  draft_rounds?: number;
  playoff_week_start?: number;
  playoff_teams?: number;
  max_keepers?: number;
  /** 0 = redraft, 1 = keeper, 2 = dynasty (verify against your league). */
  type?: number;
  best_ball?: number;
}

/** GET /v1/league/{league_id}/rosters */
export interface Roster {
  roster_id: number;
  owner_id: string | null;
  league_id: string;
  players: PlayerId[] | null;
  starters: PlayerId[] | null;
  reserve?: PlayerId[] | null;
  taxi?: PlayerId[] | null;
  keepers?: PlayerId[] | null;
  co_owners?: string[] | null;
  settings?: Record<string, number> | null;
}

/** GET /v1/league/{league_id}/users */
export interface LeagueUser {
  user_id: string;
  username?: string | null;
  display_name?: string | null;
  avatar?: string | null;
  is_bot?: boolean | null;
  is_owner?: boolean | null;
  metadata?: { team_name?: string | null } & Record<string, unknown>;
}

/** GET /v1/draft/{draft_id} */
export interface Draft {
  draft_id: string;
  /** Null for mock drafts - the reliable tell that a draft IS a mock. */
  league_id: string | null;
  sport: string;
  season: string;
  season_type: string;
  type: "snake" | "linear" | "auction" | string;
  status: "pre_draft" | "drafting" | "paused" | "complete" | string;
  start_time?: number | null; // epoch ms
  created?: number | null;
  last_picked?: number | null; // epoch ms — cheap change detector
  last_message_time?: number | null;
  /** user_id -> draft slot (1-indexed). Null until the order is set. */
  draft_order: Record<string, number> | null;
  /** slot (as string) -> roster_id */
  slot_to_roster_id: Record<string, number> | null;
  settings: DraftSettings;
  metadata?: { name?: string; description?: string; scoring_type?: string } | null;
}

export interface DraftSettings extends Record<string, number | undefined> {
  teams?: number;
  rounds?: number;
  pick_timer?: number; // seconds
  /** 0 = pure snake. N>0 = order reverses again starting at round N (e.g. 3RR). */
  reversal_round?: number;
  slots_qb?: number;
  slots_rb?: number;
  slots_wr?: number;
  slots_te?: number;
  slots_flex?: number;
  slots_k?: number;
  slots_def?: number;
  slots_bn?: number;
  cpu_autopick?: number;
  nomination_timer?: number;
}

/** GET /v1/draft/{draft_id}/picks */
export interface DraftPick {
  draft_id: string;
  /** Overall pick number, 1-indexed. */
  pick_no: number;
  round: number;
  draft_slot: number;
  roster_id: number | null;
  player_id: PlayerId;
  /** user_id of the picker; empty/null for autopick. */
  picked_by?: string | null;
  is_keeper?: boolean | null;
  /** Denormalized snapshot of the player at pick time — fine for display, join for logic. */
  metadata?: {
    first_name?: string;
    last_name?: string;
    position?: string;
    team?: string;
    status?: string;
    injury_status?: string;
    years_exp?: string;
    number?: string;
  } | null;
}

/** GET /v1/draft/{draft_id}/traded_picks */
export interface TradedPick {
  season: string;
  round: number;
  /** The roster whose original pick this is. */
  roster_id: number;
  /** Who owns it now. */
  owner_id: number;
  previous_owner_id?: number | null;
}

/** GET /v1/state/nfl */
export interface NflState {
  week: number;
  season: string;
  season_type: string; // "pre" | "regular" | "post" | "off"
  leg?: number;
  display_week?: number;
  season_start_date?: string;
  previous_season?: string;
}

/** GET /v1/players/nfl/trending/{add|drop} */
export interface TrendingPlayer {
  player_id: PlayerId;
  count: number;
}

/** Fantasy-relevant positions we rank. */
export const FANTASY_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
export type FantasyPosition = (typeof FANTASY_POSITIONS)[number];

export function isFantasyPosition(p: string | null | undefined): p is FantasyPosition {
  return p != null && (FANTASY_POSITIONS as readonly string[]).includes(p);
}
