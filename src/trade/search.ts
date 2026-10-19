/**
 * Finding trades worth proposing.
 *
 * A trade is shown only if it clears three bars at once:
 *
 *   1. **It helps you.** Your expected rest-of-season lineup improves by a real
 *      margin, measured on your actual roster - not on a trade-value chart.
 *   2. **It does not hurt them.** Their lineup, valued the same way, gets no
 *      meaningfully worse. Trades that pass both are possible because rosters
 *      are lopsided in different directions: your fourth running back can be
 *      their starter, and their bench receiver can be yours.
 *   3. **It looks fair on paper.** Managers judge offers by perceived player
 *      value, not by lineup optimisation, so a trade that the arithmetic says
 *      helps them but that sends them less "name value" than they give still gets
 *      declined. The market check is a perception model with a stud premium -
 *      the best piece in a package counts in full, extra pieces count less, and
 *      each extra body costs the receiver a roster spot.
 *
 * Within that, results are ranked by expected value to you: your gain times a
 * rough likelihood that they say yes. The likelihood is a heuristic for ordering,
 * not a calibrated probability, and the UI labels it as such.
 *
 * The search is exhaustive over packages of up to two players a side (three when
 * a partner or a player is pinned), drawn from each roster's most valuable
 * players. Packages that fail the market check are discarded before the expensive
 * lineup valuation runs, which is what keeps a league-wide search fast.
 */

import { config } from "../config.ts";
import { applyMoves, rosterValue, type TeamRoster, type TradeUniverse } from "./value.ts";

export type TradeSort = "expected" | "gain" | "likely";

export interface TradeQuery {
  /** Your roster id. */
  me: number;
  /** Restrict the search to one trade partner. */
  partner?: number | null;
  /** Your players that must be in the trade. */
  give?: string[];
  /** Their players that must be in the trade (pins the partner). */
  get?: string[];
  /** Your players that must not be traded. */
  keep?: string[];
  /** Largest package per side, 1-3. */
  maxPerSide?: number;
  sort?: TradeSort;
  limit?: number;
}

export type TradeLabel = "win-win" | "fair";

export interface TradeEval {
  partner: number;
  /** Your players going out. */
  give: string[];
  /** Their players coming in. */
  get: string[];
  /** Expected lineup points per week, before and after, both sides. */
  myBefore: number;
  myAfter: number;
  theirBefore: number;
  theirAfter: number;
  /** Change in expected lineup points per week. */
  myGain: number;
  theirGain: number;
  /** Package market values: what you send, what you receive. */
  marketGive: number;
  marketGet: number;
  /** From their side: market value they receive over market value they send. */
  marketRatio: number;
  /** 0-1 heuristic that they accept. */
  acceptance: number;
  /** myGain x acceptance - the default ranking. */
  expectedGain: number;
  passes: boolean;
  label: TradeLabel | null;
  /** Why a trade fails the bars, in plain words. Empty when it passes. */
  problems: string[];
  myDrops: string[];
  theirDrops: string[];
  myOpenSpots: number;
  theirOpenSpots: number;
  /** Lower-ranked variations of this deal that were folded into it. */
  alternatives: number;
}

export interface TradeSearchResult {
  trades: TradeEval[];
  /** The exact trade the user pinned on both sides, evaluated whether or not it passes. */
  proposal: TradeEval | null;
  partners: number[];
  maxPerSide: number;
  /** Package pairs generated. */
  considered: number;
  /** Pairs that cleared the market pre-check and were valued on both rosters. */
  evaluated: number;
  notes: string[];
}

export class TradeQueryError extends Error {
  override name = "TradeQueryError";
}

/** Positions left out of open-ended searches: streamable, and nobody trades for them. */
const AUTO_EXCLUDE = new Set(["K", "DEF"]);

/**
 * Market value each way, from the partner's side of the table: what they receive
 * (your package) and what they send (theirs). Whoever takes back more players
 * than they send pays a roster spot for each extra one.
 */
export function marketValues(
  u: TradeUniverse,
  give: readonly string[],
  get: readonly string[],
  raw?: { give: number; get: number },
): { give: number; get: number } {
  const spot = u.rosterSpotValue;
  const g = raw?.give ?? packageValue(u, give);
  const h = raw?.get ?? packageValue(u, get);
  return {
    give: Math.max(0, g - spot * Math.max(0, give.length - get.length)),
    get: Math.max(0, h - spot * Math.max(0, get.length - give.length)),
  };
}

/** Market value of a package, best piece first, extra pieces discounted. */
export function packageValue(u: TradeUniverse, ids: readonly string[]): number {
  const weights = config.trade.packageWeights;
  const values = ids.map((id) => u.players.get(id)?.marketValue ?? 0).sort((a, b) => b - a);
  let total = 0;
  values.forEach((v, i) => {
    total += v * (weights[Math.min(i, weights.length - 1)] ?? 0.5);
  });
  return total;
}

const ACCEPTANCE = { perPoint: 1.2, perLogRatio: 8 };

/**
 * How likely the partner is to say yes: a logistic over how much the trade helps
 * their lineup and how it reads on paper. Even on both counts is a coin flip; a
 * point a week of real help or a ~10% paper edge each move it about twenty points.
 */
export function acceptanceLikelihood(theirGainPerWeek: number, marketRatio: number): number {
  const { perPoint, perLogRatio } = ACCEPTANCE;
  const ratio = Math.min(3, Math.max(1 / 3, marketRatio));
  const z = perPoint * theirGainPerWeek + perLogRatio * Math.log(ratio);
  return 1 / (1 + Math.exp(-z));
}

/** Value one specific trade on both rosters. */
export function evaluateTrade(
  u: TradeUniverse,
  mine: TeamRoster,
  theirs: TeamRoster,
  give: readonly string[],
  get: readonly string[],
  baseline?: { myBefore: number; theirBefore: number },
): TradeEval {
  const weeks = Math.max(1, u.weeks.length);
  const myBefore = baseline?.myBefore ?? rosterValue(u, mine.players);
  const theirBefore = baseline?.theirBefore ?? rosterValue(u, theirs.players);

  const theirReserve = new Set(theirs.reserve);
  const myReserve = new Set(mine.reserve);
  const me = applyMoves(u, mine, give, get, new Set(get.filter((id) => theirReserve.has(id))));
  const them = applyMoves(u, theirs, get, give, new Set(give.filter((id) => myReserve.has(id))));
  const myAfter = rosterValue(u, me.players);
  const theirAfter = rosterValue(u, them.players);

  const { give: marketGive, get: marketGet } = marketValues(u, give, get);
  const marketRatio = marketGet > 0 ? marketGive / marketGet : marketGive > 0 ? 3 : 1;

  const myGain = (myAfter - myBefore) / weeks;
  const theirGain = (theirAfter - theirBefore) / weeks;
  const acceptance = acceptanceLikelihood(theirGain, marketRatio);

  const t = config.trade;
  const problems: string[] = [];
  if (myGain < t.minGainPerWeek) {
    problems.push(
      myGain < 0
        ? `Costs your lineup ${fmt(-myGain)} pts/wk`
        : `Only ${fmt(myGain)} pts/wk better for you - not worth the trade`,
    );
  }
  if (theirGain < -t.maxPartnerLossPerWeek) {
    problems.push(`Costs their lineup ${fmt(-theirGain)} pts/wk - they would likely decline`);
  }
  if (marketRatio < t.minMarketRatio) {
    problems.push(
      `Lopsided on paper: they would get ${Math.round(marketRatio * 100)}% of the value they send`,
    );
  }
  const passes = problems.length === 0;
  const label: TradeLabel | null = !passes
    ? null
    : theirGain >= 0.5 && marketRatio >= 0.95
      ? "win-win"
      : "fair";

  return {
    partner: theirs.rosterId,
    give: [...give],
    get: [...get],
    myBefore: myBefore / weeks,
    myAfter: myAfter / weeks,
    theirBefore: theirBefore / weeks,
    theirAfter: theirAfter / weeks,
    myGain,
    theirGain,
    marketGive,
    marketGet,
    marketRatio,
    acceptance,
    expectedGain: myGain * acceptance,
    passes,
    label,
    problems,
    myDrops: me.dropped,
    theirDrops: them.dropped,
    myOpenSpots: me.openSpots,
    theirOpenSpots: them.openSpots,
    alternatives: 0,
  };
}

/**
 * Search for trades. Async only so a league-wide search yields between partners
 * and never stalls the server's live streams; the result is deterministic.
 */
export async function findTrades(
  u: TradeUniverse,
  rosters: TeamRoster[],
  query: TradeQuery,
): Promise<TradeSearchResult> {
  const t = config.trade;
  const notes: string[] = [];
  const mine = rosters.find((r) => r.rosterId === query.me);
  if (!mine) throw new TradeQueryError(`Roster ${query.me} is not in this league.`);

  const owned = new Set(mine.players);
  const give = unique(query.give ?? []);
  const get = unique(query.get ?? []);
  const keep = new Set(query.keep ?? []);

  for (const id of give) {
    if (!owned.has(id)) throw new TradeQueryError(`${nameOf(u, id)} is not on your roster.`);
    if (keep.has(id)) throw new TradeQueryError(`${nameOf(u, id)} is marked both "offer" and "keep".`);
  }

  // Pinned targets decide the partner.
  let partners: TeamRoster[];
  if (get.length) {
    const owners = new Set(get.map((id) => rosters.find((r) => r.players.includes(id))?.rosterId));
    if (owners.has(undefined)) {
      const missing = get.find((id) => !rosters.some((r) => r.players.includes(id)))!;
      throw new TradeQueryError(`${nameOf(u, missing)} is not on any roster in this league.`);
    }
    if (owners.has(query.me)) throw new TradeQueryError("You can't trade for your own player.");
    if (owners.size > 1) {
      throw new TradeQueryError("Players you want must all come from the same team.");
    }
    const owner = [...owners][0]!;
    if (query.partner != null && query.partner !== owner) {
      throw new TradeQueryError("Players you want are not on the team you selected.");
    }
    partners = rosters.filter((r) => r.rosterId === owner);
  } else if (query.partner != null) {
    if (query.partner === query.me) throw new TradeQueryError("Pick a team other than your own.");
    partners = rosters.filter((r) => r.rosterId === query.partner);
    if (!partners.length) throw new TradeQueryError(`Roster ${query.partner} is not in this league.`);
  } else {
    partners = rosters.filter((r) => r.rosterId !== query.me);
  }

  let maxPerSide = Math.round(Math.min(3, Math.max(1, query.maxPerSide ?? 2)));
  const openEnded = partners.length > 1 && !give.length;
  if (openEnded && maxPerSide > 2) {
    maxPerSide = 2;
    notes.push("League-wide searches use packages of up to 2 players a side - pick a team for 3.");
  }
  if (give.length > maxPerSide || get.length > maxPerSide) {
    maxPerSide = Math.min(4, Math.max(give.length, get.length));
  }

  const usable = (id: string) => {
    const p = u.players.get(id);
    return p != null && p.rosTotal > 0 && !AUTO_EXCLUDE.has(p.position);
  };
  const byMarket = (ids: string[]) =>
    [...ids].sort(
      (a, b) =>
        (u.players.get(b)?.marketValue ?? 0) - (u.players.get(a)?.marketValue ?? 0) || a.localeCompare(b),
    );

  const myPool = byMarket(mine.players.filter((id) => !keep.has(id) && !give.includes(id) && usable(id)));
  const giveSets = packages(give, myPool, maxPerSide);

  const myBefore = rosterValue(u, mine.players);

  let considered = 0;
  let evaluated = 0;
  const candidates: TradeEval[] = [];

  for (const theirs of partners) {
    const theirPool = byMarket(theirs.players.filter((id) => !get.includes(id) && usable(id)));
    const getSets = packages(get, theirPool, maxPerSide);
    const baseline = { myBefore, theirBefore: rosterValue(u, theirs.players) };
    const giveValues = giveSets.map((g) => packageValue(u, g));
    const getValues = getSets.map((h) => packageValue(u, h));

    for (let gi = 0; gi < giveSets.length; gi++) {
      for (let hi = 0; hi < getSets.length; hi++) {
        considered++;
        const mv = marketValues(u, giveSets[gi]!, getSets[hi]!, { give: giveValues[gi]!, get: getValues[hi]! });
        const ratio = mv.get > 0 ? mv.give / mv.get : 3;
        // The cheap pre-check. Below the floor it fails the paper test whatever the
        // lineups say; far above the ceiling you are overpaying past any gain.
        if (ratio < t.minMarketRatio || ratio > t.maxMarketRatio) continue;
        evaluated++;
        const trade = evaluateTrade(u, mine, theirs, giveSets[gi]!, getSets[hi]!, baseline);
        if (trade.passes) candidates.push(trade);
      }
    }

    // Yield to the event loop between partners.
    if (partners.length > 1) await new Promise((r) => setTimeout(r, 0));
  }

  let proposal: TradeEval | null = null;
  if (give.length && get.length) {
    const theirs = partners[0]!;
    proposal = evaluateTrade(u, mine, theirs, give, get, {
      myBefore,
      theirBefore: rosterValue(u, theirs.players),
    });
  }

  const sort = query.sort ?? "expected";
  const ranked = candidates.sort((a, b) => compare(a, b, sort));
  const single = partners.length === 1;
  const limit = query.limit ?? t.resultLimit;
  const top = (ids: string[]) => byMarket(ids)[0] ?? "";
  const trades = select(ranked, {
    limit,
    perPartner: single ? limit : t.perPartnerLimit,
    perTarget: single ? 3 : 2,
    perOffered: single ? 6 : 3,
    // A pinned player is in every result by definition - the caps are for the rest.
    pinned: new Set([...give, ...get]),
    exclude: proposal ? tradeKey(proposal) : null,
    // When you pinned both sides you are exploring one swap - its variations are
    // the point, so nothing folds.
    core: give.length && get.length ? tradeKey : (x) => `${x.partner}|${top(x.give)}|${top(x.get)}`,
  });

  if (!trades.length && !proposal) {
    notes.push(
      give.length || get.length
        ? "No trade around those players clears all three bars - try fewer pins or a bigger package."
        : "No trade clears all three bars right now.",
    );
  }

  return {
    trades,
    proposal,
    partners: partners.map((p) => p.rosterId),
    maxPerSide,
    considered,
    evaluated,
    notes,
  };
}

function compare(a: TradeEval, b: TradeEval, sort: TradeSort): number {
  const primary =
    sort === "gain"
      ? b.myGain - a.myGain
      : sort === "likely"
        ? b.acceptance - a.acceptance
        : b.expectedGain - a.expectedGain;
  if (Math.abs(primary) > 1e-9) return primary;
  // Fewer moving parts first, then a stable key so results never shuffle.
  const size = a.give.length + a.get.length - (b.give.length + b.get.length);
  if (size !== 0) return size;
  return tradeKey(a).localeCompare(tradeKey(b));
}

/**
 * Pick the results worth showing.
 *
 * A raw ranking is dominated by near-duplicates: the same core trade with a
 * throw-in attached, ten different ways to pry loose the same star, or your one
 * surplus player in every row. A trade is folded into a better-ranked one with
 * the same core (partner and headline piece each way) and counted as an
 * alternative; skipped if a better-ranked one with the same partner is a strict
 * subset of it (the extra pieces did not earn their place); and each partner,
 * each target and each of your players gets a capped number of slots.
 */
function select(
  ranked: TradeEval[],
  opts: {
    limit: number;
    perPartner: number;
    perTarget: number;
    perOffered: number;
    pinned: ReadonlySet<string>;
    exclude: string | null;
    /** Trades with the same core - same partner, same headline piece each way - are one deal. */
    core: (t: TradeEval) => string;
  },
): TradeEval[] {
  const out: TradeEval[] = [];
  const byCore = new Map<string, TradeEval>();
  const perPartner = new Map<number, number>();
  const perTarget = new Map<string, number>();
  const perOffered = new Map<string, number>();

  for (const t of ranked) {
    if (opts.exclude && tradeKey(t) === opts.exclude) continue;
    // A different sweetener on the same swap is a variation, not a new idea.
    const sameCore = byCore.get(opts.core(t));
    if (sameCore) {
      sameCore.alternatives++;
      continue;
    }
    if (out.length >= opts.limit) continue;
    if ((perPartner.get(t.partner) ?? 0) >= opts.perPartner) continue;
    const capped = (ids: string[], counts: Map<string, number>, cap: number) =>
      ids.some((id) => !opts.pinned.has(id) && (counts.get(id) ?? 0) >= cap);
    if (capped(t.get, perTarget, opts.perTarget)) continue;
    // Your best trade chip would otherwise headline every result.
    if (capped(t.give, perOffered, opts.perOffered)) continue;
    const padded = out.some(
      (s) =>
        s.partner === t.partner &&
        s.give.every((id) => t.give.includes(id)) &&
        s.get.every((id) => t.get.includes(id)),
    );
    if (padded) continue;

    const kept = { ...t, alternatives: 0 };
    out.push(kept);
    byCore.set(opts.core(t), kept);
    perPartner.set(t.partner, (perPartner.get(t.partner) ?? 0) + 1);
    for (const id of t.get) perTarget.set(id, (perTarget.get(id) ?? 0) + 1);
    for (const id of t.give) perOffered.set(id, (perOffered.get(id) ?? 0) + 1);
  }
  return out;
}

/**
 * Every package of 1..max players that contains all of `must`, drawn from
 * `pool`. Three-player packages draw from a shorter pool - they grow
 * combinatorially and the third piece of a big package is rarely a star.
 */
export function packages(must: string[], pool: string[], max: number): string[][] {
  const out: string[][] = [];
  const minSize = Math.max(1, must.length);
  for (let size = minSize; size <= max; size++) {
    const extra = size - must.length;
    const source = size >= 3 ? pool.slice(0, config.trade.poolSizeForTriples) : pool.slice(0, config.trade.poolSize);
    for (const combo of combinations(source, extra)) out.push([...must, ...combo]);
  }
  return out;
}

function combinations<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  const walk = (start: number, acc: T[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i <= items.length - (k - acc.length); i++) {
      acc.push(items[i]!);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

export const tradeKey = (t: Pick<TradeEval, "partner" | "give" | "get">): string =>
  `${t.partner}|${[...t.give].sort().join(",")}|${[...t.get].sort().join(",")}`;

const unique = (ids: string[]) => [...new Set(ids.filter(Boolean))];
const nameOf = (u: TradeUniverse, id: string) => u.players.get(id)?.name ?? id;
const fmt = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
