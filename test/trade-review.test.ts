/**
 * Deep analysis, offline.
 *
 * The model call itself needs the network and costs money, so it is verified live
 * (AGENTS.md records the run). Everything around it is tested here: what Claude is
 * told, how its answer is read, how a run is started, shared, reused and failed,
 * and how the engine tools resolve the names a model types.
 */

import { test, expect, describe } from "bun:test";
import { cannedReviewer, fixtureTradeSource, makeFixtureTradeLeague, TRADE_FIXTURE_MY_ROSTER } from "../fixtures/trade.ts";
import { DeepUnavailableError, TradeService, type DeepJob } from "../src/server/trades.ts";
import { TradeQueryError } from "../src/trade/search.ts";
import {
  collectSources,
  parseVerdict,
  searchSteps,
  TRADE_REVIEW_SYSTEM,
  VerdictSchema,
  type ReviewEngine,
  type TradeReviewer,
  type TradeVerdict,
} from "../src/llm/trade-review.ts";

const NOW = Date.parse("2026-10-21T18:00:00Z");

const verdict: TradeVerdict = {
  decision: "counter",
  confidence: "medium",
  headline: "Counter instead.",
  summary: "Because.",
  for_you: ["a"],
  against: ["b"],
  news: [{ player: "X", note: "practiced fully" }],
  standings: "0-5 means now matters.",
  roster_after: "No cuts.",
  counter_offer: { give: ["A"], get: ["B"], why: "fairer" },
  pitch: "Hey",
};

async function settle(service: TradeService, job: DeepJob): Promise<DeepJob> {
  for (let i = 0; i < 200 && job.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 5));
    job = service.deepJob(job.id)!;
  }
  return job;
}

/** The fixture league's players, by market value, for building trades. */
function fixtureTrade() {
  const fx = makeFixtureTradeLeague();
  const mine = fx.rosters.find((r) => r.roster_id === TRADE_FIXTURE_MY_ROSTER)!.players!;
  const theirs = fx.rosters.find((r) => r.roster_id === 8)!.players!;
  return { fx, mine, theirs };
}

describe("reading Claude's answer", () => {
  const msg = (text: string, stop_reason: string = "end_turn") =>
    ({ content: [{ type: "text", text }], stop_reason }) as never;

  test("a schema-shaped JSON answer becomes the verdict", () => {
    expect(parseVerdict(msg(JSON.stringify(verdict)))).toEqual(verdict);
  });

  test("every way of not finishing is a plain-language error", () => {
    expect(() => parseVerdict(msg("", "refusal"))).toThrow("declined");
    expect(() => parseVerdict(msg("", "tool_use"))).toThrow("ran out of turns");
    expect(() => parseVerdict(msg("{", "max_tokens"))).toThrow("output limit");
    expect(() => parseVerdict(msg("not json"))).toThrow("not valid JSON");
    expect(() => parseVerdict(msg(JSON.stringify({ ...verdict, decision: "maybe" })))).toThrow("expected shape");
  });

  test("web searches become progress lines and sources, two per search", () => {
    const message = {
      content: [
        { type: "server_tool_use", name: "web_search", input: { query: "J.K. Dobbins injury" } },
        {
          type: "web_search_tool_result",
          content: [
            { type: "web_search_result", title: "One", url: "https://a" },
            { type: "web_search_result", title: "Two", url: "https://b" },
            { type: "web_search_result", title: "Three", url: "https://c" },
          ],
        },
        // A failed search returns an error object, not a list.
        { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
      ],
    } as never;
    expect(searchSteps(message)).toEqual(["Searching the web: J.K. Dobbins injury"]);
    expect(collectSources(message).map((s) => s.url)).toEqual(["https://a", "https://b"]);
  });

  test("the system prompt is a constant - nothing per-request leaks into it", () => {
    expect(TRADE_REVIEW_SYSTEM).toContain("evaluate_trade");
    expect(TRADE_REVIEW_SYSTEM).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  test("a counter is optional in the schema, and a decision is not", () => {
    expect(VerdictSchema.safeParse({ ...verdict, counter_offer: null, pitch: null }).success).toBe(true);
    const { decision: _d, ...rest } = verdict;
    expect(VerdictSchema.safeParse(rest).success).toBe(false);
  });
});

describe("the briefing", () => {
  test("carries the league, standings, both rosters and the engine's evaluation", async () => {
    const { mine, theirs } = fixtureTrade();
    const service = new TradeService(fixtureTradeSource(), () => NOW, cannedReviewer({ delayMs: 0 }));
    const job = await service.startDeep({ give: [mine[0]!], get: [theirs[0]!] });
    const b = job.briefing;

    expect(b).toContain("## Standings");
    expect(b).toContain("YOU - Fixture FC");
    expect(b).toContain("TRADE PARTNER - Team 8");
    expect(b).toContain("Trade deadline: week 11");
    expect(b).toContain("no kicker slot");
    expect(b).toContain("## Engine evaluation");
    expect(b).toContain(`On paper they receive ${Math.round(job.trade.marketRatio * 100)}%`);
    expect(b).toContain("## Best free agents");
    expect(b).toContain("Today is 2026-10-21");
    // Every player on both rosters, by name.
    const overview = await service.overview();
    for (const rosterId of [TRADE_FIXTURE_MY_ROSTER, 8]) {
      for (const p of overview.teams.find((t) => t.rosterId === rosterId)!.players) expect(b).toContain(p.name);
    }
  });

  test("is deterministic: the same trade on the same rosters reads the same", async () => {
    const { mine, theirs } = fixtureTrade();
    const a = new TradeService(fixtureTradeSource(), () => NOW, cannedReviewer({ delayMs: 0 }));
    const b = new TradeService(fixtureTradeSource(), () => NOW, cannedReviewer({ delayMs: 0 }));
    const ja = await a.startDeep({ give: [mine[1]!], get: [theirs[1]!] });
    const jb = await b.startDeep({ give: [mine[1]!], get: [theirs[1]!] });
    expect(ja.briefing).toBe(jb.briefing);
  });
});

describe("deep analysis jobs", () => {
  test("start answers at once, reports steps, and finishes with a verdict", async () => {
    const { mine, theirs } = fixtureTrade();
    const service = new TradeService(fixtureTradeSource(), Date.now, cannedReviewer({ delayMs: 1 }));
    const started = await service.startDeep({ give: [mine[0]!], get: [theirs[0]!] });
    expect(started.status).toBe("running");
    const done = await settle(service, started);
    expect(done.status).toBe("done");
    expect(done.verdict).not.toBeNull();
    expect(done.steps.length).toBeGreaterThan(2);
    expect(done.finishedAt).not.toBeNull();
  });

  test("a counter-offer is re-scored by the engine, not taken on the model's word", async () => {
    const service = new TradeService(fixtureTradeSource(), Date.now, cannedReviewer({ delayMs: 0 }));
    // Your second-best player for one of their bench pieces: fails the bar, so
    // the canned reviewer counters with the engine's best version.
    const overview = await service.overview();
    const t8 = overview.teams.find((t) => t.rosterId === 8)!;
    const me = overview.teams.find((t) => t.isMe)!;
    const give = [...me.players].sort((a, b) => b.marketValue - a.marketValue)[1]!.playerId;
    const get = [...t8.players].sort((a, b) => b.marketValue - a.marketValue)[3]!.playerId;
    const job = await settle(service, await service.startDeep({ give: [give], get: [get] }));
    expect(job.verdict?.decision).toBe("counter");
    expect(job.counter).not.toBeNull();
    expect(job.counter!.partner.rosterId).toBe(8);
    expect(job.counter!.give.map((p) => p.name)).toEqual(job.verdict!.counter_offer!.give);
  });

  test("the same trade on the same rosters is reused; a fresh run can be asked for", async () => {
    const { mine, theirs } = fixtureTrade();
    const service = new TradeService(fixtureTradeSource(), Date.now, cannedReviewer({ delayMs: 0 }));
    const first = await settle(service, await service.startDeep({ give: [mine[0]!], get: [theirs[0]!] }));
    const again = await service.startDeep({ give: [mine[0]!], get: [theirs[0]!] });
    expect(again.reused).toBe(true);
    expect(again.id).toBe(first.id);
    const fresh = await service.startDeep({ give: [mine[0]!], get: [theirs[0]!], fresh: true });
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.status).toBe("running");
  });

  test("a run already in flight is shared, not doubled", async () => {
    const { mine, theirs } = fixtureTrade();
    const service = new TradeService(fixtureTradeSource(), Date.now, cannedReviewer({ delayMs: 20 }));
    const a = await service.startDeep({ give: [mine[2]!], get: [theirs[2]!] });
    const b = await service.startDeep({ give: [mine[2]!], get: [theirs[2]!] });
    expect(b.id).toBe(a.id);
  });

  test("a failed run says why", async () => {
    const { mine, theirs } = fixtureTrade();
    const service = new TradeService(fixtureTradeSource(), Date.now, cannedReviewer({ delayMs: 0, fail: "overloaded" }));
    const job = await settle(service, await service.startDeep({ give: [mine[0]!], get: [theirs[0]!] }));
    expect(job.status).toBe("error");
    expect(job.error).toContain("overloaded");
  });

  test("bad trades are refused before any model call", async () => {
    const { mine, theirs, fx } = fixtureTrade();
    const service = new TradeService(fixtureTradeSource(), Date.now, cannedReviewer({ delayMs: 0 }));
    const other = fx.rosters.find((r) => r.roster_id === 9)!.players![0]!;
    await expect(service.startDeep({ give: [], get: [theirs[0]!] })).rejects.toThrow(TradeQueryError);
    await expect(service.startDeep({ give: [theirs[0]!], get: [theirs[1]!] })).rejects.toThrow("not on your roster");
    await expect(service.startDeep({ give: [mine[0]!], get: [theirs[0]!, other] })).rejects.toThrow("one other team");
  });

  test("without an API key it is unavailable, and says so", async () => {
    const { mine, theirs } = fixtureTrade();
    const offline: TradeReviewer = { unavailable: () => "no key", review: async () => { throw new Error("unreachable"); } };
    const service = new TradeService(fixtureTradeSource(), Date.now, offline);
    await expect(service.startDeep({ give: [mine[0]!], get: [theirs[0]!] })).rejects.toThrow(DeepUnavailableError);
  });
});

describe("the engine tools Claude calls", () => {
  /** A reviewer that just hands back the engine it was given. */
  function capture(): { reviewer: TradeReviewer; engine: Promise<ReviewEngine> } {
    let resolve!: (e: ReviewEngine) => void;
    const engine = new Promise<ReviewEngine>((r) => (resolve = r));
    return {
      engine,
      reviewer: {
        unavailable: () => null,
        review: async (input) => {
          resolve(input.engine);
          return new Promise(() => {}); // never finishes; the test only wants the engine
        },
      },
    };
  }

  test("players resolve by full name, by part of a name, or by id - within the right roster only", async () => {
    const { mine, theirs } = fixtureTrade();
    const { reviewer, engine } = capture();
    const service = new TradeService(fixtureTradeSource(), Date.now, reviewer);
    await service.startDeep({ give: [mine[0]!], get: [theirs[0]!] });
    const e = await engine;
    const overview = await service.overview();
    const myName = overview.teams.find((t) => t.isMe)!.players.find((p) => p.playerId === mine[0])!.name;
    const theirName = overview.teams.find((t) => t.rosterId === 8)!.players.find((p) => p.playerId === theirs[0])!.name;

    const byName = (await e.evaluate([myName], [theirName])) as { you_give: Array<{ player: string }> };
    expect(byName.you_give[0]!.player).toBe(myName);
    const byId = (await e.evaluate([mine[0]!], [theirs[0]!])) as { you_get: Array<{ player: string }> };
    expect(byId.you_get[0]!.player).toBe(theirName);
    // Their player is not on your roster, whatever the model types.
    await expect(e.evaluate([theirName], [theirName])).rejects.toThrow("your roster");
  });

  test("find and team answer in compact JSON", async () => {
    const { mine, theirs } = fixtureTrade();
    const { reviewer, engine } = capture();
    const service = new TradeService(fixtureTradeSource(), Date.now, reviewer);
    await service.startDeep({ give: [mine[0]!], get: [theirs[0]!] });
    const e = await engine;
    const found = (await e.find({ team: "Team 8" })) as { trades: unknown[] };
    expect(found.trades.length).toBeLessThanOrEqual(5);
    const team = (await e.team("Manager8")) as { record: string; players: unknown[] };
    expect(team.players.length).toBeGreaterThan(10);
    await expect(e.team("Nobody FC")).rejects.toThrow("No other team");
  });
});
