/**
 * The orchestrator: turns raw Sleeper payloads into a scored board and a shortlist.
 *
 * This is the seam between "data we fetched" and "advice we can give". It is a pure
 * function of its inputs so the mock runner and the live server share exactly one
 * code path - the thing that runs on draft day is the thing the tests exercise.
 */

import { config } from "../config.ts";
import { parseRosterPositions, replacementPoints, replacementRanks } from "./replacement.ts";
import { evaluateRoster, type OwnedPlayer, type RosterState } from "./roster.ts";
import { buildShortlist, scoreBoard, type RankablePlayer, type ScoredPlayer } from "./rank.ts";
import { buildDraftShape, getTurnInfo, myRosterIdFromDraft, rosterOfMadePick, type DraftShape, type TurnInfo } from "./snake.ts";
import { isFantasyPosition } from "../sleeper/types.ts";
import type {
  Draft,
  DraftPick,
  League,
  PlayersIndex,
  Roster,
  TradedPick,
} from "../sleeper/types.ts";
import type { ProjectionTable } from "../data/projections.ts";
import type { ByeWeeks } from "../data/schedule.ts";

export interface BoardInputs {
  league: League;
  draft: Draft;
  picks: DraftPick[];
  tradedPicks: TradedPick[];
  rosters: Roster[];
  players: PlayersIndex;
  projections: ProjectionTable;
  byeWeeks: ByeWeeks;
  /** player_id -> 24h add count. */
  trending: Map<string, number>;
  /** player_id -> short news blurb from the pre-draft sweep. */
  news: Map<string, string>;
  userId: string;
}

export interface BoardState {
  shape: DraftShape;
  turn: TurnInfo;
  myRosterId: number | null;
  mySlot: number | null;
  roster: RosterState;
  myPlayers: OwnedPlayer[];
  board: ScoredPlayer[];
  shortlist: ScoredPlayer[];
  recentPicks: Array<{ pickNo: number; name: string; position: string; team: string | null }>;
  /** Positional run detection: the dominant position among the last several picks. */
  positionalRun: { position: string; count: number; window: number } | null;
  /** Tiers that are one or two players from emptying, at positions you still need. */
  tierWarnings: Array<{ position: string; tier: number; remaining: number; cliff: number }>;
  projectionSource: string;
  totalPicks: number;
  /**
   * How much separation there is at the top of the board, in points-equivalent
   * units, and whether the pick is effectively a coin flip.
   */
  decisiveness: Decisiveness;
}

export interface Decisiveness {
  /** Score gap between the top candidate and the fifth. */
  spread: number;
  topScore: number;
  /**
   * True when the leading options are close enough that the choice barely matters.
   * Worth saying out loud: in round one the top of the board is separated by
   * hundreds of points, and by round fourteen everything left is within noise of
   * everything else. An assistant that projects the same confidence in both cases
   * is lying to you in one of them.
   */
  effectivelyTied: boolean;
}

export function computeBoard(input: BoardInputs): BoardState {
  const { league, draft, picks, tradedPicks, rosters, players, projections, byeWeeks } = input;

  const shape = buildDraftShape(draft, tradedPicks);
  const req = parseRosterPositions(league.roster_positions);

  const myRosterId =
    myRosterIdFromDraft(draft, input.userId) ??
    rosters.find((r) => r.owner_id === input.userId)?.roster_id ??
    null;
  const mySlot = draft.draft_order?.[input.userId] ?? null;

  const turn = getTurnInfo(picks.length, myRosterId ?? -1, shape);

  // Drafted players are off the board. A pick's player_id is authoritative; its
  // metadata is only a display snapshot.
  const drafted = new Set(picks.map((p) => p.player_id));

  const myPicks = picks.filter((p) => rosterOfMadePick(p, shape) === myRosterId);
  const myPlayers: OwnedPlayer[] = myPicks.map((p) => {
    const player = players[p.player_id];
    const team = player?.team ?? p.metadata?.team ?? null;
    return {
      playerId: p.player_id,
      position: player?.position ?? p.metadata?.position ?? "NA",
      team,
      byeWeek: team ? (byeWeeks[team] ?? null) : null,
    };
  });

  const picksRemaining = turn.myUpcomingPicks.length;
  const roster = evaluateRoster(myPlayers, req, picksRemaining);

  // Two pools are needed, and conflating them is a subtle way to get VORP wrong.
  // `allProjectable` is every draftable player regardless of whether they are gone;
  // it defines replacement level, which is a property of league structure and must
  // not move during the draft. `available` is who you can actually pick.
  const allProjectable: Array<{ position: string; points: number }> = [];
  const available: RankablePlayer[] = [];

  for (const [playerId, player] of Object.entries(players)) {
    const pos = player.position;
    if (isFantasyPosition(pos) && player.active !== false) {
      const proj = projections.get(playerId);
      if (proj) allProjectable.push({ position: pos, points: proj.points });
    }

    if (drafted.has(playerId)) continue;
    const position = player.position;
    if (!isFantasyPosition(position)) continue;
    if (player.active === false) continue;
    const projection = projections.get(playerId);
    if (!projection) continue;

    const team = player.team ?? null;
    available.push({
      playerId,
      name: player.full_name ?? (`${player.first_name ?? ""} ${player.last_name ?? ""}`.trim() || playerId),
      position,
      team,
      byeWeek: team ? (byeWeeks[team] ?? null) : null,
      projectedPoints: projection.points,
      adp: projection.adp,
      injuryStatus: player.injury_status ?? null,
      practiceParticipation: player.practice_participation ?? null,
      age: player.age ?? null,
      yearsExp: player.years_exp ?? null,
      depthChartOrder: player.depth_chart_order ?? null,
      trendingAdds: input.trending.get(playerId) ?? 0,
      newsNote: input.news.get(playerId) ?? null,
    });
  }

  // Replacement level comes from the full pool so it stays fixed for the whole
  // draft. Scarcity is expressed through VONA and survival, which model *when* a
  // player disappears - not by quietly redefining what "replacement" means.
  const byPosition = new Map<string, number[]>();
  for (const p of allProjectable) {
    const list = byPosition.get(p.position) ?? [];
    list.push(p.points);
    byPosition.set(p.position, list);
  }
  for (const list of byPosition.values()) list.sort((a, b) => b - a);

  const board = scoreBoard(available, {
    currentPick: turn.currentPick,
    myNextPick: turn.myNextPick,
    myPickAfterNext: turn.myPickAfterNext,
    roster,
    replacementPoints: replacementPoints(byPosition, replacementRanks(req, shape.teams)),
    picksRemaining,
    requirements: req,
  });

  const shortlist = buildShortlist(board, config.engine.shortlistSize);

  const recentPicks = picks.slice(-8).map((p) => {
    const player = players[p.player_id];
    return {
      pickNo: p.pick_no,
      name:
        player?.full_name ??
        ([p.metadata?.first_name, p.metadata?.last_name].filter(Boolean).join(" ") || p.player_id),
      position: player?.position ?? p.metadata?.position ?? "NA",
      team: player?.team ?? p.metadata?.team ?? null,
    };
  });

  return {
    shape,
    turn,
    myRosterId,
    mySlot,
    roster,
    myPlayers,
    board,
    shortlist,
    recentPicks,
    positionalRun: detectRun(picks, players),
    tierWarnings: findTierWarnings(shortlist, roster),
    projectionSource: projections.values().next().value?.source ?? "unknown",
    totalPicks: shape.teams * shape.rounds,
    decisiveness: measureDecisiveness(shortlist),
  };
}

/** How separated the top of the shortlist is. */
export function measureDecisiveness(shortlist: ScoredPlayer[]): Decisiveness {
  const top = shortlist[0]?.score ?? 0;
  const fifth = shortlist[Math.min(4, shortlist.length - 1)]?.score ?? top;
  const spread = Math.round((top - fifth) * 10) / 10;

  // Both an absolute and a relative test. Ten points of separation is decisive when
  // the leader scores 40 and meaningless when the leader scores 300; five points of
  // separation is noise either way.
  const effectivelyTied = spread < 5 || (top > 0 && spread / top < 0.12);

  return { spread, topScore: Math.round(top * 10) / 10, effectivelyTied };
}

/**
 * Is there a run on? Looks at the last several picks and reports a position taking
 * a clear majority. Runs are the main reason a board changes faster than ADP
 * predicts, and noticing one late is how managers get squeezed.
 */
export function detectRun(
  picks: DraftPick[],
  players: PlayersIndex,
  window = 6,
  threshold = 4,
): { position: string; count: number; window: number } | null {
  if (picks.length < window) return null;
  const recent = picks.slice(-window);
  const counts = new Map<string, number>();
  for (const p of recent) {
    const position = players[p.player_id]?.position ?? p.metadata?.position;
    if (!position || !isFantasyPosition(position)) continue;
    counts.set(position, (counts.get(position) ?? 0) + 1);
  }
  let best: { position: string; count: number } | null = null;
  for (const [position, count] of counts) {
    if (!best || count > best.count) best = { position, count };
  }
  return best && best.count >= threshold ? { ...best, window } : null;
}

/**
 * Tiers about to empty at positions the roster still needs.
 *
 * The naive version of this - "warn whenever a tier has two or fewer players left" -
 * fires constantly, because at the top of a draft every elite player sits alone in
 * their own tier by construction. Eight simultaneous warnings is the same as none.
 *
 * A warning earns its place only when the drop after the tier is large enough to
 * change a decision, so the cliff must clear the position's own tier threshold by a
 * real margin. The list is capped and ordered by urgency.
 */
function findTierWarnings(
  shortlist: ScoredPlayer[],
  roster: RosterState,
  maxWarnings = 3,
): Array<{ position: string; tier: number; remaining: number; cliff: number }> {
  const seen = new Set<string>();
  const out: Array<{ position: string; tier: number; remaining: number; cliff: number }> = [];

  for (const p of shortlist) {
    const key = `${p.position}:${p.tier}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (p.tierRemaining > 2) continue;

    const need = (roster.needs as Record<string, { urgency: number } | undefined>)[p.position];
    if ((need?.urgency ?? 0) <= 0.1) continue;

    // The drop has to be worth acting on, not merely large enough to have started a
    // new tier. 1.5x the position's own threshold is the bar.
    const threshold = config.engine.tierGapPoints[p.position] ?? config.engine.defaultTierGap;
    if (p.cliffBelow < threshold * 1.5) continue;

    out.push({
      position: p.position,
      tier: p.tier,
      remaining: p.tierRemaining,
      cliff: p.cliffBelow,
    });
  }

  return out
    .sort((a, b) => a.remaining - b.remaining || b.cliff - a.cliff)
    .slice(0, maxWarnings);
}
