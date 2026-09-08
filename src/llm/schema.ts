/**
 * The shape of a recommendation. Enforced server-side via structured outputs, so
 * the UI can render cards without defensive parsing.
 */

import { z } from "zod";

export const CardSchema = z.object({
  player_id: z.string().describe("The candidate's player_id, copied exactly from the table"),
  name: z.string(),
  verdict: z.string().describe("One sentence, under ~15 words, on why this is or is not the move"),
  rationale: z.array(z.string()).min(1).max(3).describe("Two or three short, distinct bullets"),
  risk: z.string().describe("The strongest honest argument against this pick, one sentence"),
  confidence: z.enum(["high", "medium", "low"]),
});

export const RecommendationSchema = z.object({
  board_read: z.string().describe("One sentence on the state of the draft"),
  top_pick_player_id: z.string().describe("player_id of the single recommended pick"),
  cards: z.array(CardSchema).min(1).max(5),
});

export type Card = z.infer<typeof CardSchema>;
export type Recommendation = z.infer<typeof RecommendationSchema>;
