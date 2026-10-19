/**
 * Deep trade analysis: a second opinion from Claude on one specific trade.
 *
 * The engine already knows the arithmetic - every roster's best lineup, week by
 * week, before and after. What it cannot know is everything the projections have
 * not absorbed yet: the injury reported this morning, the backfield that just
 * became a committee, what 0-5 does to how much the next four weeks matter
 * against the playoff weeks. That judgment is what this call is for.
 *
 * Shaped like the Ask box rather than the recommendation cards, for the same
 * reason: the question has no fixed data requirement. Claude reads a
 * deterministic briefing, searches the web for news, and can run the same engine
 * through tools - so a counter-offer it suggests carries engine numbers rather
 * than invented ones. The answer comes back as a structured verdict.
 *
 * On demand only, never automatic: a run is roughly $0.30-0.60 and one to two
 * minutes.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import { config } from "../config.ts";
import { recordUsage, summariseUsage, type CallUsage } from "./recommend.ts";

export const VerdictSchema = z.object({
  decision: z
    .enum(["accept", "counter", "decline"])
    .describe("accept: send it as proposed. counter: propose the variation below. decline: walk away."),
  confidence: z.enum(["high", "medium", "low"]),
  headline: z.string().describe("The recommendation in one sentence"),
  summary: z.string().describe("Two to four sentences: the reasoning that decides it"),
  for_you: z.array(z.string()).describe("The strongest reasons the trade helps, one short sentence each"),
  against: z.array(z.string()).describe("The strongest reasons it hurts or is risky, one short sentence each"),
  news: z
    .array(z.object({ player: z.string(), note: z.string() }))
    .describe("Recent news you found that bears on the decision; empty if none"),
  standings: z.string().describe("What the manager's record and the playoff race mean for this trade"),
  roster_after: z.string().describe("Who starts, who sits, and who gets cut if the trade happens"),
  counter_offer: z
    .object({
      give: z.array(z.string()).describe("Players the manager sends, by name"),
      get: z.array(z.string()).describe("Players the manager receives, by name"),
      why: z.string(),
    })
    .nullable()
    .describe("Required when decision is counter, and only a variation you scored with evaluate_trade; otherwise null"),
  pitch: z
    .string()
    .nullable()
    .describe("A short message to send the other manager for the accepted or countered trade; null on decline"),
});

export type TradeVerdict = z.infer<typeof VerdictSchema>;

/** What the reviewer may ask the engine. The trade service implements it. */
export interface ReviewEngine {
  /** Score a variation with the same partner. Players by name or id. */
  evaluate(give: string[], get: string[]): Promise<unknown>;
  /** The engine's own search, optionally pinned. */
  find(opts: { give?: string[]; get?: string[]; team?: string; maxPerSide?: number }): Promise<unknown>;
  /** Another team's roster, needs and record. */
  team(query: string): Promise<unknown>;
}

export type ReviewStepKind = "start" | "search" | "engine" | "think" | "write";

export interface ReviewStep {
  kind: ReviewStepKind;
  text: string;
  at: number;
}

export interface ReviewInput {
  briefing: string;
  /** The trade under review, by name - the briefing says the same in prose. */
  trade: { partner: string; give: string[]; get: string[] };
  engine: ReviewEngine;
  onStep?: (step: ReviewStep) => void;
}

export interface ReviewSource {
  title: string;
  url: string;
}

export interface ReviewResult {
  verdict: TradeVerdict;
  usage: CallUsage;
  /** The model that actually answered - a refusal fallback can change it. */
  servedBy: string;
  searches: number;
  engineCalls: number;
  sources: ReviewSource[];
}

/** The deep-analysis call, as the trade service sees it. Swappable in tests. */
export interface TradeReviewer {
  /** Why a run cannot start right now, or null if it can. */
  unavailable(): string | null;
  review(input: ReviewInput): Promise<ReviewResult>;
}

export const TRADE_REVIEW_SYSTEM = `You are advising one fantasy football manager on one trade in their Sleeper league. They will act on your answer, so commit to a recommendation.

The briefing comes from a deterministic engine: rest-of-season weekly projections for both rosters under this league's scoring (bye weeks and known injury absences already included), each team's best-lineup value before and after the trade, and how the trade reads on paper. Treat those numbers as correct. Do not re-derive or contradict them from memory.

Your job is what the engine cannot see:
- Recent news. Projections lag news by days. Search for the players in the trade - injuries, role or depth-chart changes, quarterback or coaching changes, workload trends - before you decide. Searches are limited, so cover each player once before going deeper on any one.
- The standings. What this manager's record means for weighing the next few weeks against the playoff weeks.
- Roster construction. Who would be cut to make room, how much sits on the bench, how exposed the lineup is to one injury, and what flexibility is left before the trade deadline.
- Whether the other manager would really accept, and if not, what version they would.

You have tools that run the same engine. evaluate_trade scores any variation with this partner; use it before recommending a counter-offer, and only recommend a counter whose numbers you have checked. find_trades shows what else the engine would suggest. get_team shows another roster.

Decide accept (send it as proposed), counter (a specific variation you evaluated), or decline (walk away). Be direct and specific: cite the engine's numbers and what your searches found. Never invent statistics or news.`;

/** The live reviewer: Claude Opus 5.5 with web search and engine tools. */
export function claudeReviewer(): TradeReviewer {
  let client: Anthropic | null = null;
  return {
    unavailable: () =>
      process.env.ANTHROPIC_API_KEY ? null : "ANTHROPIC_API_KEY is not set - deep analysis needs it.",
    review: async (input) => {
      if (!client) client = new Anthropic();
      return runReview(client, input);
    },
  };
}

async function runReview(client: Anthropic, input: ReviewInput): Promise<ReviewResult> {
  const deep = config.trade.deep;
  const step = (kind: ReviewStepKind, text: string) => input.onStep?.({ kind, text, at: Date.now() });
  let engineCalls = 0;

  // Engine failures go back to the model as tool errors it can read and work
  // around (a misspelled name, a player on the wrong team), not as crashes.
  const guarded = async (label: string, fn: () => Promise<unknown>) => {
    engineCalls++;
    step("engine", label);
    try {
      return JSON.stringify(await fn());
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  const players = z.array(z.string()).min(1).max(4);
  const tools = [
    betaZodTool({
      name: "evaluate_trade",
      description:
        "Score a variation of the trade with the same partner using the engine: each side's " +
        "change in projected lineup points per week, how it reads on paper, a rough acceptance " +
        "likelihood, and who each side would cut. Players by name.",
      inputSchema: z.object({
        give: players.describe("The manager's players going out"),
        get: players.describe("The partner's players coming in"),
      }),
      run: (args) => guarded(`Testing ${args.give.join(" + ")} for ${args.get.join(" + ")}`, () => input.engine.evaluate(args.give, args.get)),
    }),
    betaZodTool({
      name: "find_trades",
      description:
        "The engine's own trade search, best first. Pin players the manager would give or " +
        "wants to get, or restrict to one team, to see alternatives to the trade under review.",
      inputSchema: z.object({
        give: z.array(z.string()).max(3).optional().describe("The manager's players that must be included"),
        get: z.array(z.string()).max(3).optional().describe("Players the manager wants (pins their team)"),
        team: z.string().optional().describe("Team name or manager name to restrict the search to"),
        max_per_side: z.number().int().min(1).max(3).optional(),
      }),
      run: (args) =>
        guarded(`Searching the engine${args.team ? ` with ${args.team}` : ""}`, () =>
          input.engine.find({ give: args.give, get: args.get, team: args.team, maxPerSide: args.max_per_side }),
        ),
    }),
    betaZodTool({
      name: "get_team",
      description: "Another team's roster with weekly projections, record, and positional needs.",
      inputSchema: z.object({ team: z.string().describe("Team name or manager name") }),
      run: (args) => guarded(`Looking at ${args.team}`, () => input.engine.team(args.team)),
    }),
  ];

  const started = performance.now();
  step("start", "Reading the engine's briefing");

  const runner = client.beta.messages.toolRunner({
    model: deep.model,
    max_tokens: deep.maxTokens,
    max_iterations: deep.maxIterations,
    thinking: { type: "adaptive" },
    output_config: { effort: deep.effort, format: betaZodOutputFormat(VerdictSchema) },
    // If a safety classifier declines, the API reruns the request on a fallback
    // model inside the same call rather than returning nothing.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // The tool-loop tail re-reads earlier turns from cache instead of re-paying.
    cache_control: { type: "ephemeral" },
    system: TRADE_REVIEW_SYSTEM,
    tools: [...tools, { type: "web_search_20260209", name: "web_search", max_uses: deep.maxSearches }],
    messages: [{ role: "user", content: input.briefing }],
  });

  const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let searches = 0;
  let servedBy: string = deep.model;
  let final: Anthropic.Beta.BetaMessage | null = null;
  const sources = new Map<string, ReviewSource>();

  let usage: CallUsage;
  try {
    for await (const message of runner) {
      for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += message.usage[k] ?? 0;
      searches += message.usage.server_tool_use?.web_search_requests ?? 0;
      servedBy = message.model;
      for (const s of searchSteps(message)) step("search", s);
      for (const src of collectSources(message)) if (!sources.has(src.url)) sources.set(src.url, src);
      // The runner does not resume a paused server-tool turn on its own.
      if (message.stop_reason === "pause_turn") {
        runner.pushMessages({ role: "assistant", content: message.content });
      } else if (message.stop_reason === "tool_use") {
        step("think", "Weighing what came back");
      } else {
        step("write", "Writing the verdict");
      }
      final = message;
    }
  } finally {
    // A loop that dies mid-way still spent money on the turns it finished.
    const tokens = summariseUsage(servedBy, totals, Math.round(performance.now() - started), null, 1.25);
    usage = { ...tokens, estimatedCostUsd: round4(tokens.estimatedCostUsd + searches * 0.01) };
    if (usage.estimatedCostUsd > 0) recordUsage(usage);
  }

  if (!final) throw new Error("No response from the model.");
  return {
    verdict: parseVerdict(final),
    usage,
    servedBy,
    searches,
    engineCalls,
    sources: [...sources.values()].slice(0, 8),
  };
}

/** The verdict out of the final message, or a plain-language reason it is missing. */
export function parseVerdict(message: Pick<Anthropic.Beta.BetaMessage, "content" | "stop_reason">): TradeVerdict {
  if (message.stop_reason === "refusal") {
    throw new Error("Claude declined to analyze this trade.");
  }
  if (message.stop_reason === "tool_use" || message.stop_reason === "pause_turn") {
    throw new Error("The analysis ran out of turns before reaching a verdict - try again.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("The analysis ran past its output limit before finishing - try again.");
  }
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The model's verdict was not valid JSON.");
  }
  const parsed = VerdictSchema.safeParse(json);
  if (!parsed.success) throw new Error("The model's verdict did not match the expected shape.");
  return parsed.data;
}

/** "Searching: ..." lines for each web search the model ran this turn. */
export function searchSteps(message: Pick<Anthropic.Beta.BetaMessage, "content">): string[] {
  const out: string[] = [];
  for (const block of message.content) {
    if (block.type !== "server_tool_use" || block.name !== "web_search") continue;
    const query = (block.input as { query?: unknown } | null)?.query;
    out.push(typeof query === "string" ? `Searching the web: ${query}` : "Searching the web");
  }
  return out;
}

/**
 * Pages the searches returned, for the "sources" line under the verdict - the
 * top two of each search, so one player's results cannot crowd out the rest.
 */
export function collectSources(message: Pick<Anthropic.Beta.BetaMessage, "content">): ReviewSource[] {
  const out: ReviewSource[] = [];
  for (const block of message.content) {
    if (block.type !== "web_search_tool_result") continue;
    // A failed search returns an error object here instead of a list.
    if (!Array.isArray(block.content)) continue;
    for (const r of block.content.slice(0, 2)) {
      if (r.type === "web_search_result") out.push({ title: r.title, url: r.url });
    }
  }
  return out;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
