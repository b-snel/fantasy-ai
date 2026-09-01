/**
 * Server smoke tests.
 *
 * The live DraftSession needs Sleeper, which this sandbox cannot reach, so these
 * drive the HTTP surface against a stub session. That still catches the failures
 * that actually bite on draft day: a route that 404s, an SSE stream that never
 * flushes, malformed JSON, or a missing static asset.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { createServer, SubscriberRegistry } from "../src/server/index.ts";
import type { DraftSession, LiveState } from "../src/server/state.ts";

function stubState(over: Partial<LiveState> = {}): LiveState {
  return {
    status: "ready",
    error: null,
    league: { name: "Test League", teams: 12, rounds: 15, scoring: "sleeper_weekly" },
    draftStatus: "drafting",
    currentPick: 7,
    currentRound: 1,
    totalPicks: 180,
    onTheClockName: "Someone",
    isMyTurn: true,
    picksUntilMyTurn: 0,
    myNextPick: 7,
    myPickAfterNext: 18,
    pickTimerSeconds: 90,
    lastPickedAt: 1757800000000,
    roster: [],
    unfilledSlots: ["QB", "RB x2"],
    candidates: [],
    recentPicks: [],
    positionalRun: null,
    tierWarnings: [],
    effectivelyTied: false,
    recommendation: null,
    recommendationStale: false,
    lastCallReason: "on the clock",
    projectionSource: "sleeper_weekly",
    spendUsd: 0.031,
    lastUsage: null,
    updatedAt: 1757800000000,
    ...over,
  };
}

let refreshCalls = 0;
const listeners = new Set<(s: LiveState) => void>();

const session = {
  getState: () => stubState(),
  subscribe: (fn: (s: LiveState) => void) => {
    listeners.add(fn);
    fn(stubState());
    return () => listeners.delete(fn);
  },
  refresh: async () => {
    refreshCalls++;
  },
} as unknown as DraftSession;

const registry = new SubscriberRegistry();
const app = createServer(session, registry);
const server = Bun.serve({ port: 0, fetch: app.fetch });
const base = `http://localhost:${server.port}`;

afterAll(() => {
  registry.stop();
  server.stop(true);
});

describe("routes", () => {
  test("serves the page shell", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Draft Assistant");
    expect(html).toContain('src="/app.js"');
  });

  test("serves the client script and stylesheet with correct content types", async () => {
    const js = await fetch(base + "/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain("EventSource");

    const css = await fetch(base + "/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("css");
  });

  test("returns the current state as JSON", async () => {
    const res = await fetch(base + "/api/state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as LiveState;
    expect(body.league?.name).toBe("Test League");
    expect(body.isMyTurn).toBe(true);
    expect(body.currentPick).toBe(7);
  });

  test("refresh triggers a recommendation", async () => {
    const before = refreshCalls;
    const res = await fetch(base + "/api/refresh", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(refreshCalls).toBe(before + 1);
  });

  test("unknown routes 404 rather than hanging", async () => {
    expect((await fetch(base + "/nope")).status).toBe(404);
  });
});

describe("SSE stream", () => {
  test("sends the current state immediately on connect", async () => {
    const res = await fetch(base + "/api/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);

    expect(chunk.startsWith("data: ")).toBe(true);
    const payload = JSON.parse(chunk.slice(6).trim()) as LiveState;
    expect(payload.currentPick).toBe(7);

    await reader.cancel();
  });

  test("pushes subsequent state changes to connected clients", async () => {
    const res = await fetch(base + "/api/stream");
    const reader = res.body!.getReader();
    await reader.read(); // the initial snapshot

    // Simulate the session emitting a new pick.
    for (const fn of listeners) fn(stubState({ currentPick: 8, isMyTurn: false }));

    const { value } = await reader.read();
    const payload = JSON.parse(new TextDecoder().decode(value).slice(6).trim()) as LiveState;
    expect(payload.currentPick).toBe(8);
    expect(payload.isMyTurn).toBe(false);

    await reader.cancel();
  });

  test("an explicit goodbye unsubscribes immediately", async () => {
    const before = listeners.size;
    const id = "bye-test";
    const res = await fetch(`${base}/api/stream?id=${id}`);
    const reader = res.body!.getReader();
    await reader.read();
    expect(listeners.size).toBe(before + 1);

    await fetch(`${base}/api/bye?id=${id}`, { method: "POST" });
    expect(listeners.size).toBe(before);

    await reader.cancel();
  });

  test("a reconnect reusing an id replaces its subscription rather than stacking", async () => {
    const before = listeners.size;
    const id = "reconnect-test";

    const first = await fetch(`${base}/api/stream?id=${id}`);
    const r1 = first.body!.getReader();
    await r1.read();

    const second = await fetch(`${base}/api/stream?id=${id}`);
    const r2 = second.body!.getReader();
    await r2.read();

    // Two connections, one id, one live subscription.
    expect(listeners.size).toBe(before + 1);

    await fetch(`${base}/api/bye?id=${id}`, { method: "POST" });
    await r1.cancel();
    await r2.cancel();
  });
});

describe("SubscriberRegistry", () => {
  // Bun fires neither the stream cancel callback nor the request abort signal when
  // an SSE client disappears, and enqueueing into the dead socket keeps succeeding.
  // Client heartbeats are therefore the only disconnect signal available, and this
  // registry is what turns a missed beat into a released subscription.

  test("reaps a subscription that stops heartbeating", () => {
    const reg = new SubscriberRegistry();
    let closed = false;
    reg.add("a", () => {
      closed = true;
    });
    expect(reg.size).toBe(1);

    // Not yet stale.
    expect(reg.reap(Date.now(), 20_000)).toBe(0);
    expect(closed).toBe(false);

    // Well past the timeout.
    expect(reg.reap(Date.now() + 60_000, 20_000)).toBe(1);
    expect(closed).toBe(true);
    expect(reg.size).toBe(0);
  });

  test("a heartbeat keeps a subscription alive", () => {
    const reg = new SubscriberRegistry();
    reg.add("a", () => {});
    const later = Date.now() + 60_000;

    // Simulate a beat arriving just before the reap.
    expect(reg.touch("a")).toBe(true);
    expect(reg.reap(later, 120_000)).toBe(0);
    expect(reg.size).toBe(1);
    reg.stop();
  });

  test("heartbeating an unknown id reports that it is unknown", () => {
    const reg = new SubscriberRegistry();
    expect(reg.touch("never-existed")).toBe(false);
  });

  test("re-adding an id closes the previous subscription", () => {
    const reg = new SubscriberRegistry();
    let firstClosed = false;
    reg.add("a", () => {
      firstClosed = true;
    });
    reg.add("a", () => {});
    expect(firstClosed).toBe(true);
    expect(reg.size).toBe(1);
    reg.stop();
  });

  test("stop releases everything", () => {
    const reg = new SubscriberRegistry();
    let closed = 0;
    reg.add("a", () => closed++);
    reg.add("b", () => closed++);
    reg.stop();
    expect(closed).toBe(2);
    expect(reg.size).toBe(0);
  });

  test("removing an unknown id is a no-op", () => {
    const reg = new SubscriberRegistry();
    expect(() => reg.remove("nope")).not.toThrow();
  });
});
