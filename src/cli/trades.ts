/**
 * `bun run trades` - the trade analyzer in the terminal.
 *
 * Same service the web page calls, so what prints here is what the page shows.
 * Read the output the way you would read a mock draft: the individual numbers can
 * all be right while the trades they add up to are silly, and this is the fastest
 * way to see that.
 *
 *   bun run trades                       best trades across the league
 *   bun run trades --team="Bijan"        only with one team (name, manager, or roster id)
 *   bun run trades --get="Puka Nacua"    trades that land a specific player
 *   bun run trades --give="Kelce"        trades that move one of yours
 *   bun run trades --keep="St. Brown"    never offer this player
 *   bun run trades --max=3 --sort=gain   bigger packages; sort by your gain alone
 *   bun run trades --league              also print every team's needs and surplus
 *   bun run trades --fixtures            offline fixture league, no network
 *   bun run trades --refresh             refetch projections, not just rosters
 */

import { TradeService, liveTradeSource, type TeamView, type TradeView } from "../server/trades.ts";
import { fixtureTradeSource } from "../../fixtures/trade.ts";
import { ordinal } from "../trade/explain.ts";
import type { TradeSort } from "../trade/search.ts";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function flag(name: string): string | null {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
}

const list = (v: string | null) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

async function main(): Promise<void> {
  const service = new TradeService(flag("fixtures") != null ? fixtureTradeSource() : liveTradeSource());
  const overview = await service.overview({ refresh: flag("refresh") != null });
  const { league } = overview;
  const me = overview.teams.find((t) => t.isMe)!;

  console.log(`\n${BOLD}${league.name}${RESET} ${DIM}${league.scoring}${RESET}`);
  console.log(
    `${DIM}NFL week ${league.nflWeek} · valuing weeks ${league.weeks[0]}-${league.weeks.at(-1)} ` +
      `(${league.weeks.length}) · ${league.tradeDeadline ? `trade deadline week ${league.tradeDeadline}` : "no trade deadline"}` +
      `${overview.source === "season_fallback" ? ` · ${YELLOW}season-total fallback${RESET}${DIM}` : ""}${RESET}`,
  );
  if (league.deadlinePassed) console.log(`${RED}The trade deadline has passed.${RESET}`);

  if (flag("league") != null) printLeague(overview.teams, overview.positions);
  printTeam(me, overview.positions);

  // Names to ids, across every roster.
  const everyone = overview.teams.flatMap((t) => t.players.map((p) => ({ ...p, rosterId: t.rosterId })));
  const resolve = (query: string, mineOnly: boolean | null) => {
    const q = query.toLowerCase();
    const pool = everyone.filter((p) => (mineOnly == null ? true : mineOnly ? p.rosterId === me.rosterId : p.rosterId !== me.rosterId));
    const hit = pool.find((p) => p.playerId === query) ?? pool.find((p) => p.name.toLowerCase() === q) ?? pool.find((p) => p.name.toLowerCase().includes(q));
    if (!hit) throw new Error(`No ${mineOnly ? "player of yours" : mineOnly === false ? "rostered player on another team" : "player"} matches "${query}"`);
    return hit.playerId;
  };

  const teamFlag = flag("team");
  let partner: number | null = null;
  if (teamFlag) {
    const q = teamFlag.toLowerCase();
    const team = overview.teams.find(
      (t) => String(t.rosterId) === teamFlag || t.teamName.toLowerCase().includes(q) || t.manager.toLowerCase().includes(q),
    );
    if (!team) throw new Error(`No team matches "${teamFlag}"`);
    partner = team.rosterId;
  }

  const sort = (flag("sort") as TradeSort | null) || undefined;
  const result = await service.analyze({
    partner,
    give: list(flag("give")).map((q) => resolve(q, true)),
    get: list(flag("get")).map((q) => resolve(q, false)),
    keep: list(flag("keep")).map((q) => resolve(q, true)),
    maxPerSide: flag("max") ? Number(flag("max")) : undefined,
    sort,
  });

  console.log(
    `\n${BOLD}Trades${RESET} ${DIM}${result.considered.toLocaleString()} package pairs, ` +
      `${result.evaluated.toLocaleString()} valued on both rosters, ${result.elapsedMs}ms${RESET}`,
  );
  for (const note of result.notes) console.log(`${YELLOW}${note}${RESET}`);

  if (result.proposal) {
    console.log(`\n${BOLD}Your proposal${RESET}`);
    printTrade(result.proposal, 0);
  }
  result.trades.forEach((t, i) => printTrade(t, i + 1));
  console.log();
}

function printLeague(teams: TeamView[], positions: string[]): void {
  console.log(`\n${BOLD}League${RESET} ${DIM}position ranks are starting strength, 1 = best${RESET}`);
  const sorted = [...teams].sort((a, b) => a.rank - b.rank);
  for (const t of sorted) {
    const ranks = positions.map((p) => `${p} ${String(t.positions[p]?.rank ?? "-").padStart(2)}`).join("  ");
    const line =
      `${String(t.rank).padStart(2)}. ${t.teamName.slice(0, 26).padEnd(26)} ${t.record.padEnd(5)} ` +
      `${t.perWeek.toFixed(1).padStart(6)}/wk  ${ranks}` +
      `${t.needs.length ? `  ${RED}need ${t.needs.join(",")}${RESET}` : ""}` +
      `${t.surplus.length ? `  ${GREEN}surplus ${t.surplus.join(",")}${RESET}` : ""}`;
    console.log(t.isMe ? `${CYAN}${line}${RESET}` : line);
  }
}

function printTeam(t: TeamView, positions: string[]): void {
  console.log(
    `\n${BOLD}Your team${RESET} ${t.teamName} ${DIM}${t.record} · ${t.perWeek.toFixed(1)} pts/wk projected, ${ordinal(t.rank)} in the league${RESET}`,
  );
  console.log(`  ${positions.map((p) => `${p} ${ordinal(t.positions[p]?.rank ?? 0)}`).join(" · ")}`);
  for (const p of t.players) {
    const role = p.startShare >= 0.5 ? `${GREEN}start${RESET}` : `${DIM}bench${RESET}`;
    const tag = [...new Set([p.reserve ? "IR" : "", p.injuryStatus ?? ""])].filter(Boolean).join(" ");
    console.log(
      `  ${p.position.padEnd(4)}${p.name.padEnd(24)} ${p.perWeek.toFixed(1).padStart(5)}/wk  ` +
        `${DIM}value ${String(Math.round(p.marketValue)).padStart(3)}${RESET}  ${role} ${DIM}${Math.round(p.startShare * 100)}%${RESET}` +
        `${tag ? `  ${YELLOW}${tag}${RESET}` : ""}`,
    );
  }
}

function printTrade(t: TradeView, n: number): void {
  const names = (ps: TradeView["give"]) => ps.map((p) => `${p.position} ${p.name}`).join(" + ");
  const label = t.label === "win-win" ? `${GREEN}WIN-WIN${RESET}` : t.label === "fair" ? "fair" : `${RED}fails${RESET}`;
  const head = n ? `${String(n).padStart(2)}.` : "  ";
  console.log(
    `\n${head} ${BOLD}${t.partner.teamName}${RESET} ${DIM}(${t.partner.manager})${RESET}  ${label}  ` +
      `${DIM}accept ~${Math.round(t.acceptance * 100)}%` +
      `${t.alternatives ? ` · ${t.alternatives} similar variation${t.alternatives > 1 ? "s" : ""}` : ""}${RESET}`,
  );
  console.log(`    give ${names(t.give)}`);
  console.log(`    get  ${names(t.get)}`);
  const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
  console.log(
    `    ${GREEN}you ${signed(t.myGain)}/wk${RESET}  them ${signed(t.theirGain)}/wk  ` +
      `${DIM}paper ${Math.round(t.marketRatio * 100)}% for them${RESET}`,
  );
  const deltas = Object.entries(t.myPositionDelta)
    .filter(([, d]) => Math.abs(d) >= 0.3)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([pos, d]) => `${pos} ${signed(d)}`);
  if (deltas.length) console.log(`    ${DIM}your lineup by position: ${deltas.join(", ")}${RESET}`);
  for (const p of t.problems) console.log(`    ${RED}✗ ${p}${RESET}`);
  console.log(`    ${DIM}you:  ${t.forMe.slice(1).join(" · ")}${RESET}`);
  console.log(`    ${DIM}them: ${t.forThem.join(" · ")}${RESET}`);
  if (process.argv.includes("--pitch")) console.log(`    ${CYAN}"${t.pitch}"${RESET}`);
}

main().catch((err) => {
  console.error(`\n${RED}${err instanceof Error ? err.message : err}${RESET}\n`);
  process.exit(1);
});
