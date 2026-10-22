/**
 * Which weeks matter: playoff odds and per-week leverage.
 *
 * A point in week 8 and a point in week 16 are not worth the same, and how they
 * differ depends on where you stand. At 0-6 you need wins now or the playoffs
 * never come; at 6-0 you are in either way and only the bracket matters. The
 * rest-of-season valuation treats every week alike, which is right for a trade
 * but wrong for a pickup you can drop again next week.
 *
 * So this simulates the rest of the season - the league's real remaining
 * schedule from Sleeper, every team's projected lineup each week, normal noise
 * around it, record then points-for for seeding, a bracket with byes for the top
 * seeds - and asks, for each week, how much one more point that week moves your
 * title odds. That is the week's leverage. Normalised to average 1 across the
 * window it becomes the weight the waiver search values each week with.
 *
 * Leverage factors into two parts, and each is estimated the low-noise way:
 *
 *   - **How much a point moves that game.** The chance of winning one matchup is
 *     a normal CDF of the projected margin, so its slope is a density: points
 *     matter most in a close game and barely at all in a blowout either way.
 *   - **What winning that game is worth.** In the regular season every win counts
 *     the same towards the final record, so its value is estimated once, pooled:
 *     title equity with one more win minus without, over the simulated seasons,
 *     where a season's title equity is computed from its seeding analytically
 *     rather than by playing the bracket out. In the playoffs it is the chance of
 *     being alive in that round times the chance of winning the rest.
 *
 * Sampling the title outright would make a 1%-odds team's weights pure Monte
 * Carlo noise; this keeps them stable. A small fixed value per regular-season
 * win (`winValue`) stands for everything a win is worth besides the title -
 * consolation seeding, pride, the side pot - and keeps an eliminated team's
 * weights meaningful instead of all zero.
 */

export interface SeasonInput {
  /** NFL weeks still to be valued, ascending - the window. */
  weeks: number[];
  /** Last regular-season week; playoff weeks follow. */
  lastRegularWeek: number;
  playoffTeams: number;
  /** Rosters in the league. */
  rosterIds: number[];
  /** Current record and points-for, before any remaining week. */
  standings: Map<number, { wins: number; losses: number; ties: number; pointsFor: number }>;
  /** week -> pairs of roster ids playing each other. Regular-season weeks only. */
  schedule: Map<number, Array<[number, number]>>;
  /** rosterId -> expected lineup points per week, aligned to `weeks`. */
  expected: Map<number, number[]>;
  /** rosterId -> points already scored this week, if the first week is under way. */
  scoredThisWeek?: Map<number, number>;
  /** Standard deviation of one team's weekly score around its projection. */
  sd: number;
  sims: number;
  seed?: number;
}

export interface SeasonOdds {
  /** P(make the playoffs), per roster. */
  playoffs: Map<number, number>;
  /** P(win the title), per roster - from played-out brackets. */
  title: Map<number, number>;
  /** Expected final wins, per roster. */
  wins: Map<number, number>;
  /** Per roster, per window week: P(that team's game counts) - 1 in the regular season. */
  alive: Map<number, number[]>;
}

export interface Leverage {
  /** d P(title) / d point, per week of the window (including the per-win value). */
  raw: number[];
  /** Normalised to average 1 over the window. */
  weights: number[];
  playoffOdds: number;
  /** Mean analytic title equity over the simulated seasons. */
  titleOdds: number;
  /** P(your game that week counts). */
  alive: number[];
  /** Projected margin over each week's opponent; playoff weeks use a typical playoff team. */
  margins: Array<number | null>;
  /** Title equity of one more regular-season win. */
  winWorth: number;
}

/** Simulate the rest of the season for every team. Deterministic for a given seed. */
export function simulateSeason(input: SeasonInput): SeasonOdds {
  const ids = input.rosterIds;
  const playoffs = new Map(ids.map((id) => [id, 0]));
  const title = new Map(ids.map((id) => [id, 0]));
  const wins = new Map(ids.map((id) => [id, 0]));
  const alive = new Map(ids.map((id) => [id, input.weeks.map(() => 0)]));
  const rand = gaussian(input.seed ?? 20261021);
  const sims = Math.max(1, input.sims);

  for (let s = 0; s < sims; s++) {
    const draw = drawSeason(input, rand);
    const result = playOut(input, draw);
    for (const id of result.seeds) playoffs.set(id, playoffs.get(id)! + 1);
    title.set(result.champion, title.get(result.champion)! + 1);
    for (const id of ids) {
      wins.set(id, wins.get(id)! + result.wins.get(id)!);
      const a = alive.get(id)!;
      result.alive.get(id)!.forEach((v, i) => (a[i]! += v ? 1 : 0));
    }
  }

  const scale = (m: Map<number, number>) => new Map([...m].map(([k, v]) => [k, v / sims]));
  return {
    playoffs: scale(playoffs),
    title: scale(title),
    wins: scale(wins),
    alive: new Map([...alive].map(([k, v]) => [k, v.map((x) => x / sims)])),
  };
}

/** How much one more point in each week moves one team's title odds. */
export function weekLeverage(input: SeasonInput, me: number, winValue: number): Leverage {
  const sims = Math.max(1, input.sims);
  const rand = gaussian(input.seed ?? 20261021);
  const sdMargin = input.sd * Math.SQRT2;
  const margins = matchupMargins(input, me);
  const pGame = normalCdf((playoffMargin(input, me) ?? 0) / sdMargin);
  const rounds = Math.ceil(Math.log2(Math.max(1, Math.min(input.playoffTeams, input.rosterIds.length))));
  const byes = 2 ** rounds - Math.min(input.playoffTeams, input.rosterIds.length);

  // Title equity from a seed: win every remaining round against a typical
  // playoff team. A bye seed has one round fewer to win.
  const equity = (seed: number | null) => (seed == null ? 0 : pGame ** (seed <= byes ? rounds - 1 : rounds));

  let playoffCount = 0;
  let equityBase = 0;
  let equityPlus = 0;
  const alive = input.weeks.map(() => 0);

  for (let s = 0; s < sims; s++) {
    const draw = drawSeason(input, rand);
    const result = playOut(input, draw);
    const base = seedOf(result.order, me, input.playoffTeams);
    if (base != null) playoffCount++;
    equityBase += equity(base);
    // One more win, same season otherwise.
    result.wins.set(me, result.wins.get(me)! + 1);
    equityPlus += equity(seedOf(standingsOrder(input, result.wins, result.pf), me, input.playoffTeams));
    result.alive.get(me)!.forEach((v, i) => (alive[i]! += v ? 1 : 0));
  }

  const winWorth = (equityPlus - equityBase) / sims;
  const aliveP = alive.map((a) => a / sims);
  const playoffWeeks = input.weeks.filter((w) => w > input.lastRegularWeek);

  const raw: Array<number | null> = input.weeks.map((week, i) => {
    const m = margins[i];
    // No known opponent: a bye in an odd-sized league, or a schedule fetch that
    // failed. Unknown is not "worthless" - it gets the average regular week below.
    if (m == null) return week <= input.lastRegularWeek ? null : 0;
    const slope = normalPdf(m / sdMargin) / sdMargin;
    if (week <= input.lastRegularWeek) return slope * (winWorth + winValue);
    // Winning this round is worth the chance of winning every round after it.
    const after = playoffWeeks.length - 1 - playoffWeeks.indexOf(week);
    return slope * aliveP[i]! * pGame ** Math.max(0, after);
  });
  const known = raw.filter((r, i): r is number => r != null && input.weeks[i]! <= input.lastRegularWeek);
  const typical = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
  const filled = raw.map((r) => r ?? typical);

  const mean = filled.reduce((a, b) => a + b, 0) / Math.max(1, filled.length);
  return {
    raw: filled,
    weights: mean > 0 ? filled.map((r) => r / mean) : filled.map(() => 1),
    playoffOdds: playoffCount / sims,
    titleOdds: equityBase / sims,
    alive: aliveP,
    margins,
    winWorth,
  };
}

// ---------------------------------------------------------------------------
// The simulation
// ---------------------------------------------------------------------------

/** One season's random scores: rosterId -> score per week of the window. */
type Draw = Map<number, number[]>;

function drawSeason(input: SeasonInput, rand: () => number): Draw {
  const out: Draw = new Map();
  for (const id of input.rosterIds) {
    const exp = input.expected.get(id) ?? [];
    out.set(
      id,
      input.weeks.map((_, i) => {
        const left = exp[i] ?? 0;
        if (i > 0) return left + rand() * input.sd;
        // The part of this week already played is known; only the rest is
        // noisy, and less so the less of the week is left.
        const already = input.scoredThisWeek?.get(id) ?? 0;
        const share = already > 0 ? Math.min(1, left / Math.max(1, left + already)) : 1;
        return already + left + rand() * input.sd * Math.sqrt(share);
      }),
    );
  }
  return out;
}

interface Played {
  /** Every team, best record first. */
  order: number[];
  seeds: number[];
  champion: number;
  wins: Map<number, number>;
  pf: Map<number, number>;
  /** Per roster, per window week: did this team's game count? */
  alive: Map<number, boolean[]>;
}

function playOut(input: SeasonInput, draw: Draw): Played {
  const wins = new Map<number, number>();
  const pf = new Map<number, number>();
  for (const id of input.rosterIds) {
    const s = input.standings.get(id);
    wins.set(id, (s?.wins ?? 0) + (s?.ties ?? 0) * 0.5);
    pf.set(id, s?.pointsFor ?? 0);
  }
  const alive = new Map(input.rosterIds.map((id) => [id, input.weeks.map(() => false)]));
  const score = (id: number, i: number) => draw.get(id)?.[i] ?? 0;

  for (let i = 0; i < input.weeks.length; i++) {
    const week = input.weeks[i]!;
    if (week > input.lastRegularWeek) break;
    for (const id of input.rosterIds) alive.get(id)![i] = true;
    for (const [a, b] of input.schedule.get(week) ?? []) {
      const sa = score(a, i);
      const sb = score(b, i);
      pf.set(a, pf.get(a)! + sa);
      pf.set(b, pf.get(b)! + sb);
      if (sa > sb) wins.set(a, wins.get(a)! + 1);
      else if (sb > sa) wins.set(b, wins.get(b)! + 1);
      else {
        wins.set(a, wins.get(a)! + 0.5);
        wins.set(b, wins.get(b)! + 0.5);
      }
    }
  }

  const order = standingsOrder(input, wins, pf);
  const seeds = order.slice(0, Math.max(1, Math.min(input.playoffTeams, order.length)));

  // Bracket: top seeds get byes up to a power of two; reseed every round.
  const playoffWeeks = input.weeks.map((w, i) => ({ w, i })).filter((x) => x.w > input.lastRegularWeek);
  let field = [...seeds];
  let byes = 2 ** Math.ceil(Math.log2(Math.max(1, field.length))) - field.length;
  let round = 0;
  while (field.length > 1) {
    const slot = playoffWeeks[round];
    const playing = field.slice(byes);
    const winners: number[] = [];
    for (let k = 0; k < playing.length / 2; k++) {
      const a = playing[k]!;
      const b = playing[playing.length - 1 - k]!;
      if (slot) {
        alive.get(a)![slot.i] = true;
        alive.get(b)![slot.i] = true;
      }
      // A round past the end of the window plays at season-average strength.
      const sa = slot ? score(a, slot.i) : avg(input.expected.get(a));
      const sb = slot ? score(b, slot.i) : avg(input.expected.get(b));
      winners.push(sa >= sb ? a : b);
    }
    field = [...field.slice(0, byes), ...winners].sort((x, y) => seeds.indexOf(x) - seeds.indexOf(y));
    byes = 0;
    round++;
  }

  return { order, seeds, champion: field[0] ?? seeds[0]!, wins, pf, alive };
}

/** Record first, points-for second - Sleeper's default tiebreak. */
function standingsOrder(input: SeasonInput, wins: Map<number, number>, pf: Map<number, number>): number[] {
  return [...input.rosterIds].sort(
    (a, b) => wins.get(b)! - wins.get(a)! || pf.get(b)! - pf.get(a)! || a - b,
  );
}

function seedOf(order: number[], me: number, playoffTeams: number): number | null {
  const i = order.indexOf(me);
  return i >= 0 && i < playoffTeams ? i + 1 : null;
}

/** Projected margin over each week's opponent (null when not playing or unknown). */
function matchupMargins(input: SeasonInput, me: number): Array<number | null> {
  return input.weeks.map((week, i) => {
    const mine = input.expected.get(me)?.[i] ?? 0;
    if (week > input.lastRegularWeek) return mine - typicalPlayoffTeam(input, me, i);
    const pair = (input.schedule.get(week) ?? []).find(([a, b]) => a === me || b === me);
    if (!pair) return null;
    const opp = pair[0] === me ? pair[1] : pair[0];
    const already = i === 0 ? (input.scoredThisWeek?.get(me) ?? 0) - (input.scoredThisWeek?.get(opp) ?? 0) : 0;
    return already + mine - (input.expected.get(opp)?.[i] ?? 0);
  });
}

/** Average margin against a typical playoff opponent over the playoff weeks. */
function playoffMargin(input: SeasonInput, me: number): number | null {
  const idx = input.weeks.map((w, i) => (w > input.lastRegularWeek ? i : -1)).filter((i) => i >= 0);
  // Playoffs beyond the window: compare season averages instead.
  if (!idx.length) {
    const others = input.rosterIds.filter((id) => id !== me).map((id) => avg(input.expected.get(id)));
    others.sort((a, b) => b - a);
    const top = others.slice(0, Math.max(1, input.playoffTeams - 1));
    return avg(input.expected.get(me)) - avg(top);
  }
  const ms = idx.map((i) => (input.expected.get(me)?.[i] ?? 0) - typicalPlayoffTeam(input, me, i));
  return avg(ms);
}

/** Mean projection that week of the best other teams - the field you would face. */
function typicalPlayoffTeam(input: SeasonInput, me: number, i: number): number {
  const others = input.rosterIds
    .filter((id) => id !== me)
    .map((id) => input.expected.get(id)?.[i] ?? 0)
    .sort((a, b) => b - a);
  const top = others.slice(0, Math.max(1, input.playoffTeams - 1));
  return avg(top);
}

/** Box-Muller standard normals from a seeded mulberry32. */
function gaussian(seed: number): () => number {
  let a = seed | 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  return () => {
    if (spare != null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = uniform();
    const v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

export const normalPdf = (z: number): number => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

/** Abramowitz-Stegun 7.1.26 via erf; plenty for win probabilities. */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

const avg = (xs: number[] | undefined) => (xs?.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
