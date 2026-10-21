/**
 * Turning waiver arithmetic into reasons.
 *
 * Same rule as the trade analyzer: every sentence is derived from the numbers the
 * search ranked on, so the words cannot drift from the math. Two kinds of context
 * ride along that the ranking deliberately ignores - recent usage and how the
 * crowd is reacting - because the projections already price them in (measured:
 * an opportunity jump moves next week's projection, and adds nothing beyond it).
 * They are shown beside the reasons so you can sanity-check a pick (`usageLine`,
 * the trending counts on each player card), never as a reason it ranked.
 */

import type { TeamSchedule } from "../data/schedule.ts";
import type { WeekLine } from "../data/usage.ts";
import { availabilityNote } from "../trade/explain.ts";
import type { TradeUniverse } from "../trade/value.ts";
import type { Availability } from "./availability.ts";
import type { WaiverMove } from "./search.ts";
import type { Cut, Hole } from "./streams.ts";

export interface StripWeek {
  week: number;
  opponent: string | null;
  home: boolean;
  points: number;
  /**
   * His projection that week against his own average: the projections already
   * fold in the opponent, so this is the matchup as the numbers see it.
   */
  tone: "good" | "bad" | "even" | "bye" | "out";
}

/** The rest of his season, week by week, from the projections. */
export function scheduleStrip(u: TradeUniverse, playerId: string, schedule: TeamSchedule): StripWeek[] {
  const p = u.players.get(playerId);
  if (!p) return [];
  const played = p.weekly.filter((x) => x > 0);
  const mean = played.length ? played.reduce((a, b) => a + b, 0) / played.length : 0;
  return u.weeks.map((week, i) => {
    const game = p.team ? schedule[p.team]?.[week] : undefined;
    const pts = p.weekly[i] ?? 0;
    const tone: StripWeek["tone"] = !game
      ? "bye"
      : pts <= 0
        ? "out"
        : mean > 0 && pts >= mean * 1.15
          ? "good"
          : mean > 0 && pts <= mean * 0.85
            ? "bad"
            : "even";
    return { week, opponent: game?.opponent ?? null, home: game?.home ?? false, points: round1(pts), tone };
  });
}

/** Last few games: points, snap share, looks. Context, not a ranking input. */
export function usageLine(lines: WeekLine[] | undefined, games = 3): string | null {
  const recent = (lines ?? []).slice(-games);
  if (!recent.length) return null;
  const pts = recent.map((l) => l.points.toFixed(1)).join(", ");
  const snaps = recent.map((l) => l.snapShare).filter((s): s is number => s != null);
  const looks = recent.reduce((a, l) => a + l.targets + l.carries, 0) / recent.length;
  const parts = [`last ${recent.length}: ${pts} pts`];
  if (snaps.length >= 2) {
    const first = Math.round(snaps[0]! * 100);
    const last = Math.round(snaps.at(-1)! * 100);
    parts.push(first === last ? `${last}% of snaps` : `snaps ${first}% → ${last}%`);
  } else if (snaps.length) parts.push(`${Math.round(snaps[0]! * 100)}% of snaps`);
  if (looks >= 1) parts.push(`${looks.toFixed(1)} carries+targets/game`);
  return parts.join(" · ");
}

export interface ReasonContext {
  u: TradeUniverse;
  /** Weighted-gain cuts for your roster, cheapest first. */
  cuts: Cut[];
  /** Your holes by window week index. */
  holes: Map<number, Hole[]>;
  managerName: (rosterId: number) => string;
  formatTime: (epochMs: number) => string;
}

/** Why this move, in plain words, best reason first. */
export function moveReasons(ctx: ReasonContext, m: WaiverMove, availability: Availability): string[] {
  const { u } = ctx;
  const name = (id: string | null) => (id ? (u.players.get(id)?.name ?? id) : "");
  const weeks = u.weeks.length;
  const out: string[] = [];
  const peakWeek = u.weeks[m.peakWeek];

  // What it does.
  const filled = (ctx.holes.get(m.peakWeek) ?? []).find((h) =>
    h.eligible.includes(u.players.get(m.add)?.position ?? ""),
  );
  if (filled && (m.weeklyDelta[m.peakWeek] ?? 0) > 0) {
    const why = filled.reason === "bye" ? "on bye" : filled.reason === "out" ? "out" : "thin";
    out.push(
      `Fills your week ${peakWeek} ${filled.slot} hole${filled.usual ? ` (${name(filled.usual)} ${why})` : ""}: +${(m.weeklyDelta[m.peakWeek] ?? 0).toFixed(1)} pts`,
    );
  }
  if (m.kind === "stream") {
    out.push(`A one-week stream: ${Math.round(m.peakShare * 100)}% of the value is week ${peakWeek} - drop him after`);
  } else if (m.starts > 0) {
    out.push(`Starts ${m.starts >= weeks - 1 ? "every week" : `${m.starts} of ${weeks} weeks`} for you`);
  } else {
    out.push("Depth and injury cover rather than a starter");
  }
  if (m.startWeek > 0) out.push("His game this week is locked - the claim helps from next week");

  // What it costs.
  if (m.drop) {
    const cut = ctx.cuts.find((c) => c.playerId === m.drop);
    out.push(
      cut && cut.cost < 0.1
        ? `${name(m.drop)} is dead weight for you (${cut.starts ? `${cut.starts} start${cut.starts > 1 ? "s" : ""}` : "never starts"})`
        : `Cutting ${name(m.drop)} costs ${(cut?.cost ?? 0).toFixed(1)} pts/wk`,
    );
  } else if (m.irMove) {
    out.push(`No cut needed: move ${name(m.irMove)} to IR first`);
  } else {
    out.push("No cut needed: you have an open roster spot");
  }

  // When he can be had is shown beside the reasons (the availability label);
  // the one fact it leaves out is a fresh drop's timing.
  if (availability.mode === "waivers" && availability.droppedBy != null) {
    out.push(`Just dropped by ${ctx.managerName(availability.droppedBy)} - on waivers until ~${ctx.formatTime(availability.processesAt!)}`);
  }

  const note = availabilityNote(u, m.add);
  if (note) out.push(note);
  return out;
}

/** A one-line read of a hole: what is missing and the best fills. */
export function holeLine(u: TradeUniverse, h: Hole): string {
  const name = (id: string | null) => (id ? (u.players.get(id)?.name ?? id) : "nobody");
  const why = h.reason === "bye" ? "on bye" : h.reason === "out" ? "out" : "thin";
  return `Week ${u.weeks[h.weekIndex]} ${h.slot}: ${h.usual ? `${name(h.usual)} ${why}` : "nobody to start"}${h.best ? `, best left is ${name(h.best)} (${h.bestPoints.toFixed(1)})` : ""}`;
}

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
