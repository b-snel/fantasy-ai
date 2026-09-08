/**
 * Pre-draft news sweep.
 *
 * Runs once, before the draft, over the players most likely to be relevant, and
 * caches a one-line note per player. During the draft those notes ride along in the
 * candidate table for free.
 *
 * The alternative - searching the web when a player appears on the shortlist - is
 * the wrong shape twice over. It puts a multi-second search on the critical path
 * while a pick clock is running, and it would dominate the total cost of the whole
 * app for information that barely changes between rounds. Injury designations and
 * practice participation come from the player dump on every poll and cover genuine
 * intra-draft movement.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { config } from "../config.ts";
import { readCache, writeCache } from "../sleeper/client.ts";
import { summariseUsage, type CallUsage } from "../llm/recommend.ts";
import type { PlayersIndex } from "../sleeper/types.ts";

/** player_id -> short note. */
export type NewsIndex = Map<string, string>;

const NoteSchema = z.object({
  notes: z
    .array(
      z.object({
        name: z.string().describe("The player's name exactly as given in the list"),
        note: z
          .string()
          .describe(
            "One short clause on anything draft-relevant from the last few weeks: " +
              "injury, role change, holdout, suspension, depth chart move. " +
              "Empty string if there is nothing notable.",
          ),
      }),
    )
    .describe("One entry per player asked about, in the same order"),
});

/** Players are swept in batches so one search covers many names. */
const BATCH_SIZE = 25;

export interface SweepOptions {
  players: PlayersIndex;
  /** Player ids to sweep, best-first. */
  playerIds: string[];
  /** How many players to cover. Defaults to 150. */
  limit?: number;
  onProgress?: (done: number, total: number, usage: CallUsage) => void;
}

export interface SweepResult {
  news: NewsIndex;
  totalCostUsd: number;
  batches: number;
}

export async function loadNews(): Promise<NewsIndex> {
  const cached = await readCache<Record<string, string>>(config.paths.news);
  return cached ? new Map(Object.entries(cached)) : new Map();
}

/**
 * Sweep the top N players for recent news and cache the result.
 *
 * Uses the server-side web_search tool, which needs a model that supports the
 * current tool version - Haiku 4.5 does not, so this runs on the news model from
 * config regardless of which tier drives the draft itself.
 */
export async function sweepNews(opts: SweepOptions): Promise<SweepResult> {
  const { players, playerIds, limit = 150, onProgress } = opts;

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set; cannot run the news sweep.");
  }

  const client = new Anthropic();
  const targets = playerIds.slice(0, limit);
  const news: NewsIndex = new Map();
  let totalCostUsd = 0;
  let batches = 0;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    const named = batch
      .map((id) => ({ id, player: players[id] }))
      .filter((x): x is { id: string; player: NonNullable<typeof x.player> } => x.player != null);
    if (!named.length) continue;

    const roster = named
      .map(({ player }) => `${player.full_name ?? player.player_id} (${player.position} ${player.team ?? "FA"})`)
      .join("\n");

    const started = performance.now();
    const response = await client.messages.parse({
      model: config.llm.newsModel,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: zodOutputFormat(NoteSchema) },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
      messages: [
        {
          role: "user",
          content:
            `It is the start of the ${new Date().getFullYear()} NFL season and I am about to draft. ` +
            `Search for anything draft-relevant from the last few weeks about these players ` +
            `— injuries, role or depth-chart changes, holdouts, suspensions.\n\n${roster}\n\n` +
            `Return one entry per player, in the same order. Keep each note to a single short ` +
            `clause. If you find nothing notable about a player, return an empty note for them ` +
            `rather than padding it with background. Do not speculate and do not repeat ` +
            `general scouting opinion; only report things that actually happened.`,
        },
      ],
    });

    const usage = summariseUsage(config.llm.newsModel, response.usage, Math.round(performance.now() - started));
    totalCostUsd += usage.estimatedCostUsd;
    batches++;

    // Match by name rather than trusting positional alignment, then fall back to
    // position so a reordered or short response degrades instead of mis-attributing.
    const parsed = response.parsed_output?.notes ?? [];
    const byName = new Map(parsed.map((n) => [normalise(n.name), n.note]));

    named.forEach(({ id, player }, index) => {
      const fullName = player.full_name ?? "";
      const note = byName.get(normalise(fullName)) ?? parsed[index]?.note ?? "";
      if (note.trim()) news.set(id, note.trim());
    });

    onProgress?.(Math.min(i + BATCH_SIZE, targets.length), targets.length, usage);
  }

  await writeCache(config.paths.news, Object.fromEntries(news));
  return { news, totalCostUsd, batches };
}

const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "");
