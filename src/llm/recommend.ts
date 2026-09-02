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
  "claude-opus-5:fast": { input: 10, output: 50 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
};

/**
 * Fast mode is an Opus-only research preview with its own separate rate limit.
 * An org without access gets "rate limit of 0 fast mode input tokens" on every
 * attempt (observed live 2026-09-01), so once that happens the session falls
 * back to standard speed and STAYS there - flapping between speeds would also
 * invalidate the prompt cache on every flip.
 */
let fastModeDisabled = false;

export function fastModeFor(model: string): boolean {
  return config.llm.fastMode && !fastModeDisabled && model === "claude-opus-5";
}

export function disableFastMode(reason: string): void {
  if (fastModeDisabled) return;
  fastModeDisabled = true;
  console.warn(
    `[fast-mode] disabled for the rest of this session - continuing at standard speed. ${reason}`,
  );
}

/** Is this the fast-mode quota rejection, as opposed to an ordinary 429? */
export function isFastModeLimit(err: unknown): boolean {
  return err instanceof Anthropic.RateLimitError && /fast mode/i.test(err.message);
}

export type FastProbeResult = "fast" | "accepted" | "disabled" | "unknown";

/**
 * Settle fast-mode availability at boot instead of on your first pick.
 *
 * The runtime fallback in recommend() works, but discovering a missing quota
 * mid-draft still costs the failed round trip at the worst possible moment. One
 * throwaway 1-token fast request now - a fraction of a cent when the org DOES
 * have quota - moves that discovery to startup, where nobody is on a clock.
 *
 * usage.speed is the ground truth: an org with quota can still have a request
 * ACCEPTED but served at standard speed when fast capacity is tight (observed
 * live 2026-09-01 - the 8-token probe served fast while a 4.4k-token
 * recommendation served standard). Billing follows the speed that served.
 *
 * The probe is deliberately sized like a real recommendation request: "pad "
 * tokenizes at 2 tokens per repeat, so 2200 repeats measure 4,430 prompt
 * tokens via count_tokens - matching the ~4.4k real calls. (Bigger is worse,
 * not safer: a 9k probe could 429 against a quota every real call would fit.)
 * The same evening, an 8-token probe passed the quota check and then the
 * first real call 429'd against "0 fast mode input tokens per minute" - the
 * tiny request slipped under enforcement, so its verdict was worthless. A
 * representative probe costs ~$0.02 standard / ~$0.04 fast per boot when it
 * is actually served (nothing on a 429); a wrong "fast confirmed" costs a
 * failed round trip on your first pick.
 */
export async function probeFastMode(): Promise<FastProbeResult> {
  if (!fastModeFor(config.llm.onClockModel)) return "disabled";

  const started = performance.now();
  try {
    const response = await getClient().beta.messages.create(
      {
        model: config.llm.onClockModel,
        max_tokens: 1,
        speed: "fast",
        betas: ["fast-mode-2026-02-01"],
        messages: [
          {
            role: "user",
            content:
              "Reply with the single word ok and nothing else. Ignore the filler:\n" +
              "pad ".repeat(2200),
          },
        ],
      },
      { maxRetries: 0, timeout: 30_000 },
    );
    const served = (response.usage as { speed?: string | null }).speed;
    recordUsage(
      summariseUsage(
        config.llm.onClockModel,
        response.usage,
        Math.round(performance.now() - started),
        served,
      ),
    );
    return served === "fast" ? "fast" : "accepted";
  } catch (err) {
    if (isFastModeLimit(err)) {
      disableFastMode(err instanceof Error ? err.message.slice(0, 140) : String(err));
      return "disabled";
    }
    // A network blip or transient 5xx proves nothing about quota. Leave fast
    // mode armed; the per-call fallback still protects the draft.
    return "unknown";
  }
}

/**
 * Cap on any single recommendation attempt. The SDK default is 10 minutes, and
 * `inFlight` blocks every other attempt (including manual refresh) while a call
 * runs - so one hung request would freeze the cards for the rest of a pick
 * timer. Real calls land in 20-35s; 90s is generous headroom.
 *
 * SDK retries are off entirely on this path (maxRetries: 0). They sleep for
 * whatever `retry-after` says, uncapped and invisible - the exact failure mode
 * that froze the cards for minutes in a live mock. The session already has a
 * retry loop of its own: the 15s failure cooldown re-attempts on the next poll
 * with a visible "retrying in ~Ns" status, and the Refresh button is a human
 * retry. Every failure here should surface there, fast, not be papered over.
 */
const REQUEST_TIMEOUT_MS = 90_000;

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

/**
 * Model families that predate the 4.6+ request surface: adaptive thinking and
 * `output_config.effort` are rejected with a 400 on these. Found live, not in a
 * test - every background Haiku call failed, and retried on every 2-second poll.
 *
 * Substring match, not exact ids: config.ts promises draft-day model changes are
 * one edit, and a dated snapshot ("claude-haiku-4-5-20251001") must not silently
 * re-trigger the 400s an exact-string set would let through. Omitting thinking and
 * effort is valid on every model, so a false positive here only costs depth.
 */
const PRE_ADAPTIVE_PATTERNS = ["haiku-4-5", "sonnet-4-5", "opus-4-5", "claude-3", "haiku-3", "sonnet-3", "opus-3"];

/** Does this model accept `thinking: {type: "adaptive"}` and `output_config.effort`? */
export function supportsAdaptiveThinking(model: string): boolean {
  return !PRE_ADAPTIVE_PATTERNS.some((p) => model.includes(p));
}

export function getUsageLog(): readonly CallUsage[] {
  return usageLog;
}

/**
 * Prefix-drift detection.
 *
 * The costliest caching failure is silent: some later change interpolates one
 * per-request byte into the prompt prefix and every call quietly pays full input
 * price - correct output, no error, just a bigger bill. Usage fields are the only
 * ground truth, and drift has a signature: consecutive calls that WRITE a cache
 * entry without ever READING one, each request re-caching a prefix nobody reuses.
 * Zero reads with zero writes is different and expected - that is a prefix below
 * the model's cacheable minimum (the Haiku background path, deliberately).
 */
const rewriteStreaks = new Map<string, number>();

/** Spend from every call site (recommend and the ask tool loop) lands here. */
export function recordUsage(usage: CallUsage): void {
  usageLog.push(usage);

  // Streaks are keyed by model FAMILY, not the billing label: fast-served and
  // standard-served Opus calls share one prompt cache, and a ":fast" suffix
  // splitting the counter would let real drift alternate between two keys
  // without either ever reaching the warning threshold.
  const family = usage.model.replace(/:fast$/, "");
  if (usage.cacheReadTokens > 0) {
    rewriteStreaks.set(family, 0);
  } else if (usage.cacheWriteTokens > 0) {
    const streak = (rewriteStreaks.get(family) ?? 0) + 1;
    rewriteStreaks.set(family, streak);
    const warning = cacheWarning();
    if (warning) console.warn(`[cache] ${warning}`);
  }
}

/** Non-null when the prompt prefix looks like it is drifting between calls. */
export function cacheWarning(): string | null {
  for (const [model, streak] of rewriteStreaks) {
    if (streak >= 2) {
      return (
        `${model} rewrote its prompt cache ${streak} calls in a row without a ` +
        `single read - the prefix is drifting and every call is paying full input price`
      );
    }
  }
  return null;
}

/** Test hook - the streak tracker is module state. */
export function resetCacheHealth(): void {
  rewriteStreaks.clear();
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
  // Haiku 4.5 predates adaptive thinking and effort; sending either is a 400. A
  // background re-rank does not need extended thinking anyway - it keeps the board
  // warm between real picks. Lower effort on background refreshes for the same
  // reason: they do not agonise over a pick that is still eight selections away.
  const modern = supportsAdaptiveThinking(model);
  const effort = urgency === "on_clock" ? ("high" as const) : ("low" as const);
  const params = {
    model,
    max_tokens: config.llm.maxTokens,
    ...(modern && { thinking: { type: "adaptive" as const } }),
    output_config: {
      ...(modern && { effort }),
      format: zodOutputFormat(RecommendationSchema),
    },
    system: [
      {
        type: "text" as const,
        text: systemText,
        // 1-hour TTL: gaps between your picks in a 12-team snake run 15-20 minutes,
        // outliving the 5-minute default. The doubled write cost repays on read two.
        cache_control: { type: "ephemeral" as const, ttl: config.llm.cacheTtl },
      },
    ],
    messages: [{ role: "user" as const, content: userText }],
  };

  // Fast mode rides the beta endpoint with the same request otherwise. Never
  // toggle it mid-draft - a speed change invalidates the prompt cache.
  //
  // maxRetries: 0 on the fast attempt is load-bearing: an org without fast-mode
  // quota 429s deterministically, and the SDK's default two retries sleep for
  // whatever retry-after says - observed to hold an on-clock call for over a
  // minute before our fallback could even start. A quota that is zero now is
  // zero one retry later; fail immediately and answer at standard speed.
  const callModel = (fast: boolean) =>
    fast
      ? getClient().beta.messages.parse(
          {
            ...params,
            speed: "fast" as const,
            betas: ["fast-mode-2026-02-01"],
          },
          { maxRetries: 0, timeout: REQUEST_TIMEOUT_MS },
        )
      : getClient().messages.parse(params, { maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });

  const fast = fastModeFor(model);
  let response: Awaited<ReturnType<typeof callModel>>;
  try {
    response = await callModel(fast);
  } catch (err) {
    if (!fast || !isFastModeLimit(err)) throw err;
    // The org has no fast-mode quota; answer this pick at standard speed.
    disableFastMode(err instanceof Error ? err.message.slice(0, 140) : String(err));
    response = await callModel(false);
  }

  const latencyMs = Math.round(performance.now() - started);
  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(
      `Model returned no parseable recommendation (stop_reason: ${response.stop_reason}).`,
    );
  }

  // usage.speed is the ground truth of which speed actually served the request.
  const speed = (response.usage as { speed?: string | null }).speed;
  const usage = summariseUsage(model, response.usage, latencyMs, speed);
  recordUsage(usage);
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
  speed?: string | null,
): CallUsage {
  const inputTokens = usage?.input_tokens ?? 0;
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;

  // Fast-mode requests bill at their own rate and are labelled so the UI shows
  // which speed actually served each call.
  const key = speed === "fast" ? `${model}:fast` : model;
  const price = PRICING[key] ?? PRICING[model] ?? { input: 5, output: 25 };
  // Cache reads bill at ~0.1x input; 1-hour cache writes at 2x.
  const estimatedCostUsd =
    (inputTokens * price.input +
      cacheReadTokens * price.input * 0.1 +
      cacheWriteTokens * price.input * 2 +
      outputTokens * price.output) /
    1_000_000;

  return {
    model: key,
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
