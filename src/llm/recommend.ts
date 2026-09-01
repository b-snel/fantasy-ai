/**
 * The single LLM call.
 *
 * One structured request per recommendation - no agent loop on the hot path. An
 * agentic loop would re-send every tool result on every turn to reach the same
 * answer the engine already computed deterministically; the loop is reserved for
 * the optional free-form "ask" path, where open-ended exploration is the point.
 *
 * Cost control here is structural rather than clever:
 *   - the model sees ~10 pre-scored candidates, never the player pool;
 *   - the system prefix is byte-stable and cached with a 1-hour TTL;
 *   - identical board states are served from an in-process cache without a call.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { config } from "../config.ts";
import { RecommendationSchema, type Recommendation } from "./schema.ts";
import {
  buildStaticPrefix,
  buildVolatileTail,
  type StaticPrefixInput,
  type VolatileInput,
} from "./prompt.ts";

export interface RecommendOptions {
  prefix: StaticPrefixInput;
  volatile: VolatileInput;
  /** On the clock uses the stronger model and higher effort. */
  urgency: Urgency;
}

export type Urgency = "on_clock" | "background";

export interface RecommendResult {
  recommendation: Recommendation;
  usage: CallUsage;
  /** True when served from the local cache without an API call. */
  cached: boolean;
}

export interface CallUsage {
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
}

/** Per-million-token prices, from the current Anthropic pricing table. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
};

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
    }
    client = new Anthropic();
  }
  return client;
}

/**
 * Board states repeat constantly during a draft - the same ten candidates stay on
 * top while three other managers pick. Keying on the rendered tail means an
 * unchanged board never bills twice.
 */
const responseCache = new Map<string, Recommendation>();
const usageLog: CallUsage[] = [];

export function getUsageLog(): readonly CallUsage[] {
  return usageLog;
}

export function totalSpendUsd(): number {
  return round4(usageLog.reduce((sum, u) => sum + u.estimatedCostUsd, 0));
}

export async function recommend(opts: RecommendOptions): Promise<RecommendResult> {
  const { prefix, volatile: vol, urgency } = opts;

  const systemText = buildStaticPrefix(prefix);
  const userText = buildVolatileTail(vol);

  const model = urgency === "on_clock" ? config.llm.onClockModel : config.llm.backgroundModel;
  const cacheKey = `${model} ${hash(userText)}`;

  const hit = responseCache.get(cacheKey);
  if (hit) {
    return { recommendation: hit, cached: true, usage: emptyUsage(model) };
  }

  const started = performance.now();
  const response = await getClient().messages.parse({
    model,
    max_tokens: config.llm.maxTokens,
    thinking: { type: "adaptive" },
    output_config: {
      // Lower effort on background refreshes: they keep the board warm, they do not
      // agonise over a pick that is still eight selections away.
      effort: urgency === "on_clock" ? "high" : "low",
      format: zodOutputFormat(RecommendationSchema),
    },
    system: [
      {
        type: "text",
        text: systemText,
        // 1-hour TTL: gaps between your picks in a 12-team snake run 15-20 minutes,
        // outliving the 5-minute default. The doubled write cost repays on read two.
        cache_control: { type: "ephemeral", ttl: config.llm.cacheTtl },
      },
    ],
    messages: [{ role: "user", content: userText }],
  });

  const latencyMs = Math.round(performance.now() - started);
  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(
      `Model returned no parseable recommendation (stop_reason: ${response.stop_reason}).`,
    );
  }

  const usage = summariseUsage(model, response.usage, latencyMs);
  usageLog.push(usage);
  responseCache.set(cacheKey, parsed);

  return { recommendation: parsed, usage, cached: false };
}

function emptyUsage(model: string): CallUsage {
  return {
    model,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    latencyMs: 0,
  };
}

export function summariseUsage(
  model: string,
  usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null | undefined,
  latencyMs: number,
): CallUsage {
  const inputTokens = usage?.input_tokens ?? 0;
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;

  const price = PRICING[model] ?? { input: 5, output: 25 };
  // Cache reads bill at ~0.1x input; 1-hour cache writes at 2x.
  const estimatedCostUsd =
    (inputTokens * price.input +
      cacheReadTokens * price.input * 0.1 +
      cacheWriteTokens * price.input * 2 +
      outputTokens * price.output) /
    1_000_000;

  return {
    model,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    estimatedCostUsd: round4(estimatedCostUsd),
    latencyMs,
  };
}

export interface CallDecision {
  call: boolean;
  urgency: Urgency;
  reason: string;
}

/**
 * Whether a call is worth making right now.
 *
 * The engine recomputes on every 2-second poll because that is free. The model is
 * only consulted when the answer could actually change what the manager does.
 */
export function shouldCallModel(args: {
  picksUntilMyTurn: number | null;
  topCandidateIds: string[];
  lastTopCandidateIds: string[] | null;
  manual: boolean;
}): CallDecision {
  const { picksUntilMyTurn, topCandidateIds, lastTopCandidateIds, manual } = args;

  if (manual) return { call: true, urgency: "on_clock", reason: "manual refresh" };
  if (picksUntilMyTurn == null) {
    return { call: false, urgency: "background", reason: "no picks left" };
  }

  if (picksUntilMyTurn <= config.llm.onClockThreshold) {
    return {
      call: true,
      urgency: "on_clock",
      reason: picksUntilMyTurn === 0 ? "on the clock" : `${picksUntilMyTurn} picks away`,
    };
  }

  if (picksUntilMyTurn <= config.llm.backgroundThreshold) {
    const top3 = topCandidateIds.slice(0, 3).join(",");
    const prevTop3 = lastTopCandidateIds?.slice(0, 3).join(",") ?? null;
    if (prevTop3 !== top3) {
      return { call: true, urgency: "background", reason: "top of the board changed" };
    }
    return { call: false, urgency: "background", reason: "board unchanged" };
  }

  return { call: false, urgency: "background", reason: "too far from your pick" };
}

/** Stable, fast, non-cryptographic hash for cache keys. */
export function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
