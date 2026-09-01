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
import { summariseUsage, type CallUsage } from "./recommend.ts";

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
  const runner = getClient().beta.messages.toolRunner({
    model: config.llm.onClockModel,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
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

  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === "tool_use") toolCalls.push(block.name);
    }
    // The runner does not auto-resume a paused server-tool turn; there are no
    // server tools here, but checking costs nothing and fails loudly if that changes.
    if (message.stop_reason === "pause_turn") {
      runner.pushMessages({ role: "assistant", content: message.content });
    }
    final = message;
  }

  if (!final) throw new Error("No response from the model.");

  const answer = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    answer: answer || "No answer returned.",
    usage: summariseUsage(config.llm.onClockModel, final.usage, Math.round(performance.now() - started)),
    toolCalls,
  };
}
