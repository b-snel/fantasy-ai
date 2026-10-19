/*
 * Trade analyzer client.
 *
 * Plain DOM, no build step, same as the draft room. The server does all of the
 * valuation; this page holds the query (partner, pins, package size, sort), sends
 * it, and renders what comes back. The query lives in the URL hash so a reload or
 * a shared link lands on the same search.
 */

const el = (id) => document.getElementById(id);

let overview = null;
let lastResult = null;
let searchSeq = 0;
let searchTimer = null;

const query = {
  partner: null,
  give: new Set(),
  get: new Set(),
  keep: new Set(),
  maxPerSide: 2,
  sort: "expected",
};

// ---------------------------------------------------------------------------
// Query <-> URL
// ---------------------------------------------------------------------------

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const list = (k) => new Set((params.get(k) ?? "").split(",").filter(Boolean));
  const partner = Number(params.get("partner"));
  query.partner = Number.isFinite(partner) && partner > 0 ? partner : null;
  query.give = list("give");
  query.get = list("get");
  query.keep = list("keep");
  const max = Number(params.get("max"));
  query.maxPerSide = [1, 2, 3].includes(max) ? max : 2;
  const sort = params.get("sort");
  query.sort = ["expected", "gain", "likely"].includes(sort) ? sort : "expected";
}

function writeHash() {
  const params = new URLSearchParams();
  if (query.partner) params.set("partner", String(query.partner));
  if (query.give.size) params.set("give", [...query.give].join(","));
  if (query.get.size) params.set("get", [...query.get].join(","));
  if (query.keep.size) params.set("keep", [...query.keep].join(","));
  if (query.maxPerSide !== 2) params.set("max", String(query.maxPerSide));
  if (query.sort !== "expected") params.set("sort", query.sort);
  const next = params.toString();
  history.replaceState(null, "", next ? `#${next}` : location.pathname);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadOverview(refresh = false) {
  try {
    const res = await fetch(`/api/trades${refresh ? "?refresh=1" : ""}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
    overview = data;
  } catch (err) {
    el("results").innerHTML = `<p class="err">Could not load the league: ${escapeHtml(err.message ?? err)}</p>`;
    el("leagueline").textContent = "unavailable";
    return false;
  }
  dropUnknownPins();
  renderOverview();
  return true;
}

/** Pins from an old link may name players who have since moved or been cut. */
function dropUnknownPins() {
  const me = myTeam();
  const mine = new Set(me.players.map((p) => p.playerId));
  const everyone = new Set(overview.teams.flatMap((t) => t.players.map((p) => p.playerId)));
  for (const id of [...query.give]) if (!mine.has(id)) query.give.delete(id);
  for (const id of [...query.keep]) if (!mine.has(id)) query.keep.delete(id);
  for (const id of [...query.get]) if (!everyone.has(id) || mine.has(id)) query.get.delete(id);
  if (query.partner && !overview.teams.some((t) => t.rosterId === query.partner && !t.isMe)) query.partner = null;
}

function scheduleSearch(delay = 150) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void search(), delay);
}

async function search() {
  if (!overview) return;
  writeHash();
  const seq = ++searchSeq;
  el("searchline").innerHTML = `<span class="thinking">Searching trades…</span>`;
  el("results").classList.add("stale");

  const body = {
    partner: query.partner,
    give: [...query.give],
    get: [...query.get],
    keep: [...query.keep],
    maxPerSide: query.maxPerSide,
    sort: query.sort,
  };

  let data;
  try {
    const res = await fetch("/api/trades/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
  } catch (err) {
    if (seq !== searchSeq) return;
    el("results").classList.remove("stale");
    el("searchline").textContent = "";
    el("proposal").innerHTML = "";
    el("results").innerHTML = `<p class="err">${escapeHtml(err.message ?? err)}</p>`;
    el("meta").textContent = "";
    return;
  }
  // A slower, older search must not overwrite a newer one.
  if (seq !== searchSeq) return;
  lastResult = data;
  el("results").classList.remove("stale");
  renderResults(data);
}

// ---------------------------------------------------------------------------
// Overview: header, controls, rosters, league table
// ---------------------------------------------------------------------------

const myTeam = () => overview.teams.find((t) => t.isMe);
const teamById = (id) => overview.teams.find((t) => t.rosterId === id);

/** The team whose roster the side panel shows: the selected partner, or a pinned target's. */
function focusTeam() {
  if (query.partner) return teamById(query.partner);
  const target = [...query.get][0];
  if (target) return overview.teams.find((t) => t.players.some((p) => p.playerId === target));
  return null;
}

function renderOverview() {
  const { league } = overview;
  const first = league.weeks[0];
  const last = league.weeks.at(-1);
  el("leagueline").textContent =
    `${league.name} · NFL week ${league.nflWeek} · valuing weeks ${first}–${last}`;

  renderAlerts();
  renderControls();
  renderMyTeam();
  renderTheirTeam();
  renderLeagueTable();
}

function renderAlerts() {
  const { league } = overview;
  const alerts = [];
  if (league.deadlinePassed) {
    alerts.push({ cls: "warn", text: `The trade deadline (week ${league.tradeDeadline}) has passed` });
  } else if (league.tradeDeadline) {
    const left = league.tradeDeadline - league.nflWeek;
    alerts.push({
      cls: left <= 1 ? "run" : "tier",
      text: `Trade deadline: week ${league.tradeDeadline}${left > 0 ? ` — ${left} week${left > 1 ? "s" : ""} left` : " — this week"}`,
    });
  }
  if (overview.source === "season_fallback") {
    alerts.push({ cls: "warn", text: "Weekly projections unavailable — using season totals, so injury timing is missing" });
  }
  el("alerts").innerHTML = alerts.map((a) => `<span class="alert ${a.cls}">${escapeHtml(a.text)}</span>`).join("");
}

function renderControls() {
  const select = el("partner");
  const others = overview.teams.filter((t) => !t.isMe).sort((a, b) => a.teamName.localeCompare(b.teamName));
  select.innerHTML =
    `<option value="">All teams</option>` +
    others
      .map((t) => {
        const need = t.needs.length ? ` · needs ${t.needs.join(", ")}` : "";
        return `<option value="${t.rosterId}">${escapeHtml(t.teamName)} (${escapeHtml(t.record)})${escapeHtml(need)}</option>`;
      })
      .join("");
  // A pinned target fixes the partner; the select reflects it but cannot fight it.
  const focus = focusTeam();
  select.value = focus && !focus.isMe ? String(focus.rosterId) : "";
  select.disabled = query.get.size > 0;
  select.title = query.get.size ? "Set by the player you want - clear that pin to change teams" : "";

  for (const b of el("maxseg").querySelectorAll("button")) {
    b.classList.toggle("on", Number(b.dataset.max) === query.maxPerSide);
  }
  for (const b of el("sortseg").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.sort === query.sort);
  }
  renderPins();
}

function renderPins() {
  const name = (id) => {
    for (const t of overview.teams) {
      const p = t.players.find((x) => x.playerId === id);
      if (p) return `${p.position} ${p.name}`;
    }
    return id;
  };
  const chip = (kind, id, label) =>
    `<span class="pin pin-${kind}">${label} <b>${escapeHtml(name(id))}</b>` +
    `<button type="button" class="pin-x" data-kind="${kind}" data-id="${escapeAttr(id)}" aria-label="Remove">✕</button></span>`;
  const chips = [
    ...[...query.give].map((id) => chip("give", id, "Offer")),
    ...[...query.get].map((id) => chip("get", id, "Want")),
    ...[...query.keep].map((id) => chip("keep", id, "Keep")),
  ];
  el("pins").innerHTML = chips.length
    ? chips.join("") + `<button type="button" class="linkbtn" id="clearpins">Clear all</button>`
    : "";
}

function teamSummary(t) {
  const ranks = overview.positions
    .map((pos) => {
      const r = t.positions[pos]?.rank ?? 0;
      return `<span class="rk ${rankClass(r)}" title="${escapeAttr(`${pos}: ${(t.positions[pos]?.perWeek ?? 0).toFixed(1)} pts/wk from starters, ${ordinal(r)} of ${overview.league.teams}`)}">${pos} ${ordinal(r)}</span>`;
    })
    .join("");
  const tags = [
    t.needs.length ? `<span class="need">Needs ${escapeHtml(t.needs.join(", "))}</span>` : "",
    t.surplus.length ? `<span class="surplus">Surplus ${escapeHtml(t.surplus.join(", "))}</span>` : "",
  ].join("");
  return `
    <div class="teamline">
      ${t.avatar ? `<img class="avatar" src="${escapeAttr(t.avatar)}" alt="" />` : ""}
      <div>
        <div class="teamname">${escapeHtml(t.teamName)}</div>
        <div class="muted small">${escapeHtml(t.manager)} · ${escapeHtml(t.record)} · ${t.perWeek.toFixed(1)} pts/wk projected (${ordinal(t.rank)})</div>
      </div>
    </div>
    <div class="ranks">${ranks}</div>
    ${tags ? `<div class="tags">${tags}</div>` : ""}`;
}

function rosterRows(t, mine) {
  return t.players
    .map((p) => {
      const role = p.startShare >= 0.5 ? "start" : "bench";
      const injury = [p.reserve ? "IR" : "", p.injuryStatus && p.injuryStatus !== "IR" ? p.injuryStatus : ""].filter(Boolean).join(" ");
      let actions;
      if (mine) {
        const offered = query.give.has(p.playerId);
        const kept = query.keep.has(p.playerId);
        actions =
          `<button type="button" class="tog${offered ? " on give" : ""}" data-act="give" data-id="${escapeAttr(p.playerId)}" title="Must be in the trade">Offer</button>` +
          `<button type="button" class="tog${kept ? " on keep" : ""}" data-act="keep" data-id="${escapeAttr(p.playerId)}" title="Never trade">Keep</button>`;
      } else {
        const wanted = query.get.has(p.playerId);
        actions = `<button type="button" class="tog${wanted ? " on get" : ""}" data-act="get" data-id="${escapeAttr(p.playerId)}" title="Must be in the trade">Want</button>`;
      }
      const spark = sparkline(p.weekly, overview.league.weeks);
      return `<li class="${role}">
        <span class="rpos">${escapeHtml(p.position)}</span>
        <span class="rname" title="${escapeAttr(`${p.name}${p.team ? `, ${p.team}` : ""} — starts ${Math.round(p.startShare * 100)}% of remaining weeks`)}">${escapeHtml(p.name)}${injury ? ` <span class="badge injury">${escapeHtml(injury)}</span>` : ""}</span>
        ${spark}
        <span class="rval">${p.perWeek.toFixed(1)}</span>
        <span class="racts">${actions}</span>
      </li>`;
    })
    .join("");
}

function renderMyTeam() {
  const t = myTeam();
  el("mytitle").textContent = "Your team";
  el("mysummary").innerHTML = teamSummary(t);
  el("myroster").innerHTML = rosterHeader() + rosterRows(t, true);
}

function renderTheirTeam() {
  const t = focusTeam();
  const panel = el("theirpanel");
  if (!t || t.isMe) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  el("theirtitle").textContent = "Their team";
  el("theirsummary").innerHTML = teamSummary(t);
  el("theirroster").innerHTML = rosterHeader() + rosterRows(t, false);
}

function rosterHeader() {
  return `<li class="rhead"><span class="rpos"></span><span class="rname"></span>
    <span class="spark-h tip" data-tip="Projected points each remaining week. Gaps are byes or injury absences.">by week</span>
    <span class="rval tip tip-r" data-tip="Rest-of-season projected points per week, this league's scoring.">pts/wk</span><span class="racts"></span></li>`;
}

function renderLeagueTable() {
  const head =
    `<tr><th>Team</th>${overview.positions.map((p) => `<th>${p}</th>`).join("")}<th class="tip tip-r" data-tip="Projected lineup points per week, rest of season">/wk</th></tr>`;
  const rows = [...overview.teams]
    .sort((a, b) => a.rank - b.rank)
    .map((t) => {
      const cells = overview.positions
        .map((pos) => {
          const r = t.positions[pos]?.rank ?? 0;
          return `<td class="rk ${rankClass(r)}">${r}</td>`;
        })
        .join("");
      const selected = query.partner === t.rosterId;
      return `<tr class="${t.isMe ? "me" : "pickable"}${selected ? " selected" : ""}" data-team="${t.rosterId}" title="${escapeAttr(`${t.teamName} — ${t.manager}, ${t.record}`)}">
        <td class="tname">${escapeHtml(t.teamName)}</td>${cells}<td>${t.perWeek.toFixed(1)}</td></tr>`;
    })
    .join("");
  el("leaguetable").innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
}

/** Bottom third of the league is a need, top quarter a strength. */
function rankClass(rank) {
  const n = overview.league.teams;
  if (rank > n - Math.round(n / 3)) return "rk-bad";
  if (rank <= Math.round(n / 4)) return "rk-good";
  return "";
}

function sparkline(values, weeks) {
  const max = Math.max(1, ...values);
  const w = 4;
  const gap = 1;
  const h = 18;
  const bars = values
    .map((v, i) => {
      const bh = v > 0 ? Math.max(2, Math.round((v / max) * h)) : 0;
      return `<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="1"><title>Week ${weeks[i]}: ${v.toFixed(1)}</title></rect>`;
    })
    .join("");
  const width = values.length * (w + gap) - gap;
  return `<svg class="spark" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" aria-hidden="true">${bars}</svg>`;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function renderResults(data) {
  const scope = data.partners.length === 1 ? `with ${teamById(data.partners[0])?.teamName ?? "one team"}` : "across the league";
  const n = data.trades.length;
  // With no results the server's note says why, so the headline stays quiet.
  el("searchline").textContent = n
    ? `${n} trade${n > 1 ? "s" : ""} ${scope} that help you and give them a reason to say yes`
    : "";

  el("proposal").innerHTML = data.proposal ? renderTrade(data.proposal, { proposal: true }) : "";

  const notes = data.notes.map((nt) => `<p class="empty">${escapeHtml(nt)}</p>`).join("");
  el("results").innerHTML = n ? data.trades.map((t) => renderTrade(t, {})).join("") + notes : notes;

  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
  el("meta").textContent =
    `${plural(data.considered, "package pair")} considered · ` +
    `${data.evaluated.toLocaleString()} valued on both rosters · ${data.elapsedMs} ms · ` +
    `up to ${data.maxPerSide} per side`;

  for (const img of document.querySelectorAll("img.mini")) img.addEventListener("error", onPhotoError);
}

function acceptanceLabel(a) {
  if (a >= 0.65) return { text: "Likely", cls: "acc-hi" };
  if (a >= 0.4) return { text: "Toss-up", cls: "acc-mid" };
  return { text: "Long shot", cls: "acc-lo" };
}

function renderTrade(t, opts) {
  const signed = (v) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)}`;
  const cls = (v) => (v > 0.05 ? "pos-val" : v < -0.05 ? "neg-val" : "");
  const acc = acceptanceLabel(t.acceptance);
  const partner = teamById(t.partner.rosterId);

  const badges = [];
  if (opts.proposal) badges.push(`<span class="badge topper">Your proposal</span>`);
  if (t.label === "win-win") badges.push(`<span class="badge flag">Win-win</span>`);
  else if (t.label === "fair") badges.push(`<span class="badge">Fair</span>`);
  else badges.push(`<span class="badge injury">Doesn't clear the bar</span>`);
  badges.push(
    `<span class="badge ${acc.cls} tip tip-r" data-tip="A rough read, not a calibrated probability: it rises with how much the trade helps their lineup and how good it looks for them on paper.">${acc.text} ~${Math.round(t.acceptance * 100)}%</span>`,
  );

  const side = (players, label) => `
    <div class="tside">
      <div class="tside-h">${label}</div>
      ${players
        .map(
          (p) => `<div class="tplayer">
            ${miniPhoto(p.playerId)}
            <span class="badge pos">${escapeHtml(p.position)}</span>
            <span class="tpname">${escapeHtml(p.name)}</span>
            ${p.injuryStatus ? `<span class="badge injury">${escapeHtml(p.injuryStatus)}</span>` : ""}
            <span class="tpval">${p.perWeek.toFixed(1)}<span class="muted">/wk</span></span>
          </div>`,
        )
        .join("")}
    </div>`;

  const deltas = Object.entries(t.myPositionDelta)
    .filter(([, d]) => Math.abs(d) >= 0.3)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([pos, d]) => `<span class="delta ${cls(d)}">${pos} ${signed(d)}</span>`)
    .join("");

  const problems = t.problems.length
    ? `<ul class="problems">${t.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`
    : "";

  // forMe[0] is the headline number, already shown in the score row.
  const forMe = t.forMe.slice(1);

  return `
    <article class="card trade${opts.proposal ? " proposal" : ""}${t.passes ? "" : " failing"}" data-key="${escapeAttr(t.key)}">
      <div class="trade-head">
        ${partner?.avatar ? `<img class="avatar" src="${escapeAttr(partner.avatar)}" alt="" />` : ""}
        <div class="trade-who">
          <span class="name">${escapeHtml(t.partner.teamName)}</span>
          <span class="muted small">${escapeHtml(t.partner.manager)}${partner ? ` · ${escapeHtml(partner.record)}` : ""}${partner?.needs.length ? ` · needs ${escapeHtml(partner.needs.join(", "))}` : ""}</span>
        </div>
        <div class="trade-badges">${badges.join("")}</div>
      </div>

      <div class="tsides">
        ${side(t.give, "You give")}
        <div class="tarrow" aria-hidden="true">⇄</div>
        ${side(t.get, "You get")}
      </div>

      <div class="tscore">
        <span><span class="tip tip-l" data-tip="Change in your best lineup's projected points per week, rest of season.">You</span> <b class="${cls(t.myGain)}">${signed(t.myGain)}</b><span class="muted">/wk</span></span>
        <span><span class="tip" data-tip="Change in their best lineup's projected points per week. Near zero or better means the trade does not hurt them.">Them</span> <b class="${cls(t.theirGain)}">${signed(t.theirGain)}</b><span class="muted">/wk</span></span>
        <span><span class="tip" data-tip="Rest-of-season value they receive as a share of what they send, with a premium for the best player in a package. Under 90% reads as a fleecing and gets declined.">On paper</span> <b>${Math.round(t.marketRatio * 100)}%</b> <span class="muted">for them</span></span>
        ${weeklyBars(t.weeklyDelta)}
      </div>
      ${deltas ? `<div class="deltas"><span class="muted small">Your lineup by position</span> ${deltas}</div>` : ""}
      ${problems}

      <div class="whys">
        <div>
          <div class="why-h">${t.passes ? "Why it works for you" : "What it does for you"}</div>
          <ul class="rationale">${forMe.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
        </div>
        <div>
          <div class="why-h">${t.passes ? "Why they'd say yes" : "What it does for them"}</div>
          <ul class="rationale">${t.forThem.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
        </div>
      </div>

      <div class="tactions">
        <button type="button" data-copy="${escapeAttr(t.key)}">Copy pitch</button>
        ${opts.proposal ? "" : `<button type="button" data-explore="${escapeAttr(t.key)}" title="Pin these players and search around this deal">Explore this deal</button>`}
        ${t.alternatives ? `<span class="muted small">${t.alternatives} similar variation${t.alternatives > 1 ? "s" : ""}</span>` : ""}
      </div>
      <p class="pitch muted small" hidden></p>
    </article>`;
}

/** Your week-by-week change, as tiny diverging bars: when does this trade help? */
function weeklyBars(deltas) {
  if (!deltas?.length) return "";
  const weeks = overview.league.weeks;
  const max = Math.max(1, ...deltas.map((d) => Math.abs(d)));
  const w = 6;
  const gap = 2;
  const h = 26;
  const mid = h / 2;
  const bars = deltas
    .map((d, i) => {
      const bh = Math.max(d === 0 ? 0 : 1, Math.round((Math.abs(d) / max) * (mid - 1)));
      const y = d >= 0 ? mid - bh : mid;
      return `<rect class="${d >= 0 ? "up" : "down"}" x="${i * (w + gap)}" y="${y}" width="${w}" height="${bh}" rx="1"><title>Week ${weeks[i]}: ${d > 0 ? "+" : ""}${d.toFixed(1)}</title></rect>`;
    })
    .join("");
  const width = deltas.length * (w + gap) - gap;
  return `<span class="wk tip tip-r" data-tip="Your projected gain or loss each remaining week. Tall green bars in one week usually mean the trade covers a bye or an injury.">
    <svg class="wkbars" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" aria-hidden="true">
      <line x1="0" x2="${width}" y1="${mid}" y2="${mid}" />${bars}
    </svg></span>`;
}

function miniPhoto(id) {
  for (const t of overview.teams) {
    const p = t.players.find((x) => x.playerId === id);
    if (p) {
      return `<img class="mini" src="${escapeAttr(p.photo)}" alt="" data-fallback="${escapeAttr(p.photoFallback ?? "")}" data-initials="${escapeAttr(p.initials)}" />`;
    }
  }
  return `<span class="mini mini-fallback">?</span>`;
}

function onPhotoError(event) {
  const img = event.currentTarget;
  const fallback = img.dataset.fallback;
  if (fallback && img.src !== fallback) {
    img.src = fallback;
    return;
  }
  const span = document.createElement("span");
  span.className = "mini mini-fallback";
  span.textContent = img.dataset.initials ?? "?";
  img.replaceWith(span);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

el("partner").addEventListener("change", (e) => {
  const v = e.currentTarget.value;
  query.partner = v ? Number(v) : null;
  renderOverview();
  scheduleSearch(0);
});

el("maxseg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-max]");
  if (!b) return;
  query.maxPerSide = Number(b.dataset.max);
  renderControls();
  scheduleSearch(0);
});

el("sortseg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sort]");
  if (!b) return;
  query.sort = b.dataset.sort;
  renderControls();
  scheduleSearch(0);
});

document.addEventListener("click", async (e) => {
  const tog = e.target.closest("button.tog");
  if (tog) {
    togglePin(tog.dataset.act, tog.dataset.id);
    return;
  }

  const x = e.target.closest("button.pin-x");
  if (x) {
    query[x.dataset.kind].delete(x.dataset.id);
    renderOverview();
    scheduleSearch();
    return;
  }

  if (e.target.closest("#clearpins")) {
    query.give.clear();
    query.get.clear();
    query.keep.clear();
    renderOverview();
    scheduleSearch(0);
    return;
  }

  const row = e.target.closest("#leaguetable tr.pickable");
  if (row) {
    const id = Number(row.dataset.team);
    if (query.get.size) query.get.clear();
    query.partner = query.partner === id ? null : id;
    renderOverview();
    scheduleSearch(0);
    return;
  }

  const copy = e.target.closest("button[data-copy]");
  if (copy) {
    const trade = findTrade(copy.dataset.copy);
    if (!trade) return;
    const card = copy.closest("article");
    const out = card.querySelector(".pitch");
    out.hidden = false;
    out.textContent = trade.pitch;
    try {
      await navigator.clipboard.writeText(trade.pitch);
      copy.textContent = "Copied ✓";
    } catch {
      copy.textContent = "Select and copy below";
    }
    setTimeout(() => (copy.textContent = "Copy pitch"), 2000);
    return;
  }

  const explore = e.target.closest("button[data-explore]");
  if (explore) {
    const trade = findTrade(explore.dataset.explore);
    if (!trade) return;
    // Pin the headline piece each way, not the whole package: the search then
    // shows the straight swap as a proposal plus every sweetener that works.
    const headline = (players) =>
      [...players].sort((a, b) => playerValue(b.playerId) - playerValue(a.playerId))[0].playerId;
    query.partner = trade.partner.rosterId;
    query.give = new Set([headline(trade.give)]);
    query.get = new Set([headline(trade.get)]);
    for (const id of query.give) query.keep.delete(id);
    query.maxPerSide = Math.max(query.maxPerSide, trade.give.length, trade.get.length, 2);
    renderOverview();
    scrollTo({ top: 0, behavior: "smooth" });
    scheduleSearch(0);
  }
});

function playerValue(id) {
  for (const t of overview.teams) {
    const p = t.players.find((x) => x.playerId === id);
    if (p) return p.marketValue;
  }
  return 0;
}

function findTrade(key) {
  if (!lastResult) return null;
  if (lastResult.proposal?.key === key) return lastResult.proposal;
  return lastResult.trades.find((t) => t.key === key) ?? null;
}

function togglePin(act, id) {
  if (act === "give") {
    if (query.give.has(id)) query.give.delete(id);
    else {
      query.give.add(id);
      query.keep.delete(id);
    }
  } else if (act === "keep") {
    if (query.keep.has(id)) query.keep.delete(id);
    else {
      query.keep.add(id);
      query.give.delete(id);
    }
  } else if (act === "get") {
    if (query.get.has(id)) query.get.delete(id);
    else {
      // Wanted players must all come from one team: switching teams starts over.
      const owner = overview.teams.find((t) => t.players.some((p) => p.playerId === id));
      const current = [...query.get][0];
      const currentOwner = current && overview.teams.find((t) => t.players.some((p) => p.playerId === current));
      if (currentOwner && owner && currentOwner.rosterId !== owner.rosterId) query.get.clear();
      query.get.add(id);
      if (owner) query.partner = owner.rosterId;
    }
  }
  renderOverview();
  scheduleSearch();
}

el("reload").addEventListener("click", async () => {
  const b = el("reload");
  b.disabled = true;
  b.textContent = "Refreshing…";
  try {
    if (await loadOverview(true)) await search();
  } finally {
    b.disabled = false;
    b.textContent = "Refresh data";
  }
});

// ---------------------------------------------------------------------------

function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const escapeAttr = escapeHtml;

readHash();
loadOverview().then((ok) => {
  if (ok) void search();
});
