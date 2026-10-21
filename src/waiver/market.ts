/**
 * What a claim costs in this league, and what to bid.
 *
 * Sleeper FAAB is first-price - you pay your own bid - so the bid that matters
 * is the smallest one that beats the best rival bid. Two things set that, and
 * both are in the league's own transactions:
 *
 *   - **The clearing price by crowd size.** Group every claim on a player in one
 *     processing run (won and lost) and the second-highest bid is what it took.
 *     Here it rises steeply with the number of bidders - about $2 with two,
 *     $5 with three or four and $23 with five or more (live, 2026-10-21) -
 *     far steeper than any "share of your budget" rule.
 *   - **How many will bid.** Lineup arithmetic does not predict that: of the
 *     twelve players claimed in one run, eleven had no rival whose projected
 *     lineup gained from them. Managers bid on news and holes. So the crowd is
 *     estimated from market signals: Sleeper-wide trending adds, a fresh drop in
 *     this league, and rivals with a hole at his position that week.
 *
 * The bid is capped by what winning is worth to you over the next-best option -
 * if three similar QBs are on the wire, winning one is worth almost nothing -
 * and money is worth less to a team whose playoff odds are slim.
 *
 * All of this is a starting point, not a solver; the UI says so.
 */

import { config } from "../config.ts";
import type { LeagueActivity } from "../data/activity.ts";

export interface ContestedClaim {
  playerId: string;
  at: number;
  week: number;
  bids: Array<{ rosterId: number; bid: number; won: boolean }>;
  /** Second-highest bid - what it took to win. */
  clearing: number;
  bidders: number;
}

export interface FaabMarket {
  /** Runs where two or more teams claimed the same player. */
  contested: ContestedClaim[];
  /** Median clearing price by number of bidders (5 = five or more). */
  clearingByBidders: Record<number, { median: number; n: number }>;
  /** Every winning bid, $0 included. */
  winning: { median: number; p75: number; p90: number; n: number };
  byPosition: Record<string, { median: number; n: number }>;
  /** Remaining FAAB per roster. */
  budgets: Map<number, number>;
  /** Waiver priority (1 = first) per roster - the tiebreak on equal bids. */
  priority: Map<number, number>;
}

/** A first-week fallback for a league with too few contested claims of its own. */
const DEFAULT_CLEARING: Record<number, number> = { 2: 2, 3: 3, 4: 7, 5: 18 };

export function faabMarket(opts: {
  activity: LeagueActivity;
  budget: number;
  rosters: Array<{ rosterId: number; budgetUsed: number; waiverPosition: number | null }>;
  positionOf: (playerId: string) => string | null;
}): FaabMarket {
  const { activity } = opts;

  // Every claim on one player in one processing run is one auction.
  const auctions = new Map<string, ContestedClaim>();
  const add = (playerId: string, at: number, week: number, rosterId: number, bid: number, won: boolean) => {
    const key = `${playerId}@${at}`;
    const a = auctions.get(key) ?? { playerId, at, week, bids: [], clearing: 0, bidders: 0 };
    a.bids.push({ rosterId, bid, won });
    auctions.set(key, a);
  };
  for (const c of activity.claims) add(c.playerId, c.at, c.week, c.rosterId, c.bid, true);
  for (const f of activity.failedClaims) {
    // A roster-limit failure is still a team that wanted him at that price.
    if (f.reason === "outbid" || f.reason === "roster") add(f.playerId, f.at, f.week, f.rosterId, f.bid, false);
  }
  const contested: ContestedClaim[] = [];
  for (const a of auctions.values()) {
    // One team filing two claims on the same player is one bidder.
    const best = new Map<number, number>();
    for (const b of a.bids) best.set(b.rosterId, Math.max(best.get(b.rosterId) ?? 0, b.bid));
    a.bidders = best.size;
    if (a.bidders < 2 || !a.bids.some((b) => b.won)) continue;
    const sorted = [...best.values()].sort((x, y) => y - x);
    a.clearing = sorted[1] ?? 0;
    contested.push(a);
  }
  contested.sort((x, y) => y.at - x.at);

  const clearingByBidders: FaabMarket["clearingByBidders"] = {};
  for (const n of [2, 3, 4, 5]) {
    const prices = contested.filter((c) => (n === 5 ? c.bidders >= 5 : c.bidders === n)).map((c) => c.clearing);
    clearingByBidders[n] = { median: quantile(prices, 0.5), n: prices.length };
  }

  const wins = activity.claims.map((c) => c.bid);
  const byPosition: FaabMarket["byPosition"] = {};
  for (const c of activity.claims) {
    const pos = opts.positionOf(c.playerId) ?? "?";
    (byPosition[pos] ??= { median: 0, n: 0 }).n++;
  }
  for (const pos of Object.keys(byPosition)) {
    byPosition[pos]!.median = quantile(
      activity.claims.filter((c) => opts.positionOf(c.playerId) === pos).map((c) => c.bid),
      0.5,
    );
  }

  return {
    contested,
    clearingByBidders,
    winning: { median: quantile(wins, 0.5), p75: quantile(wins, 0.75), p90: quantile(wins, 0.9), n: wins.length },
    byPosition,
    budgets: new Map(opts.rosters.map((r) => [r.rosterId, Math.max(0, opts.budget - r.budgetUsed)])),
    priority: new Map(
      opts.rosters.filter((r) => r.waiverPosition != null).map((r) => [r.rosterId, r.waiverPosition!]),
    ),
  };
}

export interface Demand {
  /** Sleeper-wide adds in the last day. */
  trendingAdds: number;
  /** Dropped by a team in this league inside the clear window. */
  freshDrop: boolean;
  /** Rivals with a hole at his position in the week the claim helps. */
  rivalsWithHole: number[];
}

export interface BidAdvice {
  amount: number;
  /** Expected number of teams claiming him, you included. */
  bidders: number;
  /** Estimated second-highest bid. */
  clearing: number;
  /** The most winning him is worth to you, in dollars. */
  worthCap: number;
  /** The likely price is above what he is worth to you. */
  outbidLikely: boolean;
  lines: string[];
}

/** Expected claimants, you included. Thresholds are Sleeper-wide 24h adds. */
export function expectedBidders(d: Demand): number {
  const t = d.trendingAdds;
  const trend = t >= 300_000 ? 5 : t >= 100_000 ? 4 : t >= 25_000 ? 3 : t >= 5_000 ? 2 : 1;
  const holes = 1 + d.rivalsWithHole.length;
  return Math.min(5, Math.max(trend, holes) + (d.freshDrop ? 1 : 0));
}

export function suggestBid(opts: {
  market: FaabMarket;
  me: number;
  position: string;
  demand: Demand;
  /** Weighted points winning him is worth over your next-best option. */
  worthPoints: number;
  /** Names of the similar options that make him replaceable, if any. */
  alternatives?: string[];
  playoffOdds: number;
}): BidAdvice {
  const { market, me, demand } = opts;
  const budget = market.budgets.get(me) ?? 0;
  const bidders = expectedBidders(demand);
  const lines: string[] = [];

  let clearing = 0;
  if (bidders >= 2) {
    const k = Math.min(5, bidders);
    const seen = market.clearingByBidders[k];
    clearing = seen && seen.n >= 2 ? seen.median : (DEFAULT_CLEARING[k] ?? 0);
    // Positions price differently here (QB streamers go for $0, RBs for $11):
    // scale by the position's median winning bid against the league's.
    const pos = market.byPosition[opts.position];
    if (pos && pos.n >= 5) {
      const factor = Math.min(3, Math.max(0.25, (pos.median + 1) / (market.winning.median + 1)));
      clearing = Math.round(clearing * factor);
    }
    // Nobody can bid past their budget: the price is capped by the richest rival.
    const richest = Math.max(0, ...[...market.budgets].filter(([id]) => id !== me).map(([, b]) => b));
    clearing = Math.min(clearing, richest);
    lines.push(
      `~${bidders - 1} other team${bidders > 2 ? "s" : ""} likely to claim him; ${opts.position} claims like that have cleared ~$${clearing} here`,
    );
  } else {
    lines.push("Little sign anyone else wants him");
  }

  // Money is worth less with slimmer odds of a season to spend it on.
  const whole = config.waiver.wholeBudgetPoints * (opts.playoffOdds < 0.1 ? 0.5 : 1);
  const worthCap = Math.min(budget, Math.round(budget * Math.min(1, Math.max(0, opts.worthPoints) / whole)));

  let amount = bidders >= 2 ? clearing + 1 : 0;
  const outbidLikely = amount > worthCap;
  if (outbidLikely) {
    amount = worthCap;
    lines.push(
      opts.alternatives?.length
        ? `Not worth a bidding war: ${opts.alternatives.slice(0, 2).join(" and ")} would do nearly as well (he's worth ~$${worthCap} more to you)`
        : `He's worth ~$${worthCap} to you - bid that and accept you may lose him`,
    );
  }
  amount = Math.max(0, Math.min(budget, amount));

  if (amount === 0) {
    const myPriority = market.priority.get(me) ?? 99;
    const ahead = [...market.priority].filter(([id, p]) => id !== me && p < myPriority).length;
    lines.push(
      ahead
        ? `$0 is legal; ties go to waiver priority and ${ahead} team${ahead > 1 ? "s" : ""} rank ahead of you - $1 beats their $0`
        : "$0 is legal, and you hold top waiver priority on ties",
    );
  }
  if (demand.rivalsWithHole.length) {
    lines.push(`${demand.rivalsWithHole.length} rival${demand.rivalsWithHole.length > 1 ? "s have" : " has"} a hole at ${opts.position} that week`);
  }
  const broke = [...market.budgets].filter(([id, b]) => id !== me && b === 0).length;
  if (amount >= 1 && broke) lines.push(`${broke} team${broke > 1 ? "s are" : " is"} out of FAAB - any bid beats them`);
  if (amount > 0) lines.push("Winning any claim sends you to the back of the waiver order");

  return { amount, bidders, clearing, worthCap, outbidLikely, lines };
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}
