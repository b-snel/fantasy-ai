/**
 * Central configuration. Tunables live here so draft-day adjustments are one edit,
 * not a hunt through the engine.
 */

export const config = {
  leagueId: process.env.SLEEPER_LEAGUE_ID ?? "1348178795533701120",
  userId: process.env.SLEEPER_USER_ID ?? "434221843767881728",
  username: "tugger_woods",

  /**
   * Follow a specific draft instead of the league's own — this is how you point
   * the assistant at a mock: create a league mock in Sleeper, then
   * `SLEEPER_DRAFT_ID=<id> bun start`. Scoring, rosters and projections still
   * come from the league above; only the draft being tracked changes.
   */
  draftId: process.env.SLEEPER_DRAFT_ID ?? null,

  port: Number(process.env.PORT ?? 5173),

  sleeper: {
    /** Documented, stable API. */
    apiBase: "https://api.sleeper.app/v1",
    /**
     * Undocumented host (note: .com, not .app) serving projections/stats/schedule.
     * Community-discovered, explicitly "not meant for consumers", and may vanish.
     * Everything behind it has a fallback — see src/data/*.
     */
    dataBase: "https://api.sleeper.com",
    cdnBase: "https://sleepercdn.com",
    /** Docs say stay under 1000 calls/min. We self-limit well below that. */
    maxCallsPerMinute: 600,
    /** Community-converged live-draft poll interval. ~30 calls/min. */
    pickPollMs: 2000,
    /** Draft object (status, order) changes rarely; poll it lazily. */
    draftPollMs: 10_000,
    trendingPollMs: 600_000,
    /** The 5MB player dump. Docs: at most once per day. */
    playersMaxAgeMs: 12 * 60 * 60 * 1000,
  },

  llm: {
    /** On the clock: best judgment, cost is irrelevant at this volume. */
    onClockModel: "claude-opus-5",
    /**
     * FAST_MODE=1 runs the Opus paths (recommendations and ask) in fast mode:
     * the same model at up to 2.5x output speed for 2x the price - a fresh
     * on-clock card in ~8-10s instead of ~20s. Set it for the whole draft or
     * not at all: switching speed invalidates the prompt cache.
     */
    fastMode: process.env.FAST_MODE === "1",
    /** Background re-ranks while others pick. */
    backgroundModel: "claude-haiku-4-5",
    /** Pre-draft news sweep needs a model supporting web_search_20260209. */
    newsModel: "claude-opus-5",
    /**
     * Gaps between your picks in a 12-team snake run ~15-20 min, which outlives the
     * default 5-minute cache. The 1h TTL costs 2x on write once and ~0.1x per read.
     */
    cacheTtl: "1h" as const,
    maxTokens: 8000,
    /** Call the on-clock model when this close to picking. */
    onClockThreshold: 3,
    /** Background refresh only inside this window. */
    backgroundThreshold: 8,
  },

  engine: {
    /** How many candidates the model sees. Keeping this small is the main cost lever. */
    shortlistSize: 8,
    /** Extra slots for a best-available and an upside pick, so the model sees contrarian options. */
    includeBestAvailable: true,
    includeUpsidePick: true,
    /** Weights for the blended score. Tune on draft day if the board feels off. */
    weights: {
      vorp: 1.0,
      vona: 0.85,
      need: 0.6,
      tierBreak: 0.5,
      injury: 0.4,
      byeConflict: 0.15,
      stack: 0.1,
      trending: 0.1,
    },
    /** Points gap within a position that starts a new tier. */
    tierGapPoints: { QB: 15, RB: 12, WR: 12, TE: 14, K: 6, DEF: 8 } as Record<string, number>,
    /** Fallback tier gap for positions not listed above. */
    defaultTierGap: 12,
  },

  /**
   * The in-season trade analyzer (src/trade/). Values are in projected points per
   * week over the rest-of-season window, so "0.5" reads as half a point a week.
   */
  trade: {
    /** A trade must improve your expected lineup by at least this much to be shown. */
    minGainPerWeek: 0.5,
    /**
     * The partner's expected lineup may get at most this much worse. Slightly
     * negative on purpose: a trade that is a wash for them but looks like a win
     * on paper is still one a reasonable manager accepts.
     */
    maxPartnerLossPerWeek: 0.25,
    /**
     * "On paper" fairness: the market value the partner receives over the value
     * they send. Below this a trade reads as a fleecing whatever the lineup math
     * says, and gets declined.
     */
    minMarketRatio: 0.9,
    /** Search pruning only: past this you are overpaying so badly it never helps you. */
    maxMarketRatio: 2.5,
    /**
     * Stud premium in the market model: the best piece of a package counts in full,
     * each further piece a little less. Two quarters are not a half-dollar.
     */
    packageWeights: [1, 0.8, 0.65, 0.5],
    /** Chance a given starter misses a given week; prices bench depth as insurance. */
    injuryRate: 0.08,
    /** The waiver floor is the Nth-best free agent at a position each week. */
    waiverDepth: 2,
    /** How many of each roster's most valuable players the search considers. */
    poolSize: 12,
    /** Smaller pool for three-player packages, which grow combinatorially. */
    poolSizeForTriples: 8,
    /** Results per partner in league-wide mode, and overall. */
    perPartnerLimit: 2,
    resultLimit: 20,
    /** Rosters change through waivers; refetch them when older than this. */
    rosterMaxAgeMs: 60_000,
  },

  /**
   * The waiver analyzer (src/waiver/). Gains are in weighted projected points per
   * week of the window - see src/waiver/odds.ts for where the weights come from.
   */
  waiver: {
    /** A move must improve your weighted lineup by at least this much to be listed. */
    minGainPerWeek: 0.3,
    resultLimit: 20,
    /** Open-ended searches show at most this many adds at one position. */
    perPositionLimit: 6,
    /** Moves in the "do these this week" plan. */
    maxPlanMoves: 3,
    /** Weekly score noise around a team's projection, for the season simulation. */
    weeklySd: 22,
    sims: 6000,
    /**
     * Title-equity value of a regular-season win beyond what it does for your
     * playoff odds - consolation seeding, pride, side pots. It is what keeps an
     * eliminated team's week weights pointing at the next game instead of all zero.
     */
    winValue: 0.005,
    /**
     * FAAB: a pickup worth this many weighted points over your next-best option
     * is worth your whole remaining budget (half that when playoff odds are slim
     * - money is worth less then). Scales the cap on a suggested bid.
     */
    wholeBudgetPoints: 40,
    /** A move whose value sits this much in one week is a stream for that week, not a hold. */
    streamShare: 0.7,
    /**
     * Leading weeks valued with no waiver floor under starters - this week and
     * next, where the decisions are. Later weeks assume you can stream then.
     */
    noFloorWeeks: 2,
    /** Paid news check: how many free agents and drops to cover. */
    newsCandidates: 12,
    /** Opus with web search, opt-in per run. */
    newsModel: "claude-opus-5-5",
  },

  paths: {
    dataDir: "data",
    players: "data/players.json",
    projections: "data/projections.json",
    adp: "data/adp.json",
    news: "data/news.json",
    schedule: "data/schedule.json",
    /** Rest-of-season weekly projections for the trade analyzer. */
    ros: "data/ros.json",
    /** The last few weeks' stat lines: usage context for the waiver analyzer. */
    stats: "data/stats.json",
    /** Full NFL schedule by team, for matchup strips. */
    teamSchedule: "data/team-schedule.json",
    /** Paid waiver news checks, cached per player per Eastern day. */
    waiverNews: "data/waiver-news.json",
    capabilities: "data/capabilities.json",
    /** Locally remembered mock drafts - Sleeper has no endpoint that lists them. */
    mocks: "data/mocks.json",
  },
} as const;

export type Config = typeof config;
