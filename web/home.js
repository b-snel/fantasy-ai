/*
 * Home page: pick which draft the assistant follows.
 *
 * League drafts are discovered from Sleeper; mocks live in a local registry
 * (there is no Sleeper API that lists them). Opening a draft switches the
 * server's single session, then navigates to the draft room.
 */

const el = (id) => document.getElementById(id);

let countdownTimer = null;

async function load() {
  let data;
  try {
    const res = await fetch("/api/drafts");
    data = await res.json();
  } catch {
    el("upcoming").innerHTML = `<p class="err">Could not reach the server.</p>`;
    return;
  }

  const primary = data.leagueDrafts.filter((d) => d.isPrimaryLeague);
  const others = data.leagueDrafts.filter((d) => !d.isPrimaryLeague);

  el("upcoming").innerHTML = primary.length
    ? primary.map((d) => row(d, data.activeDraftId, true)).join("")
    : `<p class="empty">No draft found for your league.</p>`;

  el("mocks").innerHTML = data.mocks.length
    ? data.mocks.map((d) => row(d, data.activeDraftId, false)).join("")
    : `<p class="empty">None yet — start one from your league page on Sleeper, then paste its link below.</p>`;

  el("others").innerHTML = others.length
    ? others.map((d) => row(d, data.activeDraftId, false)).join("")
    : `<p class="empty">None.</p>`;

  startCountdown(primary[0]);
  wireButtons();
}

function row(d, activeDraftId, hero) {
  const active = d.draftId === activeDraftId;
  const meta = [
    d.teams && d.rounds ? `${d.teams} teams × ${d.rounds} rounds` : null,
    d.mySlot ? `you draft from slot ${d.mySlot}` : null,
    d.isMock && d.created ? `created ${timeAgo(d.created)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return `
    <div class="draftrow${hero ? " hero" : ""}${active ? " active" : ""}">
      <div class="draftrow-main">
        <div class="draftrow-name">
          ${escapeHtml(d.name)}
          ${d.isMock ? `<span class="badge flag">MOCK</span>` : ""}
          ${statusBadge(d.status)}
          ${active ? `<span class="badge topper">Following</span>` : ""}
        </div>
        <div class="muted">${escapeHtml(meta)}</div>
        ${hero ? `<div id="starts" class="starts"></div>` : ""}
      </div>
      <div class="draftrow-actions">
        <button class="open" data-id="${escapeAttr(d.draftId)}">
          ${active ? "Resume" : "Open"}
        </button>
        ${d.isMock ? `<button class="remove" data-id="${escapeAttr(d.draftId)}" title="Forget this mock">✕</button>` : ""}
      </div>
    </div>`;
}

function statusBadge(status) {
  const cls = status === "drafting" ? "live" : status === "complete" ? "done" : "pre";
  const label = status === "pre_draft" ? "not started" : status;
  return `<span class="badge st-${cls}">${escapeHtml(label)}</span>`;
}

/** Countdown to the real draft's scheduled start, refreshed every 30s. */
function startCountdown(primary) {
  if (countdownTimer) clearInterval(countdownTimer);
  const target = el("starts");
  if (!target || !primary) return;

  const tick = () => {
    if (primary.status === "drafting") {
      target.innerHTML = `<span class="live-now">LIVE — the draft is underway</span>`;
      return;
    }
    if (primary.status !== "pre_draft" || !primary.startTime) {
      target.textContent = "";
      return;
    }
    const ms = primary.startTime - Date.now();
    const when = new Date(primary.startTime).toLocaleString([], {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
    if (ms <= 0) {
      target.textContent = `Scheduled for ${when} — starting any moment`;
      return;
    }
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    target.textContent = `Starts ${when} — in ${h > 0 ? `${h}h ` : ""}${m}m`;
  };

  tick();
  countdownTimer = setInterval(tick, 30_000);
}

function wireButtons() {
  for (const btn of document.querySelectorAll("button.open")) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Opening…";
      try {
        const res = await fetch("/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ draftId: btn.dataset.id }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error ?? "switch failed");
        location.href = "/draft";
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Open";
        el("mockerr").textContent = String(err.message ?? err);
      }
    });
  }

  for (const btn of document.querySelectorAll("button.remove")) {
    btn.addEventListener("click", async () => {
      await fetch(`/api/drafts/${btn.dataset.id}`, { method: "DELETE" });
      void load();
    });
  }
}

el("addmock").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = el("mockinput");
  el("mockerr").textContent = "";
  if (!input.value.trim()) return;
  const res = await fetch("/api/drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft: input.value }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    el("mockerr").textContent = data.error ?? "Could not add that draft.";
    return;
  }
  input.value = "";
  void load();
});

function timeAgo(epochMs) {
  const mins = Math.max(1, Math.round((Date.now() - epochMs) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
const escapeAttr = escapeHtml;

void load();
