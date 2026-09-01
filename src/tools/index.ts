/**
 * The engine, exposed as Claude tools.
 *
 * These are the same functions the recommendation pipeline calls directly. The
 * pipeline uses them deterministically because it knows exactly what it needs; the
 * ask endpoint hands them to the model because an open-ended question ("should I go
 * best-available or fill my flex?", "who is left at tight end?") genuinely needs
 * model-driven exploration.
 *
 * One implementation, two surfaces. The important consequence is that the numbers
 * the model quotes back at you in a conversation are the same numbers on the cards,
 * computed the same way, rather than a second parallel path that can drift.
 */

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import type { BoardState } from "../engine/board.ts";
import type { ScoredPlayer } from "../engine/rank.ts";

/** Everything the tools read. Rebuilt on every ask so answers reflect live state. */
export interface ToolContext {
  board: BoardState;
  leagueName: string;
  scoringSummary: string;
}

/** Compact player row. Kept small deliberately - this lands in the context window. */
function row(p: ScoredPlayer) {
  return {
    player_id: p.playerId,
    name: p.name,
    position: p.position,
    team: p.team,
    bye: p.byeWeek,
    projected_points: Math.round(p.projectedPoints),
    vorp: Math.round(p.vorp),
    vona: Math.round(p.vona),
    tier: p.tier,
    left_in_tier: p.tierRemaining,
    survival_to_my_next_pick: p.survival,
    adp_delta: p.adpDelta,
    score: Math.round(p.score),
    injury: p.injuryStatus,
    news: p.newsNote ?? null,
  };
}

export function buildTools(getContext: () => ToolContext) {
  const draftState = betaZodTool({
    name: "get_draft_state",
    description:
      "Where the draft stands: current pick, whose turn, how many picks until the " +
      "user's turn, their roster, unfilled starting slots, positional runs, and " +
      "tier warnings. Call this first for almost any question.",
    inputSchema: z.object({}),
    run: async () => {
      const { board, leagueName, scoringSummary } = getContext();
      return JSON.stringify({
        league: leagueName,
        scoring: scoringSummary,
        teams: board.shape.teams,
        rounds: board.shape.rounds,
        current_pick: board.turn.currentPick,
        current_round: board.turn.currentRound,
        is_my_turn: board.turn.isMyTurn,
        picks_until_my_turn: board.turn.picksUntilMyTurn,
        my_next_pick: board.turn.myNextPick,
        my_pick_after_next: board.turn.myPickAfterNext,
        my_roster: board.myPlayers.map((p) => ({
          player_id: p.playerId,
          position: p.position,
          team: p.team,
          bye: p.byeWeek,
        })),
        unfilled_starting_slots: Object.values(board.roster.needs)
          .filter((n) => n.unfilled > 0)
          .map((n) => ({ position: n.position, unfilled: n.unfilled, urgency: n.urgency })),
        positional_run: board.positionalRun,
        tier_warnings: board.tierWarnings,
        top_options_are_effectively_tied: board.decisiveness.effectivelyTied,
        projection_source: board.projectionSource,
      });
    },
  });

  const shortlist = betaZodTool({
    name: "get_shortlist",
    description:
      "The engine's current recommended shortlist, already scored and ranked. This " +
      "is the same set the recommendation cards are built from.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(getContext().board.shortlist.map(row)),
  });

  const bestAvailable = betaZodTool({
    name: "get_best_available",
    description:
      "The best available players, optionally filtered to a position. Use this to " +
      "answer questions about players outside the shortlist - who is left at tight " +
      "end, how far the running back pool has drained, and so on.",
    inputSchema: z.object({
      position: z
        .enum(["QB", "RB", "WR", "TE", "K", "DEF"])
        .optional()
        .describe("Restrict to one position. Omit for all positions."),
      limit: z.number().int().min(1).max(40).default(10).describe("How many to return"),
    }),
    run: async (input) => {
      const { board } = getContext();
      const pool = input.position
        ? board.board.filter((p) => p.position === input.position)
        : board.board;
      return JSON.stringify(pool.slice(0, input.limit).map(row));
    },
  });

  const comparePlayers = betaZodTool({
    name: "compare_players",
    description:
      "Side-by-side numbers for specific players, by name or player_id. Use this " +
      "when the user asks about particular players rather than the board generally.",
    inputSchema: z.object({
      players: z.array(z.string()).min(1).max(6).describe("Player names or player_ids"),
    }),
    run: async (input) => {
      const { board } = getContext();
      const found = input.players.map((query) => {
        const needle = query.toLowerCase().trim();
        const match =
          board.board.find((p) => p.playerId.toLowerCase() === needle) ??
          board.board.find((p) => p.name.toLowerCase() === needle) ??
          board.board.find((p) => p.name.toLowerCase().includes(needle));
        // Explicitly report a miss rather than silently dropping the player, so the
        // model does not answer as though it compared someone it never found.
        return match ? row(match) : { query, error: "not found or already drafted" };
      });
      return JSON.stringify(found);
    },
  });

  const recentPicks = betaZodTool({
    name: "get_recent_picks",
    description: "The most recent picks in the draft, for reading how the board is moving.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(getContext().board.recentPicks),
  });

  // Sorted by name so the tool list renders deterministically. Tool definitions sit
  // at position zero of the cached prefix, and a set that reorders between requests
  // invalidates the entire cache.
  return [bestAvailable, comparePlayers, draftState, recentPicks, shortlist];
}

/** System prompt for the ask endpoint. Stable, so it caches. */
export const ASK_SYSTEM_PROMPT = `You are a draft-room analyst answering a manager's
question during a live fantasy football draft. You have tools that read the live
draft state and the engine's scored board.

Call the tools rather than reasoning from memory. Your training data does not know
this league's scoring, this draft's board, or who is already gone, and every number
the tools return is computed from the league's actual settings.

Key metrics, all pre-computed:
- vorp: projection minus the worst starter the league will field at that position.
  Makes positions comparable.
- vona: the drop-off from passing on this player and taking the best at that
  position at the manager's following pick. The most decision-relevant number.
- tier / left_in_tier: gap-based tiers. "Last one in the tier" is a real reason to act.
- survival_to_my_next_pick: probability, 0 to 1, that the player lasts.
- adp_delta: average draft position minus the current pick. Positive is a faller.

Answer in a few sentences. Be direct and commit to a view. It is a live draft and
the manager is reading this against a clock, so no preamble, no restating the
question, no bulleted survey of considerations. If the numbers say the options are
close, say they are close rather than inventing a tiebreaker.

Never recommend a player the tools did not return, and never invent statistics,
injuries, or depth-chart news.`;
