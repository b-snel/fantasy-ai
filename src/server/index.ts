/**
 * Local web server. Hono on Bun.serve - no Node adapter needed.
 *
 * Serves the single-page UI and streams draft state over SSE. Everything is
 * localhost-only by default; there is no auth because there is nothing to protect
 * and no reason for this to be reachable from anywhere but your own machine.
 */

import { Hono } from "hono";
import { config } from "../config.ts";
import { getDraft, getNflState, getUserDrafts } from "../sleeper/client.ts";
import { listMockIds, parseDraftId, registerMock, unregisterMock } from "../data/mocks.ts";
import type { Draft } from "../sleeper/types.ts";
import type { DraftSession, LiveState } from "./state.ts";
import type { TradeProvider, TradeRequest } from "./trades.ts";
import { TradeQueryError, type TradeSort } from "../trade/search.ts";
import type { Horizon, WaiverProvider, WaiverRequest } from "./waivers.ts";
import { WaiverQueryError } from "../waiver/search.ts";

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

  /**
   * Remove only if this close callback still owns the id.
   *
   * Bun 1.4 started delivering stream cancel callbacks (1.3.x never did), and it
   * delivers them asynchronously. An EventSource reconnect reuses its id, so the
   * order can be: new stream registers under the id, THEN the old connection's
   * deferred cancel fires. An unconditional remove(id) there would tear down the
   * replacement subscription and silently stop live updates until the heartbeat
   * notices. Ownership-checked removal makes the late cancel a no-op.
   */
  removeIf(id: string, close: () => void): void {
    if (this.subs.get(id)?.close !== close) return;
    this.remove(id);
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

export function createServer(
  session: DraftSession,
  registry = new SubscriberRegistry(),
  trades: TradeProvider | null = null,
  waivers: WaiverProvider | null = null,
) {
  const app = new Hono();

  // no-store: a plain reload must always pick up the current client code -
  // heuristic browser caching of an uncacheable-looking localhost asset has
  // already served a stale app.js mid-test once.
  app.get("/", async (c) => c.html(await Bun.file("web/home.html").text()));
  app.get("/draft", async (c) => c.html(await Bun.file("web/index.html").text()));

  app.get(
    "/app.js",
    () =>
      new Response(Bun.file("web/app.js"), {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      }),
  );

  app.get(
    "/home.js",
    () =>
      new Response(Bun.file("web/home.js"), {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      }),
  );

  app.get("/trades", async (c) => c.html(await Bun.file("web/trades.html").text()));

  app.get(
    "/trades.js",
    () =>
      new Response(Bun.file("web/trades.js"), {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      }),
  );

  app.get("/waivers", async (c) => c.html(await Bun.file("web/waivers.html").text()));

  app.get(
    "/waivers.js",
    () =>
      new Response(Bun.file("web/waivers.js"), {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      }),
  );

  app.get(
    "/style.css",
    () =>
      new Response(Bun.file("web/style.css"), {
        headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" },
      }),
  );

  /**
   * No other site may drive this server from your browser. Every POST here is
   * same-origin from these pages; a cross-site one (a form or no-cors fetch on
   * some page you visit) is refused before it can start, say, a paid news check.
   */
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    const host = c.req.header("host");
    const originHost = (() => {
      try {
        return origin ? new URL(origin).host : null;
      } catch {
        return "unparseable"; // includes the literal "null" a sandboxed frame sends
      }
    })();
    const crossSite = site === "cross-site" || (originHost != null && host != null && originHost !== host);
    if (crossSite) return c.json({ error: "Cross-site requests are not allowed." }, 403);
    return next();
  });

  app.get("/api/state", (c) => c.json(session.getState()));

  /**
   * Everything the home page lists. League drafts come from Sleeper's documented
   * user-drafts endpoint; mocks come from the local registry, because Sleeper has
   * no endpoint that lists a user's mock drafts (probed live 2026-09-01).
   */
  app.get("/api/drafts", async (c) => {
    const season =
      (await getNflState().catch(() => null))?.season ?? String(new Date().getFullYear());
    const listed = (await getUserDrafts(config.userId, season).catch(() => null)) ?? [];
    // The user-drafts listing omits draft_order; the full draft object carries it
    // (that is where "you draft from slot 9" comes from). One extra GET per league.
    const leagueDrafts = await Promise.all(
      listed.map(async (d) => (await getDraft(d.draft_id).catch(() => null)) ?? d),
    );
    const mockIds = await listMockIds();
    const mocks = (
      await Promise.all(mockIds.map((id) => getDraft(id).catch(() => null)))
    ).filter((d): d is Draft => d != null);

    const summarize = (d: Draft) => ({
      draftId: d.draft_id,
      name: d.metadata?.name ?? "Draft",
      status: d.status,
      type: d.type,
      teams: d.settings.teams ?? null,
      rounds: d.settings.rounds ?? null,
      startTime: d.start_time ?? null,
      created: d.created ?? null,
      mySlot: d.draft_order?.[config.userId] ?? null,
      isMock: d.league_id == null,
      isPrimaryLeague: d.league_id === config.leagueId,
    });

    return c.json({
      activeDraftId: session.currentDraftId?.() ?? null,
      leagueDrafts: leagueDrafts.map(summarize),
      mocks: mocks.map(summarize),
    });
  });

  /** Remember a pasted mock draft (a Sleeper URL or a bare draft id). */
  app.post("/api/drafts", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { draft?: unknown };
    const id = typeof body.draft === "string" ? parseDraftId(body.draft) : null;
    if (!id) return c.json({ error: "Paste a Sleeper draft link or id." }, 400);

    const draft = await getDraft(id).catch(() => null);
    if (!draft) return c.json({ error: `Draft ${id} was not found on Sleeper.` }, 404);
    if (draft.league_id != null) {
      return c.json({ error: "That is a league draft - it is already listed above." }, 400);
    }

    await registerMock(id);
    return c.json({ ok: true, draftId: id });
  });

  app.delete("/api/drafts/:id", async (c) => {
    await unregisterMock(c.req.param("id"));
    return c.json({ ok: true });
  });

  /** Switch which draft the session follows. Subscribers stay connected. */
  app.post("/api/session", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { draftId?: unknown };
    const draftId = typeof body.draftId === "string" ? body.draftId.trim() : "";
    if (!draftId) return c.json({ error: "draftId is required." }, 400);

    await session.switchTo(draftId);
    const state = session.getState();
    if (state.status === "error") return c.json({ error: state.error }, 502);
    // A mock opened directly (env var, pasted id) gets remembered for next time.
    if (state.isMock && state.draftId) await registerMock(state.draftId);
    return c.json({ ok: true, draftId: state.draftId });
  });

  app.get("/api/stream", (c) => {
    const id = c.req.query("id") ?? crypto.randomUUID();
    let unsubscribe: (() => void) | null = null;
    let closeStream: (() => void) | null = null;
    let closed = false;

    const teardown = () => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      // Actually end the HTTP stream. Without this a reaped-but-alive client (a
      // background tab whose throttled heartbeats lapsed) is left holding an open,
      // silent connection: EventSource sees no error, never reconnects, and the
      // page stays frozen on old state indefinitely. Closing makes the client's
      // EventSource fire onerror and auto-reconnect for a fresh snapshot.
      closeStream?.();
      closeStream = null;
    };

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        closeStream = () => {
          try {
            controller.close();
          } catch {
            // Already closed or cancelled - nothing left to end.
          }
        };

        const send = (state: LiveState) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(state)}\n\n`));
          } catch {
            teardown();
            registry.removeIf(id, teardown);
          }
        };

        unsubscribe = session.subscribe(send);
        registry.add(id, teardown);

        // Cleanup is ownership-checked everywhere: on Bun 1.4 these callbacks DO
        // fire, asynchronously, and a reconnect reusing this id may already have
        // replaced the subscription by the time they land.
        c.req.raw.signal.addEventListener("abort", () => registry.removeIf(id, teardown), { once: true });
      },
      cancel() {
        registry.removeIf(id, teardown);
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

  /**
   * The trade analyzer: league overview (rosters, values, needs) and the search.
   * Both are pure engine work over cached data - no model calls, no spend.
   */
  app.get("/api/trades", async (c) => {
    if (!trades) return c.json({ error: "The trade analyzer is not available in this mode." }, 503);
    try {
      return c.json(await trades.overview({ refresh: c.req.query("refresh") === "1" }));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.post("/api/trades/analyze", async (c) => {
    if (!trades) return c.json({ error: "The trade analyzer is not available in this mode." }, 503);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const ids = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 8) : [];
    const sort = typeof body.sort === "string" && ["expected", "gain", "likely"].includes(body.sort)
      ? (body.sort as TradeSort)
      : undefined;
    const req: TradeRequest = {
      partner: typeof body.partner === "number" ? body.partner : null,
      give: ids(body.give),
      get: ids(body.get),
      keep: ids(body.keep),
      maxPerSide: typeof body.maxPerSide === "number" ? body.maxPerSide : undefined,
      sort,
    };
    try {
      return c.json(await trades.analyze(req));
    } catch (err) {
      const status = err instanceof TradeQueryError ? 400 : 502;
      return c.json({ error: err instanceof Error ? err.message : String(err) }, status);
    }
  });

  /**
   * The waiver analyzer: overview (roster, holes, alerts, odds, FAAB market) and
   * the search. Engine work over cached data - no model calls. The paid news
   * check is a background job: POST starts it (or returns the one in flight),
   * GET reports on it and never calls the model.
   */
  app.get("/api/waivers", async (c) => {
    if (!waivers) return c.json({ error: "The waiver analyzer is not available in this mode." }, 503);
    try {
      return c.json(await waivers.overview({ refresh: c.req.query("refresh") === "1" }));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  const waiverRequest = (body: Record<string, unknown>): WaiverRequest => {
    const ids = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 16) : [];
    const one = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
    const horizon =
      typeof body.horizon === "string" && ["auto", "week", "season", "playoffs"].includes(body.horizon)
        ? (body.horizon as Horizon)
        : undefined;
    const positions = ids(body.positions).filter((p) => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(p));
    return { horizon, positions, keep: ids(body.keep), add: one(body.add), drop: one(body.drop) };
  };

  /** A JSON object, or an empty request - never null, an array, or a number. */
  const objectBody = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
    const raw = await c.req.json().catch(() => null);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  };

  app.post("/api/waivers/analyze", async (c) => {
    if (!waivers) return c.json({ error: "The waiver analyzer is not available in this mode." }, 503);
    const body = await objectBody(c);
    try {
      return c.json(await waivers.analyze(waiverRequest(body)));
    } catch (err) {
      const status = err instanceof WaiverQueryError ? 400 : 502;
      return c.json({ error: err instanceof Error ? err.message : String(err) }, status);
    }
  });

  app.post("/api/waivers/news", async (c) => {
    if (!waivers) return c.json({ error: "The waiver analyzer is not available in this mode." }, 503);
    const body = await objectBody(c);
    try {
      return c.json(await waivers.startNews(waiverRequest(body)));
    } catch (err) {
      const status = err instanceof WaiverQueryError ? 400 : 503;
      return c.json({ error: err instanceof Error ? err.message : String(err) }, status);
    }
  });

  app.get("/api/waivers/news", (c) => {
    if (!waivers) return c.json({ error: "The waiver analyzer is not available in this mode." }, 503);
    return c.json(waivers.newsStatus());
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

export function serve(
  session: DraftSession,
  trades: TradeProvider | null = null,
  waivers: WaiverProvider | null = null,
) {
  const registry = new SubscriberRegistry();
  const app = createServer(session, registry, trades, waivers);
  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
    // Bun's default idle timeout (~10s) can drop the response body of a long
    // /api/refresh or /api/ask while an Opus call runs - observed live at 12s,
    // with a 24s model call behind it. 240s covers the slowest tool-loop answer
    // (Bun caps this field at 255).
    idleTimeout: 240,
  });
  return { server, registry };
}
