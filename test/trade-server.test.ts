/**
 * The trade analyzer's HTTP surface, driven by the real TradeService over the
 * offline fixture league. Catches what bites in use: a route that 404s, a bad
 * request that crashes instead of explaining itself, or a page that never loads
 * its script.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { createServer, SubscriberRegistry } from "../src/server/index.ts";
import { TradeService, type TradeAnalysis, type TradeOverview } from "../src/server/trades.ts";
import { fixtureTradeSource, TRADE_FIXTURE_MY_ROSTER } from "../fixtures/trade.ts";
import type { DraftSession } from "../src/server/state.ts";

const session = { getState: () => ({}), subscribe: () => () => {} } as unknown as DraftSession;

const registry = new SubscriberRegistry();
const app = createServer(session, registry, new TradeService(fixtureTradeSource()));
const server = Bun.serve({ port: 0, fetch: app.fetch });
const base = `http://localhost:${server.port}`;

// A server built without a trade provider, as an older entrypoint would.
const bare = Bun.serve({ port: 0, fetch: createServer(session, new SubscriberRegistry()).fetch });

afterAll(() => {
  registry.stop();
  server.stop(true);
  bare.stop(true);
});

const analyze = (body: unknown) =>
  fetch(base + "/api/trades/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("trade analyzer routes", () => {
  test("serves the page and its script", async () => {
    const page = await fetch(base + "/trades");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('src="/trades.js"');

    const js = await fetch(base + "/trades.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toBe("no-store");
  });

  test("the home page links to it", async () => {
    expect(await (await fetch(base + "/")).text()).toContain('href="/trades"');
  });

  test("the overview carries every team, with yours marked", async () => {
    const res = await fetch(base + "/api/trades");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TradeOverview;
    expect(body.teams).toHaveLength(12);
    expect(body.me).toBe(TRADE_FIXTURE_MY_ROSTER);
    expect(body.teams.filter((t) => t.isMe)).toHaveLength(1);
    expect(body.positions).toEqual(["QB", "RB", "WR", "TE", "DEF"]);
    expect(body.league.tradeDeadline).toBe(11);
    const player = body.teams[0]!.players[0]!;
    expect(player.weekly).toHaveLength(body.league.weeks.length);
  });

  test("a league-wide search returns trades with reasons and a pitch", async () => {
    const res = await analyze({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as TradeAnalysis;
    expect(body.trades.length).toBeGreaterThan(0);
    const t = body.trades[0]!;
    expect(t.passes).toBe(true);
    expect(t.give.length).toBeGreaterThan(0);
    expect(t.get.length).toBeGreaterThan(0);
    expect(t.forThem.length).toBeGreaterThan(0);
    expect(t.pitch).toContain(t.partner.manager);
  });

  test("an impossible request is a 400 with a reason, not a crash", async () => {
    const res = await analyze({ give: ["not-a-player"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not on your roster");
  });

  test("junk in the body is ignored rather than trusted", async () => {
    const res = await analyze({ partner: "five", give: [42, null], sort: "random", maxPerSide: 9 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TradeAnalysis;
    expect(body.maxPerSide).toBe(2);
    expect(body.partners.length).toBe(11);
  });

  test("without a trade provider the routes say so instead of 404ing", async () => {
    const res = await fetch(`http://localhost:${bare.port}/api/trades`);
    expect(res.status).toBe(503);
  });
});
