/**
 * `bun run waivers` - the waiver analyzer in the terminal.
 *
 * Same service the web page calls, so what prints here is what the page shows.
 * Read the output the way you would read a mock draft: the individual numbers can
 * all be right while the advice they add up to is silly - a stream for a week you
 * already cover, a bid on a player three others like him would replace - and this
 * is the fastest way to see that.
 *
 *   bun run waivers                        the plan, holes, streams and best moves
 *   bun run waivers --horizon=week         value this week only (also season, playoffs; default auto)
 *   bun run waivers --pos=QB,DEF           only adds at these positions
 *   bun run waivers --keep="Kelce,Nacua"   never drop these
 *   bun run waivers --add="Name"           one free agent against every possible drop
 *   bun run waivers --drop="Name"          cut this player first; later steps may cut others
 *   bun run waivers --league               also print every team's record, FAAB, priority, odds and holes
 *   bun run waivers --verbose              every reason, drop option, schedule strip and bid line
 *   bun run waivers --fixtures             offline fixture league, no network
 *   bun run waivers --refresh              refetch projections, not just rosters
 *   bun run waivers --news                 the paid news check (Opus + web search, ~$0.30-1.00;
 *                                          free when today's notes are cached). The only flag
 *                                          that costs money - nothing else calls a model.
 */

import {
  WaiverService,
  liveWaiverExtras,
  type Horizon,
  type MoveView,
  type NewsJobView,
  type PlanStepView,
  type PlayerCard,
  type StreamWeekView,
  type TeamLine,
  type WaiverAnalysis,
  type WaiverOverview,
  type WaiverRequest,
} from "../server/waivers.ts";
import { liveTradeSource, type TradeData, type TradeDataSource } from "../server/trades.ts";
import { fixtureWaiverSources, makeFixtureWaiverLeague } from "../../fixtures/waiver.ts";
import { liveNewsProvider } from "../waiver/news.ts";
import { WaiverQueryError } from "../waiver/search.ts";
import type { Player } from "../sleeper/types.ts";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const HORIZONS: Horizon[] = ["auto", "week", "season", "playoffs"];
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
/** The news job is one model call with a few searches; past this it is stuck, not slow. */
const NEWS_TIMEOUT_MS = 6 * 60_000;

function flag(name: string): string | null {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
}

const list = (v: string | null) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const VERBOSE = flag("verbose") != null;

async function main(): Promise<void> {
  const fixtures = flag("fixtures") != null;
  const wantNews = flag("news") != null;
  if (fixtures && wantNews) {
    // The fixture league's players are invented - a web search on them would bill for nothing.
    throw new Error("--news looks up real players; the fixture league's are made up. Drop --fixtures.");
  }

  const horizon = (flag("horizon") || "auto") as Horizon;
  if (!HORIZONS.includes(horizon)) throw new Error(`--horizon must be one of ${HORIZONS.join(", ")}`);
  const positions = list(flag("pos")).map((p) => {
    const pos = p.toUpperCase().replace(/^(DST|D\/ST)$/, "DEF");
    if (!POSITIONS.includes(pos)) throw new Error(`--pos: "${p}" is not one of ${POSITIONS.join(", ")}`);
    return pos;
  });

  /*
   * The service owns the data; the CLI only needs the league's player index and
   * rosters to turn a name into an id for --add. Watching the source as the
   * service loads it gets both for free - no second fetch, and always the same
   * snapshot the analysis ran on.
   */
  const seen: { data: TradeData | null } = { data: null };
  const watch = (s: TradeDataSource): TradeDataSource => ({
    async load(force) {
      seen.data = await s.load(force);
      return seen.data;
    },
    async rosters() {
      const r = await s.rosters();
      if (seen.data) seen.data = { ...seen.data, ...r };
      return r;
    },
  });

  let service: WaiverService;
  let now: () => number = Date.now;
  if (fixtures) {
    const fx = makeFixtureWaiverLeague();
    const src = fixtureWaiverSources(fx);
    now = () => fx.now;
    service = new WaiverService(watch(src.trade), src.extras, null, now);
  } else {
    // No news provider unless asked: without one, nothing in this process can bill.
    // The provider bills only when a check runs, and that needs --news; without
    // it, today's cached notes still show for free.
    service = new WaiverService(watch(liveTradeSource()), liveWaiverExtras(), liveNewsProvider());
  }

  const overview = await service.overview({ refresh: flag("refresh") != null });

  // Names to ids on your roster, like the trade CLI's resolve - except that part
  // of a name matching two of yours is an error, not a coin flip on who gets cut.
  const mine = overview.team.players;
  const resolveMine = (query: string, what: string): PlayerCard => {
    const q = query.toLowerCase();
    const exact = mine.find((p) => p.playerId === query) ?? mine.find((p) => p.name.toLowerCase() === q);
    if (exact) return exact;
    const partial = mine.filter((p) => p.name.toLowerCase().includes(q));
    if (partial.length > 1) throw new Error(`${what}: "${query}" matches ${partial.map((p) => p.name).join(" and ")} - be more specific`);
    if (!partial[0]) throw new Error(`${what}: no player of yours matches "${query}"`);
    return partial[0];
  };
  const keep = list(flag("keep")).map((q) => resolveMine(q, "--keep").playerId);
  const dropFlag = flag("drop");
  const drop = dropFlag ? resolveMine(dropFlag, "--drop").playerId : null;
  const base: WaiverRequest = { horizon, positions, keep, drop, add: null };

  // --add needs a free agent's id; the open search ranks the likely ones first.
  let analysis = await service.analyze(base);
  const addFlag = flag("add");
  let req = base;
  if (addFlag) {
    const target = resolveFreeAgent(addFlag, analysis, overview, seen.data);
    req = { ...base, add: target.id };
    try {
      analysis = await service.analyze(req);
    } catch (err) {
      // In the player index and on nobody's roster, yet not on the engine's wire:
      // the universe only carries players Sleeper projects for the rest of the season.
      if (err instanceof WaiverQueryError && target.fromIndex && err.message.includes("not a free agent")) {
        throw new Error(`${target.name} is a free agent, but Sleeper has no rest-of-season projection for him - there is nothing to value.`);
      }
      throw err;
    }
  }

  let news: { job: NewsJobView; seconds: number } | null = null;
  if (wantNews) {
    news = await runNews(service, req);
    // Re-read so the moves carry the notes and verdicts the check just cached.
    if (news.job.status === "done") analysis = await service.analyze(req);
  }

  printHeader(overview, analysis, now());
  printAlerts(overview);
  printPlan(analysis);
  printStreams(analysis.streams);
  printMoves(analysis);
  printCuts(overview);
  if (flag("league") != null) printLeague(overview.league_table);
  if (news) printNews(news.job, news.seconds);
  console.log();
}

// ---------------------------------------------------------------------------
// Resolving --add
// ---------------------------------------------------------------------------

/**
 * A name to a free agent's id, most specific match first: an id, then a full
 * name, then part of one. At each level the search's own shortlist - the plan,
 * the moves and their folded alternatives, the weekly streams - wins, so
 * "Johnson" means the Johnson worth adding. Otherwise the whole wire: every
 * fantasy-position player in the index on nobody's roster, which is how a player
 * below the bar gets evaluated. A rostered player is named as such, because "no
 * free agent matches" would be a lie.
 */
function resolveFreeAgent(
  query: string,
  analysis: WaiverAnalysis,
  overview: WaiverOverview,
  data: TradeData | null,
): { id: string; name: string; fromIndex: boolean } {
  if (!data) throw new Error("--add: the league's player index did not load");
  const q = query.toLowerCase();
  const owner = new Map<string, number>();
  for (const r of data.rosters) for (const id of r.players ?? []) owner.set(id, r.roster_id);

  const shortlist = [
    ...analysis.plan.flatMap((s) =>
      s.kind === "add"
        ? [s.move.add]
        : s.kind === "claim"
          ? [s.move.add, ...s.fallbacks.map((f) => f.add)]
          : s.kind === "later"
            ? [s.move.add, ...s.alternatives.map((a) => a.add)]
            : [],
    ),
    ...analysis.moves.flatMap((m) => [m.add, ...m.alternatives.map((a) => a.player)]),
    ...analysis.streams.flatMap((w) => w.streams.map((s) => s.player)),
  ].map((c) => ({ id: c.playerId, name: c.name }));
  const everyone = Object.entries(data.players)
    .filter(([, p]) => p.position != null && POSITIONS.includes(p.position))
    .map(([id, p]) => ({ id, name: playerName(id, p), team: p.team ?? null, position: p.position!, active: p.active !== false }));

  const levels: Array<(p: { id: string; name: string }) => boolean> = [
    (p) => p.id === query,
    (p) => p.name.toLowerCase() === q,
    (p) => p.name.toLowerCase().includes(q),
  ];
  for (const test of levels) {
    const listed = shortlist.find(test);
    if (listed) return { ...listed, fromIndex: false };
    const hits = everyone.filter(test);
    if (!hits.length) continue;
    // Names collide (a retired Kenneth Walker and the one on the Chiefs): the
    // ones on an NFL team are the ones in play, rostered or not.
    const live = hits.filter((h) => h.team && h.active);
    const field = live.length ? live : hits;
    const pick = field.filter((h) => !owner.has(h.id));
    if (pick.length && new Set(pick.map((h) => h.name.toLowerCase())).size === 1) {
      return { id: pick[0]!.id, name: pick[0]!.name, fromIndex: true };
    }
    if (pick.length) {
      const shown = pick
        .slice(0, 6)
        .map((h) => `${h.name} (${h.position}${h.team ? ` ${h.team}` : ""})`)
        .join(", ");
      throw new Error(`--add: "${query}" matches several free agents: ${shown}${pick.length > 6 ? ", ..." : ""} - be more specific`);
    }
    const rostered = field[0]!;
    const rid = owner.get(rostered.id)!;
    const team = overview.league_table.find((t) => t.rosterId === rid)?.teamName.trim() ?? `roster ${rid}`;
    throw new Error(
      rid === overview.me
        ? `--add: ${rostered.name} is already on your roster`
        : `--add: ${rostered.name} is not a free agent - he is on ${team}'s roster (try bun run trades --get="${rostered.name}")`,
    );
  }
  throw new Error(`--add: no player matches "${query}"`);
}

function playerName(id: string, p: Player): string {
  return p.full_name ?? (`${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || id);
}

// ---------------------------------------------------------------------------
// The paid news check
// ---------------------------------------------------------------------------

/** Start the job and poll it, like the page does. Wall-clock time, not the service's clock. */
async function runNews(service: WaiverService, req: WaiverRequest): Promise<{ job: NewsJobView; seconds: number }> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  let job = await service.startNews(req);
  const tty = process.stdout.isTTY;
  while (job.status === "running") {
    if (Date.now() - started > NEWS_TIMEOUT_MS) {
      const error = `no answer after ${Math.round(NEWS_TIMEOUT_MS / 60_000)} minutes - giving up`;
      return { job: { ...job, status: "error", error }, seconds: seconds() };
    }
    if (tty) process.stdout.write(`\r${DIM}Checking news... ${seconds()}s${RESET}`);
    await new Promise((r) => setTimeout(r, 1_000));
    job = service.newsStatus();
  }
  if (tty) process.stdout.write("\r\x1b[K");
  return { job, seconds: seconds() };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function printHeader(o: WaiverOverview, a: WaiverAnalysis, now: number): void {
  const { league, team } = o;
  console.log(`\n${BOLD}${league.name}${RESET} ${DIM}${league.scoring}${RESET}`);
  const faab = league.faab ? `FAAB $${team.faabLeft ?? 0} of $${league.budget} left` : "rolling waivers, no FAAB";
  console.log(
    `${DIM}NFL week ${league.nflWeek} · valuing weeks ${league.weeks[0]}-${league.weeks.at(-1)} (${league.weeks.length}) · ` +
      `${faab} · waiver priority ${team.priority ?? "-"} of ${league.teams} · ` +
      `next run ${league.nextRunLabel} (in ${until(league.nextRun - now)})` +
      `${o.source === "season_fallback" ? ` · ${YELLOW}season-total fallback${RESET}${DIM}` : ""}${RESET}`,
  );
  console.log(
    `\n${BOLD}Your team${RESET} ${team.teamName} ${DIM}(${team.manager}) ${team.record} · ` +
      `${team.perWeek.toFixed(1)} pts/wk projected with no moves${RESET}`,
  );
  // The note carries the playoff and title odds, from the unrounded simulation.
  console.log(`  ${DIM}${o.leverage.note}${RESET}`);
  const weights = league.weeks.map((w, i) => `${w}:${(a.weights[i] ?? 0).toFixed(2)}`).join(" ");
  console.log(`  ${DIM}horizon ${a.horizon} - week weights ${weights}${RESET}`);

  if (!VERBOSE) return;
  for (const p of team.players) {
    const role = p.starting ? `${GREEN}start${RESET}` : `${DIM}bench${RESET}`;
    const tags = [p.reserve ? "IR" : "", p.injuryStatus ?? "", p.locked ? "locked" : ""].filter(Boolean);
    console.log(
      `  ${p.position.padEnd(4)}${p.name.padEnd(24)} ${p.perWeek.toFixed(1).padStart(5)}/wk  ${role}  ` +
        `${DIM}starts ${String(p.starts).padStart(2)} of ${league.weeks.length} · cut costs ${p.cutCost.toFixed(1)}/wk${RESET}` +
        `${tags.length ? `  ${YELLOW}${[...new Set(tags)].join(" ")}${RESET}` : ""}`,
    );
  }
}

function printAlerts(o: WaiverOverview): void {
  if (!o.alerts.length) return;
  console.log(`\n${BOLD}Alerts${RESET}`);
  for (const a of o.alerts) {
    const colour = a.cls === "warn" ? RED : a.cls === "run" ? YELLOW : CYAN;
    console.log(`  ${colour}${a.cls === "warn" ? "!" : "·"} ${a.text}${RESET}`);
  }
}

function printPlan(a: WaiverAnalysis): void {
  console.log(`\n${BOLD}Do this${RESET} ${DIM}in this order${RESET}`);
  if (!a.plan.length) {
    console.log(`  ${DIM}Nothing - the wire has nobody who beats what you have.${RESET}`);
    return;
  }
  a.plan.forEach((s, i) => {
    const gain = "move" in s ? `  ${DIM}${signed(s.move.gain, 2)}/wk${RESET}` : "";
    console.log(`  ${String(i + 1).padStart(2)}. ${s.text}${gain}`);
    if ("move" in s) printVerdict(s.move, "      ");
    if (s.kind === "claim" || s.kind === "later") {
      for (const line of s.move.bid?.lines ?? []) console.log(`      ${DIM}${line}${RESET}`);
    }
    if (s.kind === "claim") {
      for (const f of s.fallbacks) {
        console.log(`      ${DIM}fallback: ${label(f.add)} ${signed(f.gain, 2)}/wk${f.bid ? ` · $${f.bid.amount}` : ""}${RESET}`);
      }
    }
    if (s.kind === "later") {
      for (const alt of s.alternatives) {
        console.log(`      ${DIM}or ${label(alt.add)} ${signed(alt.gain, 2)}/wk · ${alt.availability.label}${RESET}`);
      }
    }
    if (VERBOSE && "move" in s) {
      for (const r of s.move.reasons) console.log(`      ${DIM}· ${r}${RESET}`);
    }
  });
}

function printStreams(weeks: StreamWeekView[]): void {
  console.log(`\n${BOLD}Holes & streams${RESET} ${DIM}free agents who beat your own best that week${RESET}`);
  for (const w of weeks) {
    console.log(`  ${BOLD}Week ${w.week}${RESET}${w.holes.length ? "" : ` ${DIM}no holes${RESET}`}`);
    for (const h of w.holes) console.log(`    ${YELLOW}${h}${RESET}`);
    const shown = VERBOSE ? w.streams : w.streams.slice(0, 5);
    if (!shown.length) console.log(`    ${DIM}no free agent adds a point or more to your lineup that week${RESET}`);
    for (const s of shown) {
      const game = s.player.strip.find((x) => x.week === w.week);
      const opp = game?.opponent ? `${game.home ? "vs" : "@"} ${game.opponent}` : "bye";
      console.log(
        `    ${GREEN}${signed(s.gain).padStart(5)}${RESET}  ${label(s.player).padEnd(30)} ${DIM}${opp.padEnd(7)}${RESET}` +
          `${s.points.toFixed(1).padStart(5)} pts  ${DIM}${s.replaces ? `over ${s.replaces}` : "fills an empty slot"} · ${s.availability.label}${RESET}`,
      );
    }
  }
}

function printMoves(a: WaiverAnalysis): void {
  console.log(
    `\n${BOLD}Moves${RESET} ${DIM}${a.considered.toLocaleString()} free agents valued, ` +
      `${a.evaluated.toLocaleString()} add/drop pairs, ${a.elapsedMs}ms · gain is weighted lineup pts/wk${RESET}`,
  );
  for (const note of a.notes) console.log(`  ${YELLOW}${note}${RESET}`);
  if (a.proposal) {
    console.log(`\n  ${BOLD}Your pick${RESET}`);
    printMove(a.proposal, 0, true);
  }
  const shown = VERBOSE ? a.moves : a.moves.slice(0, 10);
  shown.forEach((m, i) => printMove(m, i + 1, VERBOSE));
  if (shown.length < a.moves.length) console.log(`\n  ${DIM}${a.moves.length - shown.length} more - --verbose shows them all${RESET}`);
}

function printMove(m: MoveView, n: number, full: boolean): void {
  const head = n ? `${String(n).padStart(2)}.` : "  ";
  const out = m.drop ? `drop ${label(m.drop)}` : m.irMove ? `IR ${label(m.irMove)} first` : "open spot";
  const kind =
    m.kind === "stream"
      ? `${YELLOW}stream wk ${m.peakWeek}${RESET} ${DIM}(${Math.round(m.peakShare * 100)}%)${m.canWait ? " · can wait for the next run" : ""}${RESET}`
      : `${CYAN}hold${RESET}`;
  console.log(`\n${head} ${BOLD}add ${label(m.add)}${RESET}  ${DIM}${out}${RESET}`);
  console.log(
    `    ${GREEN}${signed(m.gain, 2)}/wk${RESET}  this week ${signed(m.gainThisWeek)}  total ${signed(m.pointsTotal)} pts  ${kind}`,
  );
  // A free agent who can wait carries the bid for the later claim, not for now.
  const bidWhen = m.canWait && m.availability.mode === "free_agent" ? "or wait and bid" : "bid";
  const bid = m.bid
    ? ` · ${bidWhen} ${BOLD}$${m.bid.amount}${RESET}${DIM} (~${m.bid.bidders} bidder${m.bid.bidders > 1 ? "s" : ""}, worth ≤$${m.bid.worthCap} to you)`
    : "";
  console.log(`    ${DIM}${m.availability.label}${bid}${RESET}`);
  printVerdict(m, "    ");

  const reasons = full ? m.reasons : m.reasons.slice(0, 3);
  for (const r of reasons) console.log(`    ${DIM}· ${r}${RESET}`);
  if (!full) return;

  if (m.add.usage) console.log(`    ${DIM}usage: ${m.add.usage}${RESET}`);
  console.log(`    ${DIM}schedule: ${strip(m.add)}${RESET}`);
  if (m.dropOptions.length > 1) {
    const opts = m.dropOptions.map((o) => `${o.player ? o.player.name : "no drop"} ${signed(o.gain, 2)}`).join(" · ");
    console.log(`    ${DIM}drop options: ${opts}${RESET}`);
  }
  for (const alt of m.alternatives) {
    console.log(`    ${DIM}similar: ${label(alt.player)} ${signed(alt.gain, 2)}/wk · ${alt.availability.label}${RESET}`);
  }
  for (const line of m.bid?.lines ?? []) console.log(`    ${DIM}bid: ${line}${RESET}`);
}

function printVerdict(m: MoveView, indent: string): void {
  if (m.news) {
    const tone = m.news.outlook === "up" ? GREEN : m.news.outlook === "down" ? RED : DIM;
    console.log(`${indent}${tone}news (${m.news.outlook}): ${m.news.note}${RESET}`);
  }
  if (m.verdict) {
    const tone = m.verdict.verdict === "do" ? GREEN : m.verdict.verdict === "consider" ? YELLOW : RED;
    console.log(`${indent}${tone}${m.verdict.verdict.toUpperCase()}${RESET} ${DIM}${m.verdict.reason}${RESET}`);
  }
}

function printCuts(o: WaiverOverview): void {
  console.log(`\n${BOLD}Safe cuts${RESET} ${DIM}what dropping each costs your weighted lineup (auto horizon)${RESET}`);
  if (!o.cuts.length) console.log(`  ${DIM}none - every player you have earns his spot${RESET}`);
  for (const c of o.cuts) {
    const starts = c.starts ? `${c.starts} start${c.starts > 1 ? "s" : ""}` : "never starts";
    const tag = c.player.injuryStatus ? `  ${YELLOW}${c.player.injuryStatus}${RESET}` : "";
    console.log(
      `  ${label(c.player).padEnd(30)} ${c.cost < 0.1 ? GREEN : ""}${c.cost.toFixed(1).padStart(4)}/wk${RESET}  ` +
        `${DIM}${starts} · ${c.player.perWeek.toFixed(1)} pts/wk projected${RESET}${tag}`,
    );
  }
}

function printLeague(teams: TeamLine[]): void {
  console.log(`\n${BOLD}League${RESET} ${DIM}by playoff odds · holes are this week and next${RESET}`);
  const sorted = [...teams].sort((a, b) => b.playoffOdds - a.playoffOdds || b.pointsFor - a.pointsFor);
  for (const t of sorted) {
    const line =
      `  ${t.teamName.slice(0, 26).padEnd(26)} ${t.record.padEnd(6)} ${t.pointsFor.toFixed(1).padStart(7)} PF  ` +
      `${t.faabLeft == null ? "" : `$${String(t.faabLeft).padStart(3)}  `}` +
      `prio ${String(t.priority ?? "-").padStart(2)}  playoffs ${pct(t.playoffOdds).padStart(4)}` +
      `${t.holes.length ? `  ${t.isMe ? "" : RED}holes ${t.holes.join(", ")}${t.isMe ? "" : RESET}` : ""}`;
    console.log(t.isMe ? `${CYAN}${line}${RESET}` : line);
  }
}

function printNews(job: NewsJobView, seconds: number): void {
  console.log(`\n${BOLD}News${RESET} ${DIM}${job.status} in ${seconds}s${RESET}`);
  if (job.status === "error") {
    console.log(`  ${RED}${job.error}${RESET}`);
    return;
  }
  if (job.summary) console.log(`  ${job.summary}`);
  for (const it of job.items) {
    const tone = it.outlook === "up" ? GREEN : it.outlook === "down" ? RED : DIM;
    console.log(`  ${tone}${it.outlook.padEnd(7)}${RESET} ${BOLD}${it.name}${RESET} ${DIM}${it.note}${RESET}`);
  }
  for (const v of job.verdicts) {
    const tone = v.verdict === "do" ? GREEN : v.verdict === "consider" ? YELLOW : RED;
    console.log(`  ${tone}${v.verdict.toUpperCase().padEnd(8)}${RESET} add ${v.name} ${DIM}${v.reason}${RESET}`);
  }
  console.log(
    `  ${DIM}cost $${job.costUsd.toFixed(2)} · ${job.searches} web search${job.searches === 1 ? "" : "es"}` +
      `${job.cachedPlayers ? ` · ${job.cachedPlayers} player${job.cachedPlayers > 1 ? "s" : ""} from today's cache` : ""}${RESET}`,
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function label(p: PlayerCard): string {
  // The fixture league's names already lead with the position ("WR Player8").
  const name = p.name.startsWith(`${p.position} `) ? p.name : `${p.position} ${p.name}`;
  return `${name}${p.team ? ` ${p.team}` : ""}${p.injuryStatus ? ` (${p.injuryStatus})` : ""}`;
}

/** The next few weeks as the projections see them: "7 @MIA 12.3+ · 8 bye · 9 vs NYJ 8.1-". */
function strip(p: PlayerCard): string {
  return p.strip
    .slice(0, 6)
    .map((w) => {
      if (w.tone === "bye") return `${w.week} bye`;
      const mark = w.tone === "good" ? "+" : w.tone === "bad" ? "-" : w.tone === "out" ? " out" : "";
      return `${w.week} ${w.home ? "vs " : "@"}${w.opponent ?? "?"} ${w.points.toFixed(1)}${mark}`;
    })
    .join(" · ");
}

function until(ms: number): string {
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
const pct = (p: number): string => (p > 0 && p < 0.01 ? "<1%" : `${Math.round(p * 100)}%`);

main().catch((err) => {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
  console.error(`\n${RED}${err instanceof Error ? err.message : err}${RESET}\n`);
  process.exit(1);
});
