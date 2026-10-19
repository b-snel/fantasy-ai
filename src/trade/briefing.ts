/**
 * The briefing Claude reads before judging a trade.
 *
 * Everything in it is computed, nothing is opinion: the league's rules, the
 * standings, the engine's evaluation of the trade, both rosters week by week, and
 * the free agents that would fill a spot. It is plain text on purpose - it doubles
 * as a readable record of exactly what the model was told - and deterministic, so
 * the same trade on the same rosters always produces the same briefing.
 */

import { FLEX_ELIGIBILITY } from "../engine/replacement.ts";
import type { League } from "../sleeper/types.ts";
import type { PlayerRef, PlayerView, TeamView, TradeView } from "../server/trades.ts";
import { ordinal } from "./explain.ts";

export interface BriefingInput {
  league: League;
  teams: TeamView[];
  positions: string[];
  me: number;
  trade: TradeView;
  nflWeek: number;
  weeks: number[];
  /** YYYY-MM-DD where the games are played. */
  today: string;
  freeAgents: Array<Pick<PlayerView, "name" | "position" | "team" | "perWeek" | "injuryStatus">>;
}

export function buildBriefing(b: BriefingInput): string {
  const me = b.teams.find((t) => t.rosterId === b.me)!;
  const them = b.teams.find((t) => t.rosterId === b.trade.partner.rosterId)!;
  const lines: string[] = [];
  const push = (...xs: string[]) => lines.push(...xs);

  // --- league -----------------------------------------------------------------
  const settings = b.league.settings ?? {};
  const playoffStart = settings.playoff_week_start ?? 0;
  const playoffTeams = settings.playoff_teams ?? 0;
  const deadline = settings.trade_deadline ?? 0;
  push(
    `## League`,
    `${b.league.name}, ${b.teams.length} teams. Scoring: ${scoringLine(b)}.`,
    `Lineup: ${lineupLine(b.league)}.`,
    `Today is ${b.today}, NFL week ${b.nflWeek}.` +
      (playoffStart
        ? ` The fantasy regular season runs through week ${playoffStart - 1}; ${playoffTeams || "the top"} teams make the playoffs, weeks ${playoffStart}-${b.weeks.at(-1)}.`
        : "") +
      (deadline ? ` Trade deadline: week ${deadline}.` : ""),
    `All projections below cover weeks ${b.weeks[0]}-${b.weeks.at(-1)}; a game already played this week counts as 0.`,
    "",
  );

  // --- standings --------------------------------------------------------------
  const standings = [...b.teams].sort((x, y) => y.wins - x.wins || x.losses - y.losses || y.pointsFor - x.pointsFor);
  push(`## Standings (record, points for, engine-projected lineup points per week from here)`);
  standings.forEach((t, i) => {
    const tag = t.rosterId === b.me ? "YOU - " : t.rosterId === them.rosterId ? "TRADE PARTNER - " : "";
    push(
      `${String(i + 1).padStart(2)}. ${tag}${t.teamName} (${t.manager}) ${t.record}, ${Math.round(t.pointsFor)} PF, ` +
        `${t.perWeek.toFixed(1)}/wk (${ordinal(t.rank)})`,
    );
  });
  if (playoffTeams && standings[playoffTeams - 1]) {
    push(`Last playoff spot right now: ${standings[playoffTeams - 1]!.record}.`);
  }
  push("");

  // --- the trade --------------------------------------------------------------
  const t = b.trade;
  const refs = (ps: PlayerRef[]) =>
    ps.map((p) => `${p.position} ${p.name}${p.team ? ` (${p.team})` : ""}${p.injuryStatus ? ` [${p.injuryStatus}]` : ""}`).join(", ");
  push(
    `## The trade under review`,
    `You give: ${refs(t.give)}`,
    `You get from ${them.teamName} (${them.manager}, ${them.record}): ${refs(t.get)}`,
    "",
    `## Engine evaluation`,
    `Your lineup: ${t.myBefore.toFixed(1)} -> ${t.myAfter.toFixed(1)} pts/wk (${signed(t.myGain)}).`,
    `Their lineup: ${t.theirBefore.toFixed(1)} -> ${t.theirAfter.toFixed(1)} pts/wk (${signed(t.theirGain)}).`,
    `On paper they receive ${Math.round(t.marketRatio * 100)}% of the rest-of-season value they send. ` +
      `Rough acceptance likelihood: ${Math.round(t.acceptance * 100)}%.`,
    t.passes
      ? `Clears all three bars (helps you, does not hurt them, fair on paper): ${t.label}.`
      : `Does not clear the bar: ${t.problems.join("; ")}.`,
  );
  const deltas = Object.entries(t.myPositionDelta).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  if (deltas.length) push(`Your lineup by position, pts/wk: ${deltas.map(([p, d]) => `${p} ${signed(d)}`).join(", ")}.`);
  push(`Your change week by week: ${t.weeklyDelta.map((d, i) => `w${b.weeks[i]} ${signed(d)}`).join(", ")}.`);
  const moves = [
    t.myDrops.length ? `you would cut ${t.myDrops.map((p) => p.name).join(", ")}` : "",
    t.theirDrops.length ? `they would cut ${t.theirDrops.map((p) => p.name).join(", ")}` : "",
  ].filter(Boolean);
  if (moves.length) push(`Roster moves to stay legal: ${moves.join("; ")}.`);
  push(`Engine notes for you: ${t.forMe.join("; ")}.`, `Engine notes for them: ${t.forThem.join("; ")}.`, "");

  // --- rosters ----------------------------------------------------------------
  push(rosterBlock(`Your roster - ${me.teamName}`, me, b), "", rosterBlock(`Their roster - ${them.teamName}`, them, b), "");

  push(
    `## Starting strength by position, league rank (1 = best)`,
    `You: ${strengthLine(me, b.positions)}${me.needs.length ? `. Needs: ${me.needs.join(", ")}` : ""}.`,
    `Them: ${strengthLine(them, b.positions)}${them.needs.length ? `. Needs: ${them.needs.join(", ")}` : ""}.`,
    "",
  );

  // --- free agents ------------------------------------------------------------
  if (b.freeAgents.length) {
    push(`## Best free agents (what an open roster spot is worth)`);
    for (const pos of b.positions) {
      const fas = b.freeAgents.filter((p) => p.position === pos).slice(0, 3);
      if (fas.length) {
        push(`${pos}: ${fas.map((p) => `${p.name}${p.team ? ` (${p.team})` : ""} ${p.perWeek.toFixed(1)}/wk${p.injuryStatus ? ` [${p.injuryStatus}]` : ""}`).join(", ")}`);
      }
    }
    push("");
  }

  push(`Should I make this trade as proposed? If not, is there a version of it worth offering instead?`);
  return lines.join("\n");
}

function rosterBlock(title: string, team: TeamView, b: BriefingInput): string {
  const header =
    `## ${title} (${team.record})\n` +
    `Columns: position, player, status, projected pts/wk, share of remaining weeks in the best lineup, then weeks ${b.weeks.join(" ")}`;
  const rows = team.players.map((p) => {
    const tags = [p.reserve ? "IR slot" : "", p.injuryStatus && !(p.reserve && p.injuryStatus === "IR") ? p.injuryStatus : ""]
      .filter(Boolean)
      .join(", ");
    return (
      `${p.position.padEnd(3)} ${p.name}${p.team ? ` (${p.team})` : ""}${tags ? ` [${tags}]` : ""} | ` +
      `${p.perWeek.toFixed(1)}/wk | starts ${Math.round(p.startShare * 100)}% | ${p.weekly.map((v) => v.toFixed(1)).join(" ")}`
    );
  });
  return [header, ...rows].join("\n");
}

function strengthLine(team: TeamView, positions: string[]): string {
  return positions.map((p) => `${p} ${ordinal(team.positions[p]?.rank ?? 0)}`).join(", ");
}

function scoringLine(b: BriefingInput): string {
  const s = b.league.scoring_settings;
  const rec = s.rec ?? 0;
  const ppr = rec >= 1 ? "full PPR" : rec >= 0.5 ? "half PPR" : rec > 0 ? `${rec} per reception` : "standard (no PPR)";
  return `${ppr}, ${s.pass_td ?? 4}-point passing TDs, ${s.rush_td ?? 6}-point rushing and receiving TDs` +
    (s.bonus_rec_te ? `, TE premium +${s.bonus_rec_te}/rec` : "");
}

function lineupLine(league: League): string {
  const slots = league.roster_positions;
  const starters = slots.filter((s) => s !== "BN" && s !== "IR" && s !== "TAXI");
  const flexes = [...new Set(starters.filter((s) => s in FLEX_ELIGIBILITY))]
    .map((s) => `${s} takes ${(FLEX_ELIGIBILITY[s] ?? []).join("/")}`)
    .join("; ");
  const bench = slots.filter((s) => s === "BN").length;
  const ir = league.settings?.reserve_slots ?? 0;
  const noKicker = starters.includes("K") ? "" : "; no kicker slot";
  return `${starters.join(", ")}, ${bench} bench, ${ir} IR${flexes ? ` (${flexes})` : ""}${noKicker}`;
}

const signed = (n: number): string => `${n > 0 ? "+" : n < 0 ? "-" : "±"}${Math.abs(n).toFixed(1)}`;
