/**
 * When a player can actually be had, and what the roster rules allow.
 *
 * Sleeper's waiver mechanics, as observed in this league (live, 2026-10-21):
 *
 *   - **The weekly run.** Claims process once a week on `waiver_day_of_week`
 *     (2 = Wednesday here, every run at ~03:08 ET). From the run until a
 *     player's game kicks off he is a free agent: instant, first come, no bid.
 *   - **Kickoff locks him.** Once his game starts he is on waivers until the next
 *     weekly run, and a claim on him cannot help the current week.
 *   - **Drops clear.** A dropped player sits on waivers for `waiver_clear_days`
 *     (claims on him processed ~23h after the drop), then becomes a free agent.
 *   - **Bench lock.** A player whose game has started cannot be dropped.
 *
 * The schedule gives each game's date and status but no kickoff time, so lock
 * times are estimated from the day - erring early, because "locks Sunday 1pm"
 * when he played Thursday night is the costly mistake.
 */

import type { LeagueActivity } from "../data/activity.ts";
import type { TeamSchedule } from "../data/schedule.ts";
import type { LeagueSettings, Player } from "../sleeper/types.ts";

export type ClaimMode = "free_agent" | "waivers" | "locked";

export interface Availability {
  mode: ClaimMode;
  /** When a claim on him processes (waivers / locked), epoch ms. */
  processesAt: number | null;
  /** When he locks if he is a free agent now, epoch ms (estimated kickoff). */
  locksAt: number | null;
  /** First window week he can help: 1 when his game this week is out of reach. */
  startWeek: number;
  /** Who dropped him, when he is on waivers because of a drop. */
  droppedBy: number | null;
  droppedAt: number | null;
}

export interface WaiverCalendar {
  now: number;
  /** The last weekly run, epoch ms, if one has been seen. */
  lastRun: number | null;
  /** The next weekly run, epoch ms (estimated). */
  nextRun: number;
  /** How long a dropped player stays on waivers. */
  clearMs: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The weekly run is the big batch of claims that share one processing time.
 * Off-cycle clears of a dropped player share a timestamp too, but only among
 * the few teams that claimed him (three, once, on 2026-10-21 - against 21 to 39
 * in every weekly run). So the last run is the latest batch at least half the
 * size of the biggest one seen in the last eight days - which may hold two runs.
 */
export function waiverCalendar(activity: LeagueActivity, settings: LeagueSettings, now: number): WaiverCalendar {
  const counts = new Map<number, number>();
  for (const c of activity.claims) counts.set(c.at, (counts.get(c.at) ?? 0) + 1);
  for (const c of activity.failedClaims) counts.set(c.at, (counts.get(c.at) ?? 0) + 1);
  const batches = [...counts].filter(([at, n]) => n >= 3 && at <= now);
  const latestBig = (xs: Array<[number, number]>) => {
    const biggest = Math.max(0, ...xs.map(([, n]) => n));
    return xs.filter(([, n]) => n >= biggest / 2).sort((a, b) => b[0] - a[0])[0]?.[0] ?? null;
  };
  // Nothing in the last eight days: the season's latest big batch still fixes the clock.
  const lastRun =
    latestBig(batches.filter(([at]) => at > now - 8 * DAY)) ?? latestBig(batches.filter(([, n]) => n >= 10));

  let nextRun: number;
  if (lastRun != null) {
    // Step in New York clock time: the run is ~03:08 ET on both sides of a
    // daylight-saving change, which raw 7-day steps would shift by an hour.
    const [hh, mm] = etClock(lastRun);
    nextRun = lastRun;
    for (let i = 1; nextRun <= now && i < 60; i++) {
      const [y, m, d] = etDate(lastRun + i * 7 * DAY);
      nextRun = etToEpoch(y, m, d, hh, mm);
    }
  } else {
    // Never seen a run: assume ~03:00 ET on the waiver day (Sleeper counts the
    // week from Monday = 0, so 2 is Wednesday - matches every run observed).
    nextRun = nextWeekdayEt(now, ((settings.waiver_day_of_week ?? 2) + 1) % 7, 3, 0);
  }
  // Observed clears land ~23h after the drop for a one-day window.
  const days = settings.waiver_clear_days ?? 1;
  return { now, lastRun, nextRun, clearMs: Math.max(1, days * DAY - HOUR) };
}

/**
 * When can this player be added, and from which week of the window can he help?
 * `weekIndex0` games are this week's; the schedule is keyed by NFL week.
 */
export function availabilityOf(
  playerId: string,
  team: string | null,
  ctx: {
    calendar: WaiverCalendar;
    schedule: TeamSchedule;
    nflWeek: number;
    activity: LeagueActivity;
  },
): Availability {
  const { calendar, schedule, nflWeek, activity } = ctx;
  const game = team ? schedule[team]?.[nflWeek] : undefined;
  const kickoff = game?.date ? kickoffEstimate(game.date, gamesOn(schedule, nflWeek, game.date)) : null;
  const started = gameStarted(team, nflWeek, schedule, calendar.now);

  // A drop inside the clear window keeps him on waivers until it clears.
  const drop = activity.drops.find((d) => d.playerId === playerId);
  if (drop && drop.at + calendar.clearMs > calendar.now) {
    const processesAt = drop.at + calendar.clearMs;
    const helpsNow = !started && (kickoff == null || processesAt < kickoff);
    return {
      mode: "waivers",
      processesAt,
      locksAt: null,
      startWeek: helpsNow ? 0 : 1,
      droppedBy: drop.rosterId,
      droppedAt: drop.at,
    };
  }
  if (started) {
    return { mode: "locked", processesAt: calendar.nextRun, locksAt: null, startWeek: 1, droppedBy: null, droppedAt: null };
  }
  return { mode: "free_agent", processesAt: null, locksAt: kickoff, startWeek: 0, droppedBy: null, droppedAt: null };
}

/** Has this team's game this week kicked off (or finished)? */
export function gameStarted(team: string | null, nflWeek: number, schedule: TeamSchedule, now: number): boolean {
  if (!team) return false;
  const game = schedule[team]?.[nflWeek];
  if (!game) return false; // bye: nothing to lock
  if (game.status && game.status !== "pre_game") return true;
  if (!game.date) return false;
  return now >= kickoffEstimate(game.date, gamesOn(schedule, nflWeek, game.date));
}

/**
 * The earliest plausible kickoff on a game date, Eastern: Thursday and Monday
 * nights, Sunday 1pm (international games are earlier and not flagged in the
 * schedule), early afternoon for the Friday and Saturday holiday slates. A
 * Thursday with more than one game is Thanksgiving-style - 12:30pm for all of
 * them, which errs early for the later ones, on purpose.
 */
export function kickoffEstimate(date: string, gamesThatDay = 1): number {
  const key = `${date}:${gamesThatDay > 1 ? "multi" : "one"}`;
  const hit = KICKOFFS.get(key);
  if (hit != null) return hit;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const [hh, mm] =
    weekday === 4
      ? gamesThatDay > 1
        ? [12, 30]
        : [20, 15]
      : weekday === 1
        ? [19, 15]
        : weekday === 0
          ? [13, 0]
          : weekday === 5
            ? [12, 0]
            : [13, 0];
  const at = etToEpoch(y, m, d, hh, mm);
  KICKOFFS.set(key, at);
  return at;
}

const KICKOFFS = new Map<string, number>();
const GAMES_ON = new WeakMap<TeamSchedule, Map<string, number>>();

/** How many games a week's schedule puts on one date. */
export function gamesOn(schedule: TeamSchedule, week: number, date: string): number {
  let byDate = GAMES_ON.get(schedule);
  if (!byDate) {
    byDate = new Map();
    GAMES_ON.set(schedule, byDate);
  }
  const key = `${week}:${date}`;
  let n = byDate.get(key);
  if (n == null) {
    n = Object.values(schedule).filter((games) => games[week]?.date === date).length / 2;
    byDate.set(key, n);
  }
  return n;
}

// Formatters are expensive to build and the search asks thousands of times.
const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const NY_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/** Wall-clock time in New York to epoch ms, handling daylight saving. */
export function etToEpoch(y: number, m: number, d: number, hh: number, mm: number): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // What New York reads at that instant tells us its offset from UTC.
  const parts = NY_PARTS.formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asNy = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  return guess + (guess - asNy);
}

/** The New York calendar date of an instant. */
function etDate(epochMs: number): [number, number, number] {
  return NY_DATE.format(new Date(epochMs)).split("-").map(Number) as [number, number, number];
}

/** The New York wall-clock hour and minute of an instant. */
function etClock(epochMs: number): [number, number] {
  const parts = NY_PARTS.formatToParts(new Date(epochMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return [get("hour") % 24, get("minute")];
}

/** The next time it is `weekday` (0 = Sunday) at hh:mm in New York, after `now`. */
function nextWeekdayEt(now: number, weekday: number, hh: number, mm: number): number {
  for (let i = 0; i < 8; i++) {
    const day = new Date(now + i * DAY);
    const ny = NY_DATE.format(day);
    const [y, m, d] = ny.split("-").map(Number) as [number, number, number];
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== weekday) continue;
    const at = etToEpoch(y, m, d, hh, mm);
    if (at > now) return at;
  }
  return now + 7 * DAY;
}

// ---------------------------------------------------------------------------
// IR
// ---------------------------------------------------------------------------

/**
 * Can this player sit in an IR slot under the league's rules? "IR" always can;
 * the other designations depend on the reserve_allow_* settings. Questionable
 * never can. PUP is left out: whether Sleeper accepts it has not been verified.
 */
export function irEligible(player: Pick<Player, "injury_status" | "status"> | undefined, settings: LeagueSettings): boolean {
  const s = (player?.injury_status ?? "").toLowerCase();
  if (s === "ir") return true;
  if (s === "out") return settings.reserve_allow_out === 1;
  if (s === "doubtful") return settings.reserve_allow_doubtful === 1;
  if (s === "sus") return settings.reserve_allow_sus === 1;
  if (s === "cov") return settings.reserve_allow_cov === 1;
  if (s === "dnr") return settings.reserve_allow_dnr === 1;
  if (s === "na") return settings.reserve_allow_na === 1;
  return false;
}
