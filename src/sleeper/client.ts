/**
 * Sleeper HTTP client: typed endpoints, a token-bucket rate limiter, retry with
 * backoff, and an on-disk cache for the expensive-and-rarely-changing payloads.
 *
 * Sleeper's API is read-only and unauthenticated. The one hard rule from the docs
 * is the 1000 calls/min ceiling; we self-limit further so a runaway poll loop can
 * never get the user's IP blocked mid-draft.
 */

import { config } from "../config.ts";
import type {
  Draft,
  DraftPick,
  League,
  LeagueUser,
  NflState,
  PlayersIndex,
  Roster,
  TradedPick,
  TrendingPlayer,
} from "./types.ts";

class RateLimiter {
  private tokens: number;
  private lastRefill = performance.now();

  constructor(private readonly perMinute: number) {
    this.tokens = perMinute;
  }

  async take(): Promise<void> {
    for (;;) {
      const now = performance.now();
      const elapsedMin = (now - this.lastRefill) / 60_000;
      if (elapsedMin > 0) {
        this.tokens = Math.min(this.perMinute, this.tokens + elapsedMin * this.perMinute);
        this.lastRefill = now;
      }
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Wait for roughly one token to accrue.
      await Bun.sleep(Math.ceil(60_000 / this.perMinute));
    }
  }
}

const limiter = new RateLimiter(config.sleeper.maxCallsPerMinute);

export class SleeperError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "SleeperError";
  }
}

export interface FetchOptions {
  /** Retries on 5xx/network errors. 404 and other 4xx fail immediately. */
  retries?: number;
  timeoutMs?: number;
}

/**
 * Sleeper returns `null` (not 404) for some valid-but-empty resources, so a null
 * body is a legitimate result rather than an error.
 */
export async function getJson<T>(url: string, opts: FetchOptions = {}): Promise<T | null> {
  const { retries = 3, timeoutMs = 15_000 } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await Bun.sleep(Math.min(2000 * 2 ** (attempt - 1), 8000));
    await limiter.take();

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });

      if (res.status === 404) return null;
      if (res.status === 429) {
        lastError = new SleeperError("rate limited", 429, url);
        continue;
      }
      if (!res.ok) {
        // 4xx other than 429 will not fix themselves; fail fast.
        if (res.status < 500) throw new SleeperError(`HTTP ${res.status}`, res.status, url);
        lastError = new SleeperError(`HTTP ${res.status}`, res.status, url);
        continue;
      }

      const text = await res.text();
      if (!text || text === "null") return null;
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof SleeperError && err.status < 500 && err.status !== 429) throw err;
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new SleeperError("request failed", 0, url);
}

const api = (path: string) => `${config.sleeper.apiBase}${path}`;

// ---------------------------------------------------------------------------
// Documented endpoints
// ---------------------------------------------------------------------------

export const getLeague = (leagueId: string) => getJson<League>(api(`/league/${leagueId}`));

export const getRosters = (leagueId: string) =>
  getJson<Roster[]>(api(`/league/${leagueId}/rosters`));

export const getLeagueUsers = (leagueId: string) =>
  getJson<LeagueUser[]>(api(`/league/${leagueId}/users`));

export const getLeagueDrafts = (leagueId: string) =>
  getJson<Draft[]>(api(`/league/${leagueId}/drafts`));

export const getDraft = (draftId: string) => getJson<Draft>(api(`/draft/${draftId}`));

/** The live feed. Polled every ~2s during an active draft. */
export const getDraftPicks = (draftId: string) =>
  getJson<DraftPick[]>(api(`/draft/${draftId}/picks`), { retries: 1, timeoutMs: 8000 });

export const getTradedPicks = (draftId: string) =>
  getJson<TradedPick[]>(api(`/draft/${draftId}/traded_picks`));

export const getNflState = () => getJson<NflState>(api(`/state/nfl`));

export const getTrending = (type: "add" | "drop", lookbackHours = 24, limit = 50) =>
  getJson<TrendingPlayer[]>(
    api(`/players/nfl/trending/${type}?lookback_hours=${lookbackHours}&limit=${limit}`),
  );

/** ~5MB. Docs: do not call more than once per day. Always go through getPlayers(). */
export const fetchAllPlayers = () =>
  getJson<PlayersIndex>(api(`/players/nfl`), { retries: 2, timeoutMs: 90_000 });

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

export async function readCache<T>(path: string, maxAgeMs?: number): Promise<T | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  if (maxAgeMs != null) {
    const age = Date.now() - file.lastModified;
    if (age > maxAgeMs) return null;
  }
  try {
    return (await file.json()) as T;
  } catch {
    return null; // A truncated write from a previous crash — treat as a miss.
  }
}

export async function writeCache(path: string, value: unknown): Promise<void> {
  // Write-then-rename so a crash mid-write can't leave a corrupt cache behind.
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, JSON.stringify(value));
  await Bun.write(path, Bun.file(tmp));
  await Bun.file(tmp).delete().catch(() => {});
}

/**
 * The player index, from disk when fresh. This is the one call that genuinely
 * must not happen on a loop.
 */
export async function getPlayers(opts: { force?: boolean } = {}): Promise<PlayersIndex> {
  if (!opts.force) {
    const cached = await readCache<PlayersIndex>(
      config.paths.players,
      config.sleeper.playersMaxAgeMs,
    );
    if (cached) return cached;
  }
  const fresh = await fetchAllPlayers();
  if (!fresh) throw new Error("Sleeper returned no player data");
  await writeCache(config.paths.players, fresh);
  return fresh;
}

/**
 * Resolve the league's draft. Prefers league.draft_id, falls back to the drafts
 * list (which is ordered newest-first for leagues with history).
 */
export async function resolveDraft(league: League): Promise<Draft> {
  if (league.draft_id) {
    const draft = await getDraft(league.draft_id);
    if (draft) return draft;
  }
  const drafts = await getLeagueDrafts(league.league_id);
  const first = drafts?.[0];
  if (!first) throw new Error(`No draft found for league ${league.league_id}`);
  return first;
}
