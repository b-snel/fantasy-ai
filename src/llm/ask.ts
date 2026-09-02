/**
 * Free-form questions, answered with an agentic tool loop.
 *
 * This is the one place a loop is the right shape. The recommendation path knows
 * exactly what it needs, so it computes the shortlist and makes a single structured
 * call. A question like "should I take the best player or fill my flex?" does not
 * have a fixed data requirement - the model has to decide what to look at - and
 * that is what the tool runner is for.
 */

import Anthropic from "@anthropic-ai/sdk";

import { config } from "../config.ts";
import { ASK_SYSTEM_PROMPT, buildTools, type ToolContext } from "../tools/index.ts";
import {
  disableFastMode,
  fastModeFor,
  isFastModeLimit,
  recordUsage,
  summariseUsage,
  type CallUsage,
} from "./recommend.ts";

export interface AskResult {
  answer: string;
  usage: CallUsage;
  toolCalls: string[];
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set.");
    }
    client = new Anthropic();
  }
  return client;
}

export async function ask(question: string, getContext: () => ToolContext): Promise<AskResult> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error("Empty question.");
  if (trimmed.length > 500) throw new Error("Question is too long.");

  const toolCalls: string[] = [];
  const tools = buildTools(() => {
    return getContext();
  });

  const started = performance.now();
  const fastRequested = fastModeFor(config.llm.onClockModel);
  const runner = getClient().beta.messages.toolRunner({
    model: config.llm.onClockModel,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    ...(fastRequested && {
      speed: "fast" as const,
      betas: ["fast-mode-2026-02-01"],
    }),
    // Automatic caching for the growing tool-loop tail: the breakpoint rides the
    // last message block, so each turn re-reads the prior turns instead of
    // re-paying for them. Composes with the 1-hour system breakpoint below (the
    // longer-TTL entry sits earlier in the prefix, as required).
    cache_control: { type: "ephemeral" },
    system: [
      {
        type: "text",
        text: ASK_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral", ttl: config.llm.cacheTtl },
      },
    ],
    tools,
    messages: [{ role: "user", content: trimmed }],
  });

  let final: Anthropic.Beta.BetaMessage | null = null;
  // Every turn of the loop bills, not just the last one; sum them or under-report.
  // Keyed off the literal so a new billed field only needs adding here once.
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  let usage: CallUsage;
  let observedSpeed: string | null | undefined;
  try {
    for await (const message of runner) {
      for (const block of message.content) {
        if (block.type === "tool_use") toolCalls.push(block.name);
      }
      for (const k of Object.keys(totals) as Array<keyof typeof totals>) {
        totals[k] += message.usage[k] ?? 0;
      }
      observedSpeed = (message.usage as { speed?: string | null }).speed ?? observedSpeed;
      // The runner does not auto-resume a paused server-tool turn; there are no
      // server tools here, but checking costs nothing and fails loudly if that changes.
      if (message.stop_reason === "pause_turn") {
        runner.pushMessages({ role: "assistant", content: message.content });
      }
      final = message;
    }
  } catch (err) {
    if (fastRequested && isFastModeLimit(err)) {
      // No fast-mode quota on this org: retry the whole question at standard
      // speed. fastModeFor is now false, so this recurses exactly once.
      disableFastMode(err instanceof Error ? err.message.slice(0, 140) : String(err));
      return ask(question, getContext);
    }
    throw err;
  } finally {
    // A loop that dies on turn four still spent real money on turns one to three;
    // the ledger must see that spend even when no answer comes back.
    usage = summariseUsage(
      config.llm.onClockModel,
      totals,
      Math.round(performance.now() - started),
      observedSpeed,
    );
    if (usage.estimatedCostUsd > 0) recordUsage(usage);
  }

  if (!final) throw new Error("No response from the model.");

  const answer = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    answer: answer || "No answer returned.",
    usage,
    toolCalls,
  };
}
