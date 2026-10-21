/**
 * What the league and the wider Sleeper crowd have been doing on the wire.
 *
 * Three free signals the projections cannot carry:
 *
 *   - **This league's FAAB prices.** Every claim records its bid, won or lost,
 *     so the going rate for a contested pickup in *this* league is known, not
 *     guessed from national articles (see src/waiver/market.ts).
 *   - **Who just got cut.** A player dropped in the last day or so is still on
 *     waivers here, and a recently dropped starter is often the best add.
 *   - **Sleeper-wide trending adds and drops.** Millions of managers reacting to
 *     the same news is the fastest news feed there is - projections refresh
 *     weekly, the crowd within hours. A heavily added player who projects
 *     poorly is a sign the projections have not caught up yet.
 */

import { getTransactions, getTrending } from "../sleeper/client.ts";
import type { Transaction, TrendingPlayer } from "../sleeper/types.ts";

export interface Claim {
  playerId: string;
  rosterId: number;
  bid: number;
  week: number;
  at: number;
}

export interface FailedClaim extends Claim {
  /** Why it failed, from Sleeper's note. "outbid" is the demand signal. */
  reason: "outbid" | "roster" | "budget" | "other";
}

export interface Drop {
  playerId: string;
  rosterId: number;
  week: number;
  at: number;
}

export interface LeagueActivity {
  /** Processed waiver claims this season, newest first. */
  claims: Claim[];
  /**
   * Claims that did not go through, newest first. Losing bids are demand the
   * winning bid hides; roster-limit failures are demand too (the team wanted
   * him, but an earlier claim of theirs used the spot).
   */
  failedClaims: FailedClaim[];
  /** Every drop this season, newest first (waiver claims and free-agent moves alike). */
  drops: Drop[];
  /** Sleeper-wide adds and drops over the last day, by player. */
  trendingAdds: Map<string, number>;
  trendingDrops: Map<string, number>;
  /** Transaction weeks whose fetch failed - their rows are missing, not empty. */
  failedWeeks: number[];
  /** Whether the trending lists came back. */
  trendingOk: boolean;
  fetchedAt: number;
}

export async function getLeagueActivity(opts: {
  leagueId: string;
  /** Fetch transaction weeks 1..throughWeek. */
  throughWeek: number;
  trendingLimit?: number;
}): Promise<LeagueActivity> {
  const weeks = Array.from({ length: Math.max(0, opts.throughWeek) }, (_, i) => i + 1);
  const limit = opts.trendingLimit ?? 200;
  const [pages, adds, drops] = await Promise.all([
    Promise.all(weeks.map((w) => getTransactions(opts.leagueId, w).catch(() => undefined))),
    getTrending("add", 24, limit).catch(() => null),
    getTrending("drop", 24, limit).catch(() => null),
  ]);
  const out = summariseActivity(
    weeks.map((week, i) => ({ week, rows: pages[i] ?? [] })),
    adds ?? [],
    drops ?? [],
  );
  // Sleeper answers an empty week with [] or null; only a thrown request is a failure.
  return { ...out, failedWeeks: weeks.filter((_, i) => pages[i] === undefined), trendingOk: adds != null && drops != null };
}

/**
 * A refresh where some fetches failed: keep the last good copy of what is
 * missing. Transactions only ever accumulate, so the previous claims and drops
 * stand in for a failed week; failed trending keeps the previous lists.
 */
export function mergeActivity(previous: LeagueActivity, next: LeagueActivity): LeagueActivity {
  const merged = next.failedWeeks.length
    ? {
        ...next,
        claims: next.claims.length >= previous.claims.length ? next.claims : previous.claims,
        failedClaims: next.failedClaims.length >= previous.failedClaims.length ? next.failedClaims : previous.failedClaims,
        drops: next.drops.length >= previous.drops.length ? next.drops : previous.drops,
      }
    : next;
  return next.trendingOk
    ? merged
    : { ...merged, trendingAdds: previous.trendingAdds, trendingDrops: previous.trendingDrops };
}

/** Exported for testing. */
export function summariseActivity(
  pages: Array<{ week: number; rows: Transaction[] }>,
  trendingAdds: TrendingPlayer[],
  trendingDrops: TrendingPlayer[],
  now = Date.now(),
): LeagueActivity {
  const claims: Claim[] = [];
  const failedClaims: FailedClaim[] = [];
  const drops: Drop[] = [];

  for (const { week, rows } of pages) {
    for (const t of rows) {
      const at = t.status_updated ?? t.created ?? 0;
      const bid = t.settings?.waiver_bid ?? 0;
      if (t.type === "waiver") {
        for (const [playerId, rosterId] of Object.entries(t.adds ?? {})) {
          if (t.status === "complete") claims.push({ playerId, rosterId, bid, week, at });
          else if (t.status === "failed") {
            failedClaims.push({ playerId, rosterId, bid, week, at, reason: failureReason(t.metadata?.notes ?? "") });
          }
        }
      }
      if (t.status !== "complete") continue;
      for (const [playerId, rosterId] of Object.entries(t.drops ?? {})) {
        // A trade "drop" is the player changing hands, not hitting the wire.
        if (t.type === "trade") continue;
        drops.push({ playerId, rosterId, week, at });
      }
    }
  }
  claims.sort((a, b) => b.at - a.at);
  failedClaims.sort((a, b) => b.at - a.at);
  drops.sort((a, b) => b.at - a.at);

  return {
    claims,
    failedClaims,
    drops,
    trendingAdds: new Map(trendingAdds.map((t) => [t.player_id, t.count])),
    trendingDrops: new Map(trendingDrops.map((t) => [t.player_id, t.count])),
    failedWeeks: [],
    trendingOk: true,
    fetchedAt: now,
  };
}

function failureReason(note: string): FailedClaim["reason"] {
  if (/claimed by another/i.test(note)) return "outbid";
  if (/too many players/i.test(note)) return "roster";
  if (/over the budget/i.test(note)) return "budget";
  return "other";
}
