/**
 * The paid news check: one web-searching model call over the moves the engine
 * already likes.
 *
 * Everything else on the waiver page is free and deterministic. This is the one
 * step that is neither, so it is a button rather than a side effect, it runs on
 * the engine's shortlist rather than the whole wire, and what it learns is
 * cached per player per day - rosters change every minute, and a reload or a
 * new claim must never pay for the same news twice.
 *
 * The division of labour is the same as in the draft room: the engine owns the
 * numbers, the model owns what they cannot carry - a starter ruled out on
 * Wednesday after the projections refreshed on Tuesday, a backup who took the
 * practice reps, a coach saying the rookie "earned more". It annotates players
 * and gives each move a verdict. It never re-ranks or hides a move.
 *
 * Not copied from src/data/news.ts on purpose: that sweep bills searches it does
 * not count, drops a paused server-tool turn, uses the SDK's sleeping retries,
 * and writes the file the draft board reads.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import { config } from "../config.ts";
import { readCache, writeCache } from "../sleeper/client.ts";
import { recordUsage, summariseUsage, type CallUsage } from "../llm/recommend.ts";

export type Outlook = "up" | "down" | "steady" | "unknown";
export type Verdict = "do" | "consider" | "skip";

export interface NewsItem {
  playerId: string;
  note: string;
  outlook: Outlook;
  checkedAt: number;
}

export interface MoveVerdict {
  add: string;
  verdict: Verdict;
  reason: string;
  checkedAt: number;
}

/** One player the model is asked about, with the engine's numbers for context. */
export interface NewsCandidate {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  /** "add", "drop", or "starter" (one of yours worth a status check). */
  role: "add" | "drop" | "starter";
  /** A compact line of engine context: projection and injury tag. */
  context: string;
}

export interface NewsMove {
  add: string;
  drop: string | null;
  /** Engine summary of the move, e.g. "+2.1 pts/wk, fills week 8 QB hole". */
  summary: string;
}

export interface NewsRequest {
  /** Eastern date, YYYY-MM-DD - the cache day. */
  today: string;
  leagueLine: string;
  teamLine: string;
  candidates: NewsCandidate[];
  moves: NewsMove[];
}

export interface NewsResult {
  items: NewsItem[];
  verdicts: MoveVerdict[];
  summary: string | null;
  /** This call's cost; 0 when everything came from today's cache. */
  costUsd: number;
  searches: number;
  model: string | null;
  /** Players and moves served from today's cache rather than the call. */
  cachedPlayers: number;
}

/** What the service needs; tests and the demo pass a fake so nothing bills. */
export interface NewsProvider {
  check(req: NewsRequest): Promise<NewsResult>;
  /** Today's cached notes and verdicts, without a call. */
  cached(today: string): Promise<{ items: NewsItem[]; verdicts: MoveVerdict[]; summary: string | null }>;
}

const NewsSchema = z.object({
  players: z
    .array(
      z.object({
        id: z.string().describe("The player's id, copied exactly from the id column"),
        note: z
          .string()
          .describe(
            "One or two short sentences on what happened in the last ~10 days that matters for " +
              "fantasy: injury and practice status, role or depth-chart change, suspension, trade. " +
              "Empty string if nothing notable.",
          ),
        outlook: z.enum(["up", "down", "steady", "unknown"]).describe("Direction of his fantasy value from the news"),
      }),
    )
    .describe("One entry per player in the table, in the same order"),
  moves: z
    .array(
      z.object({
        add_id: z.string().describe("The add's id, copied exactly from the moves list"),
        verdict: z.enum(["do", "consider", "skip"]),
        reason: z.string().describe("One sentence, grounded in the news or the numbers given"),
      }),
    )
    .describe("One verdict per move in the list"),
  summary: z.string().describe("Two or three sentences: what to do on the wire this week and why"),
});

/** Bump when NewsCache changes shape. */
const CACHE_VERSION = 1;
/** Server-side web search bills per search on top of tokens. */
const WEB_SEARCH_USD = 0.01;

interface NewsCache {
  version: number;
  date: string;
  items: Record<string, NewsItem>;
  verdicts: Record<string, MoveVerdict>;
  summary: string | null;
}

async function readDay(today: string): Promise<NewsCache> {
  const c = await readCache<NewsCache>(config.paths.waiverNews);
  // Yesterday's news is not news.
  return c?.version === CACHE_VERSION && c.date === today
    ? c
    : { version: CACHE_VERSION, date: today, items: {}, verdicts: {}, summary: null };
}

/** The real thing: Opus with web search. */
export function liveNewsProvider(): NewsProvider {
  return {
    async cached(today) {
      const c = await readDay(today);
      return { items: Object.values(c.items), verdicts: Object.values(c.verdicts), summary: c.summary };
    },
    async check(req) {
      const cache = await readDay(req.today);
      const needNotes = req.candidates.filter((c) => !cache.items[c.playerId]);
      const needVerdicts = req.moves.filter((m) => !cache.verdicts[m.add]);
      const merged = (extra: Partial<NewsResult> = {}): NewsResult => ({
        items: req.candidates.map((c) => cache.items[c.playerId]).filter((x): x is NewsItem => x != null),
        verdicts: req.moves.map((m) => cache.verdicts[m.add]).filter((x): x is MoveVerdict => x != null),
        summary: cache.summary,
        costUsd: 0,
        searches: 0,
        model: null,
        cachedPlayers: req.candidates.length - needNotes.length,
        ...extra,
      });
      if (!needNotes.length && !needVerdicts.length) return merged();

      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is not set - the news check needs it. Everything else works without it.");
      }
      // Ask about everyone the open verdicts depend on, plus anyone without a note.
      const ask = new Map(needNotes.map((c) => [c.playerId, c]));
      for (const m of needVerdicts) {
        for (const id of [m.add, m.drop]) {
          const c = id ? req.candidates.find((x) => x.playerId === id) : null;
          if (c) ask.set(c.playerId, c);
        }
      }
      const out = await callModel({ ...req, candidates: [...ask.values()], moves: needVerdicts.length ? needVerdicts : req.moves });

      const now = Date.now();
      for (const it of out.items) cache.items[it.playerId] = { ...it, checkedAt: now };
      // A player asked about with nothing to report is cached as checked, so he is not re-asked today.
      for (const c of ask.values()) cache.items[c.playerId] ??= { playerId: c.playerId, note: "", outlook: "unknown", checkedAt: now };
      for (const v of out.verdicts) cache.verdicts[v.add] = { ...v, checkedAt: now };
      cache.summary = out.summary || cache.summary;
      await writeCache(config.paths.waiverNews, cache);
      return merged({ costUsd: out.costUsd, searches: out.searches, model: out.model, cachedPlayers: req.candidates.length - ask.size });
    },
  };
}

async function callModel(req: NewsRequest): Promise<{
  items: Array<Omit<NewsItem, "checkedAt">>;
  verdicts: Array<Omit<MoveVerdict, "checkedAt">>;
  summary: string;
  costUsd: number;
  searches: number;
  model: string;
}> {
  // No SDK retries: a failure should surface now, not after an invisible sleep
  // (AGENTS.md #8). The route runs this as a background job, so the timeout is
  // about not hanging forever rather than about Bun's idle limit.
  const client = new Anthropic({ maxRetries: 0, timeout: 150_000 });
  const model = config.waiver.newsModel;
  const table = [
    "id | name | pos | team | role | engine context",
    ...req.candidates.map((c) => `${c.playerId} | ${c.name} | ${c.position} | ${c.team ?? "FA"} | ${c.role} | ${c.context}`),
  ].join("\n");
  const name = (id: string | null) => (id ? (req.candidates.find((c) => c.playerId === id)?.name ?? id) : "nobody");
  const moves = req.moves.map((m, i) => `${i + 1}. add_id ${m.add} (${name(m.add)}) / drop ${name(m.drop)} - ${m.summary}`).join("\n");

  const prompt =
    `Today is ${req.today}. I manage a fantasy football team: ${req.leagueLine}\n${req.teamLine}\n\n` +
    `My waiver engine has shortlisted these moves from rest-of-season weekly projections (Rotowire, ` +
    `refreshed weekly - so they can lag news from the last day or two):\n${moves}\n\n` +
    `Players to check:\n${table}\n\n` +
    `Search for recent news on these players - injuries and practice reports, depth-chart and role ` +
    `changes, suspensions, trades, coach comments - prioritising the adds and the last few days. Then ` +
    `give each move a verdict: "do" if the news supports it or changes nothing, "consider" if it is a ` +
    `judgment call, "skip" if the news undercuts it (the starter he was replacing is back, he lost the ` +
    `role). The engine context already reflects projections and matchups; do not re-argue those. Report ` +
    `only things that actually happened, with the date when you know it, and leave a note empty rather ` +
    `than pad it.`;

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
  const started = performance.now();
  let searches = 0;
  // Server-tool failures come back as HTTP 200 with an error object in the tool
  // result, not as an exception - count them, or a check whose searches all
  // failed gets cached as "no news" (seen live 2026-10-21).
  const toolErrors: string[] = [];
  let searchResults = 0;
  let usage: CallUsage | null = null;
  let parsed: z.infer<typeof NewsSchema> | null = null;

  try {
    // A server-side tool loop can pause mid-turn; hand it back to continue, twice at most.
    for (let turn = 0; turn < 3; turn++) {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 16_000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: betaZodOutputFormat(NewsSchema) },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
        messages,
      });
      searches += response.usage.server_tool_use?.web_search_requests ?? 0;
      for (const block of response.content as unknown as Array<{ type?: unknown; content?: unknown }>) {
        if (typeof block.type !== "string" || !block.type.endsWith("_tool_result")) continue;
        const c = block.content as { error_code?: unknown } | unknown[] | undefined;
        if (Array.isArray(c)) {
          if (block.type === "web_search_tool_result") searchResults++;
        } else if (c && typeof c.error_code === "string") {
          toolErrors.push(`${block.type.replace(/_tool_result$/, "")} ${c.error_code}`);
        }
      }
      const u = summariseUsage(response.model ?? model, response.usage, Math.round(performance.now() - started));
      usage = usage ? addUsage(usage, u) : u;

      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      if (response.stop_reason === "refusal") throw new Error("The model declined the news check - try again later.");
      parsed = response.parsed_output ?? null;
      break;
    }
  } finally {
    // Every turn that ran is billed, even if a later one failed.
    if (usage) recordUsage({ ...usage, estimatedCostUsd: round4(usage.estimatedCostUsd + searches * WEB_SEARCH_USD) });
  }
  if (!parsed) throw new Error("The news check returned no usable answer.");
  if (toolErrors.length && searchResults <= toolErrors.length) {
    // Mostly failed searches: what the model wrote is an apology, not news. Do
    // not cache it - the next check should try again.
    const counts = new Map<string, number>();
    for (const e of toolErrors) counts.set(e, (counts.get(e) ?? 0) + 1);
    const detail = [...counts].map(([e, n]) => `${e}${n > 1 ? ` x${n}` : ""}`).join(", ");
    throw new Error(
      `Web search failed (${detail}; ${searchResults} search${searchResults === 1 ? "" : "es"} returned results) - nothing was cached, try again later.`,
    );
  }

  // Ids first, names second: a model that echoes a name where an id belongs
  // should still land on the right player.
  const resolve = (raw: string): string | null => {
    const byId = req.candidates.find((c) => c.playerId === raw.trim());
    if (byId) return byId.playerId;
    const n = normalise(raw);
    return req.candidates.find((c) => normalise(c.name) === n)?.playerId ?? null;
  };
  const items = parsed.players
    .map((p) => ({ playerId: resolve(p.id), note: p.note.trim(), outlook: p.outlook }))
    .filter((p): p is { playerId: string; note: string; outlook: Outlook } => p.playerId != null && p.note.length > 0);
  const verdicts = parsed.moves
    .map((m) => ({ add: resolve(m.add_id), verdict: m.verdict, reason: m.reason.trim() }))
    .filter((m): m is { add: string; verdict: Verdict; reason: string } => m.add != null && req.moves.some((x) => x.add === m.add));

  return {
    items,
    verdicts,
    summary: parsed.summary.trim(),
    costUsd: round4((usage?.estimatedCostUsd ?? 0) + searches * WEB_SEARCH_USD),
    searches,
    model: usage?.model ?? model,
  };
}

function addUsage(a: CallUsage, b: CallUsage): CallUsage {
  return {
    ...a,
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    latencyMs: b.latencyMs,
  };
}

const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "");
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
