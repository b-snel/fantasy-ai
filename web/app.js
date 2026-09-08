/*
 * Draft-room client.
 *
 * Plain DOM against an SSE stream - no framework, no build step. The server holds
 * all the state and pushes a complete snapshot on every change, so there is no
 * client-side model to drift out of sync with the draft.
 */

const el = (id) => document.getElementById(id);

let latest = null;
let countdownTimer = null;

/*
 * Each stream carries an id and the page heartbeats against it.
 *
 * This is not belt-and-braces - it is the only disconnect signal the server gets.
 * Bun does not fire the stream's cancel callback or the request abort signal when
 * a browser goes away, and writes into the dead socket keep succeeding, so without
 * these beats the server would fan every pick out to subscriptions belonging to
 * tabs that closed hours ago.
 */
const STREAM_ID = crypto.randomUUID();
const HEARTBEAT_MS = 5000;

let source = null;

/*
 * The heartbeat below proves to the SERVER that this page is alive. Nothing in
 * the SSE machinery proves the reverse: a half-open socket, a connection broken
 * during tab suspension, or a missed close can leave the EventSource reporting
 * OPEN while no bytes will ever arrive again - the page just freezes on old
 * state. The server pushes a full snapshot at least every poll interval in
 * every draft status, so silence is unambiguous: no message for STALL_MS means
 * the stream is dead, whatever readyState claims. Reconnect.
 */
const STALL_MS = 10_000;
let lastEventAt = Date.now();

function connect() {
  source?.close();
  // Grace period: a fresh handshake has not delivered anything yet.
  lastEventAt = Date.now();
  source = new EventSource(`/api/stream?id=${STREAM_ID}`);

  source.onmessage = (event) => {
    lastEventAt = Date.now();
    try {
      latest = JSON.parse(event.data);
      render(latest);
    } catch (err) {
      console.error("bad state payload", err);
    }
  };

  source.onerror = () => {
    // EventSource reconnects on its own; say so rather than looking frozen.
    el("status").textContent = "Reconnecting to the draft server…";
  };
}

async function sendHeartbeat() {
  // The verdict below describes the stream that existed when the POST was
  // processed. If connect() replaced it while the request was in flight (the
  // visibilitychange handler does exactly that), the reply is about a
  // connection that no longer exists - acting on it would tear down the
  // healthy replacement. Only reconnect if `source` is still the one we asked
  // about.
  const asked = source;
  try {
    const res = await fetch(`/api/heartbeat?id=${STREAM_ID}`, { method: "POST" });
    const data = await res.json();
    // known:false means the server reaped this stream - it happens when a
    // background tab's throttled timers let the heartbeat lapse. The old
    // connection is dead or orphaned; reconnect for a fresh snapshot. Skip if
    // the EventSource is already mid-handshake (it will register itself).
    if (data.known === false && source === asked && source?.readyState === EventSource.OPEN) {
      connect();
    }
  } catch {
    // Server is down or restarting; EventSource will reconnect on its own.
  }
}

setInterval(sendHeartbeat, HEARTBEAT_MS);

// The every-2s pulse only holds once the session is "ready" - during boot, a
// draft switch, or an error state the server pushes one snapshot per connect
// and then goes legitimately quiet, and reconnecting into that would cycle
// every STALL_MS for nothing.
function stalled() {
  return latest?.status === "ready" && Date.now() - lastEventAt > STALL_MS;
}

// The stall watchdog. Only while visible: a throttled background tab starves
// itself of messages legitimately, and reconnecting there would fight the
// browser; the visibilitychange handler below covers the return trip.
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  if (stalled()) connect();
}, 2000);

// Browsers throttle timers hard in background tabs, so the heartbeat that would
// notice a reaped stream may itself be delayed a minute. Beat the moment the tab
// is visible again so recovery is instant instead of one throttled tick away -
// and if the stream went quiet while hidden, reconnect right now too.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  void sendHeartbeat();
  if (stalled()) connect();
});

// Best-effort immediate cleanup. sendBeacon survives the page going away, which
// fetch does not; the heartbeat timeout covers the cases where it does not fire
// (a crash, a killed tab, a laptop lid).
addEventListener("pagehide", () => {
  navigator.sendBeacon?.(`/api/bye?id=${STREAM_ID}`);
});

el("refresh").addEventListener("click", async () => {
  const button = el("refresh");
  button.disabled = true;
  button.textContent = "Thinking…";
  try {
    await fetch("/api/refresh", { method: "POST" });
  } finally {
    button.disabled = false;
    button.textContent = "Refresh";
  }
});

/*
 * Free-form questions.
 *
 * Runs the agentic tool loop server-side, so it is slower and pricier than a card
 * refresh. Worth it for a real question, wasteful on a reflex - hence a deliberate
 * submit rather than anything that fires on its own.
 */
el("askform").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = el("askinput");
  const question = input.value.trim();
  if (!question) return;

  const out = el("askout");
  out.innerHTML = `<p class="q">${escapeHtml(question)}</p><p class="a muted">Thinking…</p>`;
  input.disabled = true;

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      out.innerHTML = `<p class="q">${escapeHtml(question)}</p>` +
        `<p class="err">${escapeHtml(data.error ?? "Ask failed.")}</p>`;
      return;
    }

    const tools = data.toolCalls?.length ? ` · ${data.toolCalls.join(", ")}` : "";
    out.innerHTML =
      `<p class="q">${escapeHtml(question)}</p>` +
      `<p class="a">${escapeHtml(data.answer)}</p>` +
      `<p class="meta">$${(data.usage?.estimatedCostUsd ?? 0).toFixed(4)} · ` +
      `${data.usage?.latencyMs ?? 0}ms${escapeHtml(tools)}</p>`;
    input.value = "";
  } catch (err) {
    out.innerHTML = `<p class="err">${escapeHtml(String(err))}</p>`;
  } finally {
    input.disabled = false;
    input.focus();
  }
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(s) {
  if (s.status === "error") {
    el("turn").textContent = "Error";
    el("cards").innerHTML = `<p class="empty">${escapeHtml(s.error ?? "unknown error")}</p>`;
    // This path skips renderCards, whose reset would otherwise keep the
    // "Analyzing… Ns" clock honest across an error-and-recover.
    analyzingSince = null;
    return;
  }

  renderBar(s);
  renderAlerts(s);
  renderCards(s);
  renderRoster(s);
  renderRecent(s);
  renderShortlist(s);
  renderStatus(s);
}

function renderBar(s) {
  el("pick").textContent = s.currentPick ? `Pick ${s.currentPick}` : "—";
  el("round").textContent = s.currentRound ? `round ${s.currentRound} of ${s.league?.rounds ?? "?"}` : "";

  const turn = el("turn");
  turn.classList.remove("mine", "soon");

  if (s.draftStatus === "complete") {
    turn.textContent = "Draft complete";
  } else if (s.isMyTurn) {
    turn.textContent = "You are on the clock";
    turn.classList.add("mine");
  } else if (s.picksUntilMyTurn === null) {
    turn.textContent = "No picks remaining";
  } else {
    const who = s.onTheClockName ? `${s.onTheClockName} picking` : "Waiting";
    turn.textContent = `${who} — you are up in ${s.picksUntilMyTurn}`;
    if (s.picksUntilMyTurn <= 3) turn.classList.add("soon");
  }

  el("spend").textContent = s.spendUsd > 0 ? `$${s.spendUsd.toFixed(3)}` : "";
  el("mockbadge").style.display = s.isMock ? "" : "none";
  startCountdown(s);
}

/**
 * Pick clock. Sleeper gives the timer length and the moment of the last pick, so
 * the remaining time is derived rather than pushed - the server does not need to
 * stream a tick every second.
 */
function startCountdown(s) {
  if (countdownTimer) clearInterval(countdownTimer);
  const clock = el("clock");

  if (!s.pickTimerSeconds || !s.lastPickedAt || s.draftStatus !== "drafting") {
    clock.textContent = "";
    return;
  }

  const tick = () => {
    const elapsed = (Date.now() - s.lastPickedAt) / 1000;
    const left = Math.max(0, Math.round(s.pickTimerSeconds - elapsed));
    const mins = Math.floor(left / 60);
    const secs = String(left % 60).padStart(2, "0");
    clock.textContent = `${mins}:${secs}`;
    clock.classList.toggle("urgent", left <= 15);
  };

  tick();
  countdownTimer = setInterval(tick, 1000);
}

function renderAlerts(s) {
  const alerts = [];

  if (s.positionalRun) {
    const r = s.positionalRun;
    alerts.push({
      cls: "run",
      text: `Run on ${r.position} — ${r.count} of the last ${r.window} picks`,
    });
  }

  for (const w of s.tierWarnings) {
    alerts.push({
      cls: "tier",
      text: `${w.remaining} left in ${w.position} tier ${w.tier} (${Math.round(w.cliff)}-pt drop after)`,
    });
  }

  if (s.effectivelyTied && s.candidates.length) {
    alerts.push({ cls: "tied", text: "Top options are within noise — this pick barely matters" });
  }

  if (s.projectionSource === "search_rank") {
    alerts.push({ cls: "warn", text: "Using search_rank fallback — point values are approximate" });
  }

  if (s.cacheWarning) {
    alerts.push({ cls: "warn", text: `Cache health: ${s.cacheWarning}` });
  }

  el("alerts").innerHTML = alerts
    .map((a) => `<span class="alert ${a.cls}">${escapeHtml(a.text)}</span>`)
    .join("");
}

// When the current stretch of loading skeletons began - the elapsed label is
// the difference between "thinking" and "frozen" to someone on a pick clock.
let analyzingSince = null;

function renderCards(s) {
  const container = el("cards");

  // How many picks have happened since the advice on screen was computed. In a
  // fast draft the model's ~20s latency means the last completed answer can be
  // several picks old by the time you are on the clock - and old cards name
  // players who are already gone. Never present those as current.
  const behind =
    s.recommendation && s.recommendationForPick != null
      ? Math.max(0, s.currentPick - s.recommendationForPick)
      : 0;
  const outdated = behind >= 2;

  if (s.recommendationStale && (!s.recommendation || outdated)) {
    // A fresh call is in flight and no current prose is worth showing. The
    // engine's own ranking is instant and deterministic, so show its top three
    // as provisional cards - the same numbers the model is reasoning over -
    // rather than making the pick clock run against a blank screen.
    container.classList.remove("stale");
    if (analyzingSince === null) analyzingSince = Date.now();
    // Server pushes land every couple of seconds, so this ticks without a timer.
    const waited = Math.round((Date.now() - analyzingSince) / 1000);
    el("boardread").textContent =
      (s.isMyTurn
        ? `Analyzing pick ${s.currentPick} — you are on the clock…`
        : `Analyzing pick ${s.currentPick}…`) + (waited >= 3 ? ` ${waited}s` : "");

    if (s.candidates.length) {
      // Re-render when the top three OR the pick changes - survival, VONA, and
      // tier-remaining move on every pick even when the same names stay on
      // top, and frozen numbers here would contradict the live shortlist
      // beside them. Between picks the values are constant, so this still
      // avoids the every-2s rewrite that restarts photo loads.
      const key = `${s.currentPick}:${s.candidates.slice(0, 3).map((c) => c.playerId).join(",")}`;
      if (container.dataset.engine !== key) {
        container.innerHTML = s.candidates
          .slice(0, 3)
          .map((c, i) => renderEngineCard(c, i === 0))
          .join("");
        container.dataset.engine = key;
        for (const img of container.querySelectorAll("img.photo")) {
          img.addEventListener("error", onPhotoError);
        }
      }
    } else if (!container.querySelector(".skeleton")) {
      // Nothing to rank yet (draft not started): shimmer skeletons. Left in
      // place across pushes so the animation does not restart.
      delete container.dataset.engine;
      container.innerHTML = skeletonCard() + skeletonCard() + skeletonCard();
    }
    return;
  }
  analyzingSince = null;
  // Anything below writes real content; a stale engine key must not suppress
  // the next provisional render.
  delete container.dataset.engine;

  container.classList.toggle("stale", s.recommendationStale);
  el("boardread").textContent = s.recommendation?.board_read ?? "";

  if (!s.recommendation) {
    container.innerHTML = `<p class="empty">${escapeHtml(
      s.candidates.length
        ? `No recommendation yet — ${s.lastCallReason}. The shortlist is on the right.`
        : "Waiting for the draft to start…",
    )}</p>`;
    return;
  }

  // Honest labelling: updating, or computed a pick or two ago.
  const freshness = s.recommendationStale
    ? `<p class="thinking">Updating for pick ${s.currentPick}…</p>`
    : behind >= 1
      ? `<p class="freshness">Computed at pick ${s.recommendationForPick}, ${behind} pick${behind > 1 ? "s" : ""} ago</p>`
      : "";

  const byId = new Map(s.candidates.map((c) => [c.playerId, c]));
  const byName = new Map(s.candidates.map((c) => [c.name, c]));
  const topId = s.recommendation.top_pick_player_id;

  // The schema asks the model for ids, but be forgiving if a name lands in
  // player_id anyway - an unmatched card renders with no photo or stats. The
  // third arm covers the swapped case (name in player_id, id in name).
  const statsFor = (card) => byId.get(card.player_id) ?? byName.get(card.name) ?? byName.get(card.player_id);

  // Resolve the top pick through the same forgiving lookup: the two fields are
  // filled independently by the model, and a strict string compare would drop
  // the "Top pick" badge whenever they mix conventions.
  const topStats = byId.get(topId) ?? byName.get(topId);

  container.innerHTML =
    freshness +
    s.recommendation.cards
      .map((card) => {
        const stats = statsFor(card);
        const isTop = stats && topStats ? stats === topStats : card.player_id === topId;
        return renderCard(card, stats, isTop);
      })
      .join("");

  // Swap in the fallback image, then initials, without a server round-trip.
  for (const img of container.querySelectorAll("img.photo")) {
    img.addEventListener("error", onPhotoError);
  }
}

function skeletonCard() {
  return `
    <article class="card skeleton">
      <div class="photo-fallback shimmer"></div>
      <div>
        <div class="sk-line shimmer" style="width:38%"></div>
        <div class="sk-line shimmer" style="width:88%"></div>
        <div class="sk-line shimmer" style="width:74%"></div>
        <div class="sk-line shimmer" style="width:52%"></div>
      </div>
    </article>`;
}

function onPhotoError(event) {
  const img = event.currentTarget;
  const fallback = img.dataset.fallback;
  if (fallback && img.src !== fallback) {
    img.src = fallback;
    return;
  }
  const div = document.createElement("div");
  div.className = "photo-fallback";
  div.textContent = img.dataset.initials ?? "?";
  img.replaceWith(div);
}

function renderCard(card, stats, isTop) {
  const photo = stats
    ? `<img class="photo" src="${escapeAttr(stats.photo)}" alt=""
         data-fallback="${escapeAttr(stats.photoFallback ?? "")}"
         data-initials="${escapeAttr(stats.initials)}" />`
    : `<div class="photo-fallback">?</div>`;

  const badges = [];
  if (stats) badges.push(`<span class="badge pos">${escapeHtml(stats.position)}</span>`);
  if (stats?.team) badges.push(`<span class="badge">${escapeHtml(stats.team)}</span>`);
  if (stats?.byeWeek) badges.push(`<span class="badge">BYE ${stats.byeWeek}</span>`);
  if (isTop) badges.push(`<span class="badge topper">Top pick</span>`);
  if (stats?.injuryStatus) {
    badges.push(`<span class="badge injury">${escapeHtml(stats.injuryStatus)}</span>`);
  }
  if (stats && stats.reason !== "value") {
    badges.push(`<span class="badge flag">${escapeHtml(stats.reason.replace("_", " "))}</span>`);
  }

  return `
    <article class="card${isTop ? " top" : ""}">
      ${photo}
      <div>
        <div class="card-head">
          <span class="name">${escapeHtml(card.name)}</span>
          ${badges.join("")}
        </div>
        <p class="verdict">${escapeHtml(card.verdict)}</p>
        <ul class="rationale">
          ${card.rationale.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}
        </ul>
        <p class="risk"><b>Risk:</b> ${escapeHtml(card.risk)} · ${escapeHtml(card.confidence)} confidence</p>
        ${stats ? renderStats(stats) : ""}
      </div>
    </article>`;
}

/*
 * A provisional card straight from the deterministic engine - shown the moment
 * a fresh model call starts, so being on the clock never means a blank screen.
 * Same layout as the real cards, minus the model's prose (which is exactly the
 * part that takes 20-30s). Dashed border + "Engine #1" badge mark it interim.
 */
function renderEngineCard(c, isTop) {
  const photo = `<img class="photo" src="${escapeAttr(c.photo)}" alt=""
       data-fallback="${escapeAttr(c.photoFallback ?? "")}"
       data-initials="${escapeAttr(c.initials)}" />`;

  const badges = [`<span class="badge pos">${escapeHtml(c.position)}</span>`];
  if (c.team) badges.push(`<span class="badge">${escapeHtml(c.team)}</span>`);
  if (c.byeWeek) badges.push(`<span class="badge">BYE ${c.byeWeek}</span>`);
  if (isTop) badges.push(`<span class="badge topper">Engine #1</span>`);
  if (c.injuryStatus) badges.push(`<span class="badge injury">${escapeHtml(c.injuryStatus)}</span>`);
  if (c.reason !== "value") {
    badges.push(`<span class="badge flag">${escapeHtml(c.reason.replace("_", " "))}</span>`);
  }

  return `
    <article class="card engine${isTop ? " top" : ""}">
      ${photo}
      <div>
        <div class="card-head">
          <span class="name">${escapeHtml(c.name)}</span>
          ${badges.join("")}
        </div>
        <p class="verdict muted">Engine ranking — the model's read replaces this in a moment.</p>
        ${renderStats(c)}
      </div>
    </article>`;
}

/**
 * One-line plain-English definitions for the engine's numbers, shown on hover.
 * Grounded in what the engine actually computes (see src/engine/rank.ts) - keep
 * them short enough to read with a pick clock running.
 */
const TIPS = {
  proj: "Projected season points, scored with this league's exact settings.",
  vorp: "Value over replacement: points above the worst starter this league will field at the position. Makes players at different positions comparable.",
  vona: "Value over next available: points you give up by passing and taking the best player left at this position at your next pick. High = act now, low = can wait.",
  tier: "Players grouped by real gaps in projected points - a new tier starts at a sharp drop. 'Left' counts who is still on the board in this tier.",
  lasts: "Chance this player is still on the board at your next pick, modeled from average draft position.",
  adp: "Average draft position minus the current pick. Positive = falling past where he usually goes (a value). Negative = a reach.",
};

/** A stat label with a hover tooltip. mod: "tip-l"/"tip-r" pins the bubble to an edge. */
function tip(key, label, mod = "") {
  return `<span class="tip${mod ? ` ${mod}` : ""}" data-tip="${escapeAttr(TIPS[key])}">${label}</span>`;
}

function renderStats(c) {
  const signed = (n) => (n > 0 ? `+${n}` : String(n));
  const cls = (n) => (n > 0 ? "pos-val" : n < 0 ? "neg-val" : "");
  const adp =
    c.adpDelta === null
      ? ""
      : `<span>${tip("adp", "ADP")} <b class="${cls(c.adpDelta)}">${signed(Math.round(c.adpDelta))}</b></span>`;

  return `
    <div class="stats">
      <span>${tip("proj", "Proj", "tip-l")} <b>${Math.round(c.projectedPoints)}</b></span>
      <span>${tip("vorp", "VORP")} <b>${Math.round(c.vorp)}</b></span>
      <span>${tip("vona", "VONA")} <b class="${cls(c.vona)}">${signed(Math.round(c.vona))}</b></span>
      <span>${tip("tier", "Tier")} <b>${c.tier}</b> (${c.tierRemaining} left)</span>
      <span>${tip("lasts", "Lasts")} <b>${Math.round(c.survival * 100)}%</b></span>
      ${adp}
    </div>`;
}

function renderRoster(s) {
  const list = el("roster");
  if (!s.roster.length) {
    list.innerHTML = `<li class="rempty">No picks yet</li>`;
  } else {
    list.innerHTML = s.roster
      .map(
        (p) => `<li>
          <span class="rpos">${escapeHtml(p.position)}</span>
          <span>${escapeHtml(p.name)}</span>
          <span class="rbye">${p.byeWeek ? `bye ${p.byeWeek}` : ""}</span>
        </li>`,
      )
      .join("");
  }

  el("needs").textContent = s.unfilledSlots.length
    ? `Still need: ${s.unfilledSlots.join(", ")}`
    : s.roster.length
      ? "All starting slots filled"
      : "";
}

function renderRecent(s) {
  el("recent").innerHTML = [...s.recentPicks]
    .reverse()
    .map(
      (p) => `<li class="${p.mine ? "mine" : ""}">
        <span class="rno">${p.pickNo}</span>
        <span>${escapeHtml(p.position)} ${escapeHtml(p.name)}</span>
      </li>`,
    )
    .join("");
}

function renderShortlist(s) {
  const body = document.querySelector("#shortlist tbody");
  body.innerHTML = s.candidates
    .map(
      (c) => `<tr>
        <td>${escapeHtml(c.name)}</td>
        <td>${escapeHtml(c.position)}</td>
        <td>${Math.round(c.vorp)}</td>
        <td>${Math.round(c.vona)}</td>
        <td>${Math.round(c.survival * 100)}%</td>
      </tr>`,
    )
    .join("");
}

function renderStatus(s) {
  const bits = [`${s.draftStatus}`, s.lastCallReason];
  if (s.lastUsage) {
    const u = s.lastUsage;
    bits.push(
      `${u.model} · ${u.cacheReadTokens} cached + ${u.inputTokens} fresh in, ` +
        `${u.outputTokens} out · $${u.estimatedCostUsd.toFixed(4)} · ${u.latencyMs}ms`,
    );
  }
  el("status").textContent = bits.filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const escapeAttr = escapeHtml;

connect();
