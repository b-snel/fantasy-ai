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

function connect() {
  const source = new EventSource(`/api/stream?id=${STREAM_ID}`);

  source.onmessage = (event) => {
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

  setInterval(sendHeartbeat, HEARTBEAT_MS);

  // Best-effort immediate cleanup. sendBeacon survives the page going away, which
  // fetch does not; the heartbeat timeout covers the cases where it does not fire
  // (a crash, a killed tab, a laptop lid).
  addEventListener("pagehide", () => {
    navigator.sendBeacon?.(`/api/bye?id=${STREAM_ID}`);
  });
}

async function sendHeartbeat() {
  try {
    await fetch(`/api/heartbeat?id=${STREAM_ID}`, { method: "POST" });
  } catch {
    // Server is down or restarting; EventSource will reconnect on its own.
  }
}

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

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(s) {
  if (s.status === "error") {
    el("turn").textContent = "Error";
    el("cards").innerHTML = `<p class="empty">${escapeHtml(s.error ?? "unknown error")}</p>`;
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

  el("alerts").innerHTML = alerts
    .map((a) => `<span class="alert ${a.cls}">${escapeHtml(a.text)}</span>`)
    .join("");
}

function renderCards(s) {
  const container = el("cards");
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

  const byId = new Map(s.candidates.map((c) => [c.playerId, c]));
  const topId = s.recommendation.top_pick_player_id;

  container.innerHTML = s.recommendation.cards
    .map((card) => renderCard(card, byId.get(card.player_id), card.player_id === topId))
    .join("");

  // Swap in the fallback image, then initials, without a server round-trip.
  for (const img of container.querySelectorAll("img.photo")) {
    img.addEventListener("error", onPhotoError);
  }
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

function renderStats(c) {
  const signed = (n) => (n > 0 ? `+${n}` : String(n));
  const cls = (n) => (n > 0 ? "pos-val" : n < 0 ? "neg-val" : "");
  const adp =
    c.adpDelta === null
      ? ""
      : `<span>ADP <b class="${cls(c.adpDelta)}">${signed(Math.round(c.adpDelta))}</b></span>`;

  return `
    <div class="stats">
      <span>Proj <b>${Math.round(c.projectedPoints)}</b></span>
      <span>VORP <b>${Math.round(c.vorp)}</b></span>
      <span>VONA <b class="${cls(c.vona)}">${signed(Math.round(c.vona))}</b></span>
      <span>Tier <b>${c.tier}</b> (${c.tierRemaining} left)</span>
      <span>Lasts <b>${Math.round(c.survival * 100)}%</b></span>
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
