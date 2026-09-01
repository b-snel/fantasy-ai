/**
 * Local web server. Hono on Bun.serve - no Node adapter needed.
 *
 * Serves the single-page UI and streams draft state over SSE. Everything is
 * localhost-only by default; there is no auth because there is nothing to protect
 * and no reason for this to be reachable from anywhere but your own machine.
 */

import { Hono } from "hono";
import { config } from "../config.ts";
import type { DraftSession, LiveState } from "./state.ts";

/**
 * How long a stream may go without a client heartbeat before it is reaped, and how
 * often we check. The client beats every 5s, so 20s tolerates three missed beats.
 */
const HEARTBEAT_TIMEOUT_MS = 20_000;
const REAP_INTERVAL_MS = 5_000;

interface Subscription {
  id: string;
  lastSeen: number;
  close: () => void;
}

/**
 * Tracks live SSE clients.
 *
 * This exists because Bun (1.3.x) gives a server no usable signal that an SSE
 * client has gone away: the ReadableStream's `cancel` callback never fires, the
 * request's abort signal never aborts, and `controller.enqueue` keeps succeeding
 * into a socket with nobody on the other end. Verified directly rather than
 * assumed.
 *
 * That matters here specifically because EventSource reconnects itself on every
 * transient hiccup. Without reaping, a three-hour draft accumulates one dead
 * subscription per reconnect and every subsequent pick serialises the full state
 * into each of them.
 *
 * So liveness is client-driven: each stream carries an id, the page heartbeats
 * against it, and anything that stops beating is dropped.
 */
export class SubscriberRegistry {
  private subs = new Map<string, Subscription>();
  private reaper: ReturnType<typeof setInterval> | null = null;

  add(id: string, close: () => void): void {
    // A reconnect reusing an id replaces the old subscription rather than stacking.
    this.subs.get(id)?.close();
    this.subs.set(id, { id, lastSeen: Date.now(), close });
    this.ensureReaper();
  }

  touch(id: string): boolean {
    const sub = this.subs.get(id);
    if (!sub) return false;
    sub.lastSeen = Date.now();
    return true;
  }

  remove(id: string): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    sub.close();
    this.subs.delete(id);
    if (this.subs.size === 0) this.stopReaper();
  }

  /** Drop anything that has stopped heartbeating. Returns how many were reaped. */
  reap(now = Date.now(), timeoutMs = HEARTBEAT_TIMEOUT_MS): number {
    let reaped = 0;
    for (const [id, sub] of this.subs) {
      if (now - sub.lastSeen > timeoutMs) {
        sub.close();
        this.subs.delete(id);
        reaped++;
      }
    }
    if (this.subs.size === 0) this.stopReaper();
    return reaped;
  }

  get size(): number {
    return this.subs.size;
  }

  stop(): void {
    for (const sub of this.subs.values()) sub.close();
    this.subs.clear();
    this.stopReaper();
  }

  private ensureReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => this.reap(), REAP_INTERVAL_MS);
    // Never hold the process open just to reap.
    this.reaper.unref?.();
  }

  private stopReaper(): void {
    if (!this.reaper) return;
    clearInterval(this.reaper);
    this.reaper = null;
  }
}

export function createServer(session: DraftSession, registry = new SubscriberRegistry()) {
  const app = new Hono();

  app.get("/", async (c) => c.html(await Bun.file("web/index.html").text()));

  app.get(
    "/app.js",
    () =>
      new Response(Bun.file("web/app.js"), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }),
  );

  app.get(
    "/style.css",
    () =>
      new Response(Bun.file("web/style.css"), {
        headers: { "content-type": "text/css; charset=utf-8" },
      }),
  );

  app.get("/api/state", (c) => c.json(session.getState()));

  app.get("/api/stream", (c) => {
    const id = c.req.query("id") ?? crypto.randomUUID();
    let unsubscribe: (() => void) | null = null;
    let closed = false;

    const teardown = () => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
    };

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        const send = (state: LiveState) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(state)}\n\n`));
          } catch {
            teardown();
            registry.remove(id);
          }
        };

        unsubscribe = session.subscribe(send);
        registry.add(id, teardown);

        // These two fire on some runtimes and not on Bun. Wired up anyway: they
        // cost nothing and make cleanup immediate wherever they do work.
        c.req.raw.signal.addEventListener("abort", () => registry.remove(id), { once: true });
      },
      cancel() {
        registry.remove(id);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });

  /** The client says it is still there. */
  app.post("/api/heartbeat", (c) => {
    const id = c.req.query("id");
    const known = id ? registry.touch(id) : false;
    // `known: false` tells a client its stream was reaped, so it can reconnect.
    return c.json({ ok: true, known });
  });

  /** Sent on page unload so cleanup does not wait for the heartbeat to lapse. */
  app.post("/api/bye", (c) => {
    const id = c.req.query("id");
    if (id) registry.remove(id);
    return c.json({ ok: true });
  });

  app.post("/api/refresh", async (c) => {
    await session.refresh();
    return c.json({ ok: true });
  });

  app.post("/api/ask", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { question?: unknown };
    const question = typeof body.question === "string" ? body.question : "";
    if (!question.trim()) return c.json({ error: "Ask a question." }, 400);

    try {
      const result = await session.ask(question);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}

export function serve(session: DraftSession) {
  const registry = new SubscriberRegistry();
  const app = createServer(session, registry);
  const server = Bun.serve({ port: config.port, fetch: app.fetch });
  return { server, registry };
}
