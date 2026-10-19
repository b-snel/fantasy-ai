/**
 * Turning trade arithmetic into reasons.
 *
 * Everything here is derived from the same lineup breakdowns the search ranks on,
 * so the sentences cannot drift from the numbers. Two audiences: you ("why is this
 * good for me?") and the other manager ("why would I say yes?"). The second one
 * ends up in a ready-to-send pitch, which is the part that actually gets a trade
 * done.
 */

import { applyMoves, rosterBreakdown, type RosterBreakdown, type TeamRoster, type TradeUniverse } from "./value.ts";
import type { TradeEval } from "./search.ts";

export interface PositionStrength {
  /** Expected lineup points per week from players at this position. */
  perWeek: number;
  /** 1 = best in the league. */
  rank: number;
}

export interface TeamProfile {
  rosterId: number;
  /** Expected lineup points per week. */
  perWeek: number;
  rank: number;
  positions: Record<string, PositionStrength>;
  /** Bench points per week above the waiver floor, by position. */
  benchDepth: Record<string, number>;
  /** Weakest starting positions relative to the league, worst first. */
  needs: string[];
  /** Positions with startable players stuck on the bench. */
  surplus: string[];
  /** Fraction of the window each player is in the optimal lineup. */
  startShare: Map<string, number>;
}

/** Positions that own a dedicated lineup slot - the ones worth ranking. */
export function rankedPositions(u: TradeUniverse): string[] {
  const out: string[] = [];
  for (const s of u.slots) {
    if (s.eligible.length === 1 && !out.includes(s.eligible[0]!)) out.push(s.eligible[0]!);
  }
  return out;
}

export function profileLeague(u: TradeUniverse, rosters: TeamRoster[]): Map<number, TeamProfile> {
  const weeks = Math.max(1, u.weeks.length);
  const positions = rankedPositions(u);
  const avgFloor: Record<string, number> = {};
  for (const pos of positions) {
    avgFloor[pos] = u.waiverFloor.reduce((a, f) => a + (f[pos] ?? 0), 0) / weeks;
  }

  const raw = rosters.map((r) => {
    const b = rosterBreakdown(u, r.players);
    const startShare = new Map([...b.starts].map(([id, n]) => [id, n / weeks]));
    const benchDepth: Record<string, number> = {};
    for (const pos of positions) benchDepth[pos] = 0;
    for (const id of r.players) {
      const p = u.players.get(id);
      if (!p || (startShare.get(id) ?? 0) >= 0.5) continue;
      if (!(p.position in benchDepth)) continue;
      const surplus = p.rosTotal / weeks - (avgFloor[p.position] ?? 0);
      if (surplus > 0) benchDepth[p.position] = (benchDepth[p.position] ?? 0) + surplus;
    }
    return { roster: r, breakdown: b, startShare, benchDepth };
  });

  const rankOf = (values: number[], v: number) => 1 + values.filter((x) => x > v + 1e-9).length;
  const totals = raw.map((t) => t.breakdown.total);
  const posValues = Object.fromEntries(
    positions.map((pos) => [pos, raw.map((t) => t.breakdown.byPosition[pos] ?? 0)]),
  ) as Record<string, number[]>;
  const depthValues = Object.fromEntries(
    positions.map((pos) => [pos, raw.map((t) => t.benchDepth[pos] ?? 0)]),
  ) as Record<string, number[]>;
  const teams = rosters.length;

  const out = new Map<number, TeamProfile>();
  for (const t of raw) {
    const strengths: Record<string, PositionStrength> = {};
    for (const pos of positions) {
      const v = t.breakdown.byPosition[pos] ?? 0;
      strengths[pos] = { perWeek: v / weeks, rank: rankOf(posValues[pos]!, v) };
    }
    // Bottom third of the league at a position is a need worth trading for.
    const needs = positions
      .filter((pos) => strengths[pos]!.rank > teams - Math.max(1, Math.round(teams / 3)))
      .sort((a, b) => strengths[b]!.rank - strengths[a]!.rank)
      .slice(0, 2);
    // Surplus: a top-three bench at a position, with at least two points a week of
    // startable production sitting on it.
    const surplus = positions
      .filter((pos) => (t.benchDepth[pos] ?? 0) >= 2 && rankOf(depthValues[pos]!, t.benchDepth[pos] ?? 0) <= 3)
      .sort((a, b) => (t.benchDepth[b] ?? 0) - (t.benchDepth[a] ?? 0))
      .slice(0, 2);

    out.set(t.roster.rosterId, {
      rosterId: t.roster.rosterId,
      perWeek: t.breakdown.total / weeks,
      rank: rankOf(totals, t.breakdown.total),
      positions: strengths,
      benchDepth: Object.fromEntries(Object.entries(t.benchDepth).map(([k, v]) => [k, round1(v)])),
      needs,
      surplus,
      startShare: t.startShare,
    });
  }
  return out;
}

export interface SideStory {
  /** Per-week change in expected lineup points by position. */
  positionDelta: Record<string, number>;
  /** Players arriving, and how many weeks each starts. */
  arriving: Array<{ playerId: string; starts: number }>;
  /** Players leaving, and how many weeks each was starting. */
  leaving: Array<{ playerId: string; starts: number }>;
  /** Week-by-week change in expected lineup points. */
  weeklyDelta: number[];
}

export interface TradeExplanation {
  forMe: string[];
  forThem: string[];
  me: SideStory;
  them: SideStory;
  /** A message you could send the other manager as-is. */
  pitch: string;
}

export interface ExplainContext {
  u: TradeUniverse;
  rosters: TeamRoster[];
  profiles: Map<number, TeamProfile>;
  me: number;
  /** Display name for the manager of a roster - used in the pitch. */
  managerName: (rosterId: number) => string;
}

export function explainTrade(ctx: ExplainContext, t: TradeEval): TradeExplanation {
  const { u, rosters, profiles } = ctx;
  const weeks = Math.max(1, u.weeks.length);
  const mine = rosters.find((r) => r.rosterId === ctx.me)!;
  const theirs = rosters.find((r) => r.rosterId === t.partner)!;

  const theirReserve = new Set(theirs.reserve);
  const myReserve = new Set(mine.reserve);
  const meAfter = applyMoves(u, mine, t.give, t.get, new Set(t.get.filter((id) => theirReserve.has(id))));
  const themAfter = applyMoves(u, theirs, t.get, t.give, new Set(t.give.filter((id) => myReserve.has(id))));

  const me = story(rosterBreakdown(u, mine.players), rosterBreakdown(u, meAfter.players), t.get, t.give, weeks);
  const them = story(rosterBreakdown(u, theirs.players), rosterBreakdown(u, themAfter.players), t.give, t.get, weeks);

  const name = (id: string) => u.players.get(id)?.name ?? id;
  const pos = (id: string) => u.players.get(id)?.position ?? "";
  const startsPhrase = (n: number) => (n >= weeks - 1 ? "every week" : `${n} of ${weeks} weeks`);

  // --- for you ---------------------------------------------------------------
  const forMe: string[] = [];
  forMe.push(`Your lineup: ${signed(t.myGain)} pts/wk (${signed(t.myGain * weeks, 0)} over ${weeks} weeks)`);
  for (const a of me.arriving) {
    forMe.push(
      a.starts > 0
        ? `${name(a.playerId)} starts ${startsPhrase(a.starts)} for you`
        : `${name(a.playerId)} would be depth for you, not a starter`,
    );
  }
  for (const l of me.leaving) {
    if (l.starts <= weeks / 3) {
      forMe.push(`${name(l.playerId)} was mostly bench for you (${l.starts} of ${weeks} starts)`);
    }
  }
  const myBestWeek = bestWeek(me.weeklyDelta, t.myGain);
  if (myBestWeek) forMe.push(`Biggest help in week ${u.weeks[myBestWeek.index]} (${signed(myBestWeek.delta)}) - covers a bye or injury hole`);
  for (const id of t.get) {
    const note = availabilityNote(u, id);
    if (note) forMe.push(note);
  }
  if (t.myDrops.length) forMe.push(`You'd cut ${t.myDrops.map(name).join(", ")} to make room`);
  if (t.myOpenSpots > 0) forMe.push(`Opens ${t.myOpenSpots === 1 ? "a roster spot" : `${t.myOpenSpots} roster spots`} for a waiver add`);

  // --- for them --------------------------------------------------------------
  const before = profiles.get(t.partner);
  const forThem: string[] = [];
  forThem.push(
    Math.abs(t.theirGain) < 0.25
      ? `About even for their lineup (${signed(t.theirGain)} pts/wk)`
      : t.theirGain > 0
        ? `Their lineup: ${signed(t.theirGain)} pts/wk`
        : `Costs their lineup ${(-t.theirGain).toFixed(1)} pts/wk`,
  );

  // Where their league standing at a position moves, measured against every other
  // team's current strength there.
  const rankMoves: Array<{ pos: string; from: number; to: number }> = [];
  if (before) {
    for (const [p, delta] of topDeltas(them.positionDelta, 3)) {
      if (delta <= 0) continue;
      const strength = before.positions[p];
      if (!strength) continue;
      const after = strength.perWeek + delta;
      const others = [...profiles.values()]
        .filter((x) => x.rosterId !== t.partner)
        .map((x) => x.positions[p]?.perWeek ?? 0);
      const to = 1 + others.filter((v) => v > after + 1e-9).length;
      if (to < strength.rank) rankMoves.push({ pos: p, from: strength.rank, to });
    }
  }
  for (const m of rankMoves.slice(0, 2)) {
    forThem.push(`${m.pos}: ${ordinal(m.from)} -> ${ordinal(m.to)} in the league`);
  }
  const filled = before?.needs.find((need) => t.give.some((id) => pos(id) === need));
  if (filled && before) {
    forThem.push(`Fills their weakest spot (${filled}, ${ordinal(before.positions[filled]!.rank)} in the league)`);
  }
  for (const l of them.leaving) {
    if (l.starts <= weeks / 3) {
      forThem.push(`${name(l.playerId)} is mostly bench for them (${l.starts} of ${weeks} starts)`);
    }
  }
  forThem.push(
    t.marketRatio >= 1
      ? `On paper they win it: ${Math.round(t.marketRatio * 100)}% of the value they send`
      : `Close to even on paper (${Math.round(t.marketRatio * 100)}% of what they send)`,
  );
  if (t.theirDrops.length) forThem.push(`They'd cut ${t.theirDrops.map(name).join(", ")} to make room`);

  return {
    forMe,
    forThem,
    me,
    them,
    pitch: buildPitch(ctx, t, them, { rankMoves, filled, weeks }),
  };
}

function buildPitch(
  ctx: ExplainContext,
  t: TradeEval,
  them: SideStory,
  info: { rankMoves: Array<{ pos: string; from: number; to: number }>; filled: string | undefined; weeks: number },
): string {
  const { u } = ctx;
  const name = (id: string) => u.players.get(id)?.name ?? id;
  const list = (ids: string[]) =>
    ids.length <= 2 ? ids.map(name).join(" and ") : `${ids.slice(0, -1).map(name).join(", ")} and ${name(ids.at(-1)!)}`;
  const profile = ctx.profiles.get(t.partner);

  const lines: string[] = [`Hey ${ctx.managerName(t.partner)} - would you do my ${list(t.give)} for your ${list(t.get)}?`];

  if (info.filled && profile) {
    const starter = them.arriving.filter((a) => u.players.get(a.playerId)?.position === info.filled).sort((a, b) => b.starts - a.starts)[0];
    lines.push(
      starter && starter.starts >= info.weeks / 2
        ? `You're ${ordinal(profile.positions[info.filled]!.rank)} in the league at ${info.filled}, and ${name(starter.playerId)} would start for you ${starter.starts >= info.weeks - 1 ? "every week" : `${starter.starts} of the next ${info.weeks} weeks`}.`
        : `It shores up ${info.filled}, where you're ${ordinal(profile.positions[info.filled]!.rank)} in the league.`,
    );
  } else if (info.rankMoves[0]) {
    const m = info.rankMoves[0];
    lines.push(`It moves your ${m.pos} group from ${ordinal(m.from)} to ${ordinal(m.to)} in the league.`);
  }

  const benchGive = them.leaving.filter((l) => l.starts <= info.weeks / 3);
  if (benchGive.length === t.get.length && benchGive.length) {
    lines.push(
      benchGive.length === 1
        ? `${name(benchGive[0]!.playerId)} is mostly on your bench, so you'd barely feel it.`
        : `They're mostly on your bench, so you'd barely feel it.`,
    );
  }

  if (t.theirGain >= 0.25) {
    lines.push(`By the rest-of-season projections it makes your lineup about ${t.theirGain.toFixed(1)} points a week better.`);
  }
  if (t.marketRatio >= 1.02) {
    lines.push(`You'd also come out ahead on projected value.`);
  }
  lines.push("Let me know!");
  return lines.join(" ");
}

function story(
  before: RosterBreakdown,
  after: RosterBreakdown,
  arrivingIds: readonly string[],
  leavingIds: readonly string[],
  weeks: number,
): SideStory {
  const positionDelta: Record<string, number> = {};
  for (const pos of new Set([...Object.keys(before.byPosition), ...Object.keys(after.byPosition)])) {
    const d = ((after.byPosition[pos] ?? 0) - (before.byPosition[pos] ?? 0)) / weeks;
    if (Math.abs(d) >= 0.05) positionDelta[pos] = round1(d);
  }
  return {
    positionDelta,
    arriving: arrivingIds.map((id) => ({ playerId: id, starts: after.starts.get(id) ?? 0 })),
    leaving: leavingIds.map((id) => ({ playerId: id, starts: before.starts.get(id) ?? 0 })),
    weeklyDelta: after.weekly.map((v, i) => round1(v - (before.weekly[i] ?? 0))),
  };
}

/** Injury context for a player you'd receive, read from the projection itself. */
export function availabilityNote(u: TradeUniverse, id: string): string | null {
  const p = u.players.get(id);
  if (!p) return null;
  const status = p.injuryStatus ? ` (${p.injuryStatus})` : "";
  // Count the weeks he is genuinely out before he next plays. A bye is not an
  // absence, and neither is a game he already played this week.
  let missed = 0;
  let back = -1;
  for (let i = 0; i < p.weekly.length; i++) {
    if ((p.weekly[i] ?? 0) > 0) {
      back = i;
      break;
    }
    if ((i === 0 && p.playedThisWeek) || u.weeks[i] === p.byeWeek) continue;
    missed++;
  }
  if (back < 0) return `${p.name}${status} is not projected to play again this season`;
  if (missed > 0) {
    return `${p.name}${status} is projected back in week ${u.weeks[back]} - you're buying the return`;
  }
  return p.injuryStatus ? `${p.name} is listed ${p.injuryStatus} but projects to play` : null;
}

function bestWeek(deltas: number[], avg: number): { index: number; delta: number } | null {
  let index = -1;
  let delta = 0;
  deltas.forEach((d, i) => {
    if (d > delta) {
      delta = d;
      index = i;
    }
  });
  // Only worth saying when one week stands well clear of the average.
  return index >= 0 && delta >= 3 && delta >= avg * 2.5 ? { index, delta } : null;
}

function topDeltas(delta: Record<string, number>, n = 2): Array<[string, number]> {
  return Object.entries(delta)
    .filter(([, d]) => Math.abs(d) >= 0.3)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, n);
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

const signed = (n: number, digits = 1): string => {
  const v = Number(n.toFixed(digits));
  return `${v > 0 ? "+" : v < 0 ? "-" : "±"}${Math.abs(v).toFixed(digits)}`;
};
const round1 = (n: number): number => Math.round(n * 10) / 10;
