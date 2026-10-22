/**
 * The waiver analyzer's HTTP surface, driven by the real WaiverService over the
 * offline fixture league with a fixed clock. Catches what bites in use: a route
 * that 404s, a bad request that crashes instead of explaining itself, a page
 * that never loads its script - and the one paid step, the news check, starting
 * twice or never finishing.
 *
 * The news provider here is a fake that counts its calls and holds each one
 * open until the test lets it finish, so nothing bills and "running" can be
 * observed.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { createServer, SubscriberRegistry } from "../src/server/index.ts";
import {
  WaiverService,
  type NewsJobView,
  type WaiverAnalysis,
  type WaiverOverview,
} from "../src/server/waivers.ts";
import type { NewsProvider, NewsRequest, NewsResult } from "../src/waiver/news.ts";
import { fixtureWaiverSources, makeFixtureWaiverLeague, WAIVER_FIXTURE_MY_ROSTER } from "../fixtures/waiver.ts";
import type { DraftSession } from "../src/server/state.ts";

const session = { getState: () => ({}), subscribe: () => () => {} } as unknown as DraftSession;

const NOTE = "Took the first-team reps at Wednesday practice.";
const SUMMARY = "One clear add this week.";

/** A news provider that records each check and finishes it only when released. */
function fakeNews() {
  const calls: NewsRequest[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const provider: NewsProvider = {
    async check(req): Promise<NewsResult> {
      calls.push(req);
      await gate;
      const add = req.moves[0]?.add ?? req.candidates[0]!.playerId;
      return {
        items: [{ playerId: add, note: NOTE, outlook: "up", checkedAt: 1 }],
        verdicts: [{ add, verdict: "do", reason: "The role is real.", checkedAt: 1 }],
        summary: SUMMARY,
        costUsd: 0.12,
        searches: 3,
        model: "fake",
        cachedPlayers: 0,
        unchecked: [],
      };
    },
    async cached() {
      return { items: [], verdicts: [], summary: null };
    },
  };
  return { provider, calls, release: () => release() };
}

/** A server over a fresh fixture league and service. */
function start(news: NewsProvider | null, withWaivers = true) {
  const fx = makeFixtureWaiverLeague();
  const src = fixtureWaiverSources(fx);
  const waivers = withWaivers ? new WaiverService(src.trade, src.extras, news, () => fx.now) : null;
  const registry = new SubscriberRegistry();
  const server = Bun.serve({ port: 0, fetch: createServer(session, registry, null, waivers).fetch });
  return { fx, registry, server, base: `http://localhost:${server.port}` };
}

const main = fakeNews();
const app = start(main.provider);
// A server built without a waiver provider, as an older entrypoint would.
const bare = start(null, false);
// The demo's mode: the analyzer without a news provider.
const noNews = start(null);
const servers = [app, bare, noNews];

afterAll(() => {
  main.release();
  for (const s of servers) {
    s.registry.stop();
    s.server.stop(true);
  }
});

const post = (base: string, path: string, body: unknown) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const analyze = (body: unknown, base = app.base) => post(base, "/api/waivers/analyze", body);

/** Poll the news job until it leaves "running" (or give up after ~2s). */
async function settled(base: string): Promise<NewsJobView> {
  for (let i = 0; i < 100; i++) {
    const job = (await (await fetch(base + "/api/waivers/news")).json()) as NewsJobView;
    if (job.status !== "running") return job;
    await Bun.sleep(20);
  }
  throw new Error("news job never finished");
}

describe("waiver page", () => {
  // web/waivers.html and web/waivers.js are the UI; these fail loudly if either goes missing.
  test("serves the page and its script, uncached", async () => {
    const page = await fetch(app.base + "/waivers");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('src="/waivers.js"');

    const js = await fetch(app.base + "/waivers.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toBe("no-store");
  });

  test("the home page links to it", async () => {
    expect(await (await fetch(app.base + "/")).text()).toContain('href="/waivers"');
  });
});

describe("waiver API", () => {
  test("without a waiver provider every route says so instead of 404ing", async () => {
    expect((await fetch(bare.base + "/api/waivers")).status).toBe(503);
    expect((await analyze({}, bare.base)).status).toBe(503);
    expect((await post(bare.base, "/api/waivers/news", {})).status).toBe(503);
    expect((await fetch(bare.base + "/api/waivers/news")).status).toBe(503);
  });

  test("the overview carries every team, with yours marked, and a weight per week", async () => {
    const res = await fetch(app.base + "/api/waivers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WaiverOverview;
    expect(body.league_table).toHaveLength(12);
    expect(body.league_table.filter((t) => t.isMe)).toHaveLength(1);
    expect(body.league_table.find((t) => t.isMe)!.rosterId).toBe(WAIVER_FIXTURE_MY_ROSTER);
    expect(body.me).toBe(WAIVER_FIXTURE_MY_ROSTER);
    expect(body.team.players.length).toBeGreaterThan(0);
    expect(body.leverage.weights).toHaveLength(body.league.weeks.length);
    expect(body.newsAvailable).toBe(true);
    expect((await fetch(app.base + "/api/waivers?refresh=1")).status).toBe(200);
  });

  test("junk in the body is ignored rather than trusted", async () => {
    const res = await analyze({ horizon: "forever", positions: ["QB", 7, "XX"], keep: "everyone", add: 42, drop: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WaiverAnalysis;
    expect(body.horizon).toBe("auto");
    expect(body.proposal).toBeNull();
    // Not JSON at all is an empty request, not a crash.
    expect((await analyze("{not json")).status).toBe(200);
  });

  test("the week horizon weights this week only", async () => {
    const body = (await (await analyze({ horizon: "week" })).json()) as WaiverAnalysis;
    expect(body.horizon).toBe("week");
    expect(body.weights).toEqual(body.weights.map((_, i) => (i === 0 ? 1 : 0)));
    expect(body.weights.length).toBeGreaterThan(1);
  });

  test("an impossible request is a 400 with a reason", async () => {
    const mine = app.fx.trade.rosters.find((r) => r.roster_id === WAIVER_FIXTURE_MY_ROSTER)!.players ?? [];
    const theirs = app.fx.trade.rosters.find((r) => r.roster_id !== WAIVER_FIXTURE_MY_ROSTER)!.players ?? [];
    const rostered = await analyze({ add: theirs[0] });
    expect(rostered.status).toBe(400);
    expect(((await rostered.json()) as { error: string }).error).toContain("not a free agent");
    const notMine = await analyze({ drop: theirs[0] });
    expect(notMine.status).toBe(400);
    expect(((await notMine.json()) as { error: string }).error).toContain("not on your roster");
    expect((await analyze({ add: mine[0] })).status).toBe(400);
  });
});

describe("the news check", () => {
  test("runs in the background: running, then done, and the notes land on the moves", async () => {
    const before = (await (await fetch(app.base + "/api/waivers/news")).json()) as NewsJobView;
    expect(before.status).toBe("idle");

    const res = await post(app.base, "/api/waivers/news", {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as NewsJobView).status).toBe("running");
    const running = (await (await fetch(app.base + "/api/waivers/news")).json()) as NewsJobView;
    expect(running.status).toBe("running");
    expect(main.calls).toHaveLength(1);

    main.release();
    const done = await settled(app.base);
    expect(done.status).toBe("done");
    expect(done.costUsd).toBe(0.12);
    expect(done.summary).toBe(SUMMARY);
    expect(done.items.map((i) => i.note)).toContain(NOTE);

    const annotated = main.calls[0]!.moves[0]!.add;
    const body = (await (await analyze({})).json()) as WaiverAnalysis;
    const move = body.moves.find((m) => m.add.playerId === annotated)!;
    expect(move).toBeDefined();
    expect(move.news).toEqual({ note: NOTE, outlook: "up" });
    expect(move.verdict).toEqual({ verdict: "do", reason: "The role is real." });
    expect(body.news).toEqual({ summary: SUMMARY });
    // Moves the check said nothing about carry nothing.
    for (const m of body.moves.filter((x) => x.add.playerId !== annotated)) expect(m.news).toBeNull();
  });

  test("two clicks at once start one check, not two", async () => {
    const news = fakeNews();
    const s = start(news.provider);
    servers.push(s);
    try {
      const [a, b] = await Promise.all([post(s.base, "/api/waivers/news", {}), post(s.base, "/api/waivers/news", {})]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(news.calls).toHaveLength(1);
    } finally {
      news.release();
      await settled(s.base);
    }
  });

  test("a cross-site POST cannot start a paid check", async () => {
    const news = fakeNews();
    const s = start(news.provider);
    servers.push(s);
    // What a form on some other page you visit would send.
    const res = await fetch(s.base + "/api/waivers/news", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(res.status).toBe(403);
    expect(news.calls).toHaveLength(0);
    // The page itself (same origin) still can.
    const own = await fetch(s.base + "/api/waivers/news", {
      method: "POST",
      headers: { origin: s.base, "content-type": "application/json" },
      body: "{}",
    });
    expect(own.status).toBe(200);
    news.release();
    await settled(s.base);
  });

  test("without a news provider the check is a 503, and the rest still works", async () => {
    const res = await post(noNews.base, "/api/waivers/news", {});
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("not available");
    const overview = (await (await fetch(noNews.base + "/api/waivers")).json()) as WaiverOverview;
    expect(overview.newsAvailable).toBe(false);
    expect((await analyze({}, noNews.base)).status).toBe(200);
  });
});
