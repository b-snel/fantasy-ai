/*
 * Waiver wire client.
 *
 * Plain DOM, no build step, modelled on the trade analyzer page. The server does
 * all of the valuation - lineups, the plan, streams, bids; this page holds the
 * query (horizon, positions, pins), sends it, and renders what comes back. The
 * query lives in the URL hash so a reload or a shared link lands on the same
 * search.
 *
 * Every string from the server goes through escapeHtml before it reaches
 * innerHTML. That is not just hygiene: news notes, verdict reasons and the news
 * summary are model output written from web search results, so they are
 * untrusted text.
 */

const el = (id) => document.getElementById(id);

let overview = null;
let lastResult = null;
let searchSeq = 0;
let searchTimer = null;
/** Set by Pin: bring the proposal into view once the search that answers it lands. */
let revealProposal = false;

/** Every player card seen so far, by id: names for pins whose card is not on screen. */
const cards = new Map();

/** The news job as the server last reported it, and the timers that follow it. */
let newsJob = null;
let newsError = null;
let newsPoll = null;
let newsTick = null;
/** True while this page is polling a running job. */
let newsFollowing = false;
let newsSince = 0;
let newsMisses = 0;

const HORIZONS = ["auto", "week", "season", "playoffs"];
const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];
/** Every lineup has these; K and DEF only count when the roster carries one. */
const CORE_POSITIONS = ["QB", "RB", "WR", "TE"];
const NEWS_POLL_MS = 2000;
/** Consecutive failed status polls before the page stops following the job. */
const NEWS_MAX_MISSES = 5;

const query = {
  horizon: "auto",
  positions: new Set(),
  keep: new Set(),
  add: null,
  drop: null,
};

// ---------------------------------------------------------------------------
// Query <-> URL
// ---------------------------------------------------------------------------

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const list = (k) => new Set((params.get(k) ?? "").split(",").filter(Boolean));
  const horizon = params.get("horizon");
  query.horizon = HORIZONS.includes(horizon) ? horizon : "auto";
  query.positions = new Set([...list("pos")].filter((p) => POSITION_ORDER.includes(p)));
  query.keep = list("keep");
  query.add = params.get("add") || null;
  query.drop = params.get("drop") || null;
}

function writeHash() {
  const params = new URLSearchParams();
  if (query.horizon !== "auto") params.set("horizon", query.horizon);
  if (query.positions.size) params.set("pos", [...query.positions].join(","));
  if (query.keep.size) params.set("keep", [...query.keep].join(","));
  if (query.add) params.set("add", query.add);
  if (query.drop) params.set("drop", query.drop);
  const next = params.toString();
  history.replaceState(null, "", next ? `#${next}` : location.pathname);
}

/** The query as the server's WaiverRequest - the news check uses it too. */
function requestBody() {
  return {
    horizon: query.horizon,
    positions: [...query.positions],
    keep: [...query.keep],
    add: query.add,
    drop: query.drop,
  };
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadOverview(refresh = false) {
  try {
    const res = await fetch(`/api/waivers${refresh ? "?refresh=1" : ""}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
    overview = data;
  } catch (err) {
    el("results").innerHTML = `<p class="err">Could not load the league: ${escapeHtml(err.message ?? err)}</p>`;
    el("plan").innerHTML = "";
    el("streams").innerHTML = "";
    el("leagueline").textContent = "unavailable";
    return false;
  }
  for (const p of overview.team.players) remember(p);
  for (const c of overview.cuts) remember(c.player);
  dropUnknownPins();
  renderOverview();
  return true;
}

/** Pins from an old link may name players who have since been cut or claimed. */
function dropUnknownPins() {
  const mine = new Set(overview.team.players.map((p) => p.playerId));
  for (const id of [...query.keep]) if (!mine.has(id)) query.keep.delete(id);
  if (query.drop && !mine.has(query.drop)) query.drop = null;
  // A pinned add who is now yours is not a free agent any more. Anyone else is
  // left for the server to judge - it says so when he has been claimed.
  if (query.add && mine.has(query.add)) query.add = null;
  const positions = leaguePositions();
  for (const p of [...query.positions]) if (!positions.includes(p)) query.positions.delete(p);
}

function scheduleSearch(delay = 150) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void search(), delay);
}

async function search() {
  if (!overview) return;
  writeHash();
  const seq = ++searchSeq;
  el("searchline").innerHTML = `<span class="thinking">Searching the wire…</span>`;
  el("analysis").classList.add("stale");

  let data;
  try {
    const res = await fetch("/api/waivers/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody()),
    });
    data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
  } catch (err) {
    if (seq !== searchSeq) return;
    el("analysis").classList.remove("stale");
    el("searchline").textContent = "";
    el("plan").innerHTML = "";
    el("streams").innerHTML = "";
    el("proposal").innerHTML = "";
    el("results").innerHTML = `<p class="err">${escapeHtml(err.message ?? err)}</p>`;
    el("meta").textContent = "";
    revealProposal = false;
    return;
  }
  // A slower, older search must not overwrite a newer one.
  if (seq !== searchSeq) return;
  lastResult = data;
  el("analysis").classList.remove("stale");
  renderAnalysis(data);
}

function remember(card) {
  if (card?.playerId) cards.set(card.playerId, card);
}

function rememberMove(m) {
  remember(m.add);
  remember(m.drop);
  remember(m.irMove);
  for (const o of m.dropOptions) remember(o.player);
}

/**
 * Positions worth filtering by. The overview carries no roster slots, so this
 * reads them off your roster: the four every lineup has, plus K and DEF when you
 * roster one (a league without a kicker slot shows no K button).
 */
/** Positions the league's lineup slots can use (older servers: guess from your roster). */
function leaguePositions() {
  if (overview.league.positions?.length) return overview.league.positions;
  const have = new Set(overview.team.players.map((p) => p.position));
  return POSITION_ORDER.filter((p) => CORE_POSITIONS.includes(p) || have.has(p));
}

// ---------------------------------------------------------------------------
// Overview: header, alerts, controls, side panels
// ---------------------------------------------------------------------------

function renderOverview() {
  const { league, team } = overview;
  const parts = [league.name, `NFL week ${league.nflWeek}`, `next waivers ${league.nextRunLabel}`];
  if (league.faab && team.faabLeft != null) parts.push(`FAAB $${team.faabLeft} / $${league.budget}`);
  if (team.priority != null) parts.push(`priority #${team.priority}`);
  el("leagueline").textContent = parts.join(" · ");

  renderAlerts();
  renderControls();
  renderMyTeam();
  renderLeverage();
  renderLeagueTable();
  renderMarket();
  renderNews();
}

function renderAlerts() {
  el("alerts").innerHTML = overview.alerts
    .map((a) => `<span class="alert ${escapeAttr(a.cls)}">${escapeHtml(a.text)}</span>`)
    .join("");
}

function renderControls() {
  for (const b of el("horizonseg").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.horizon === query.horizon);
  }
  const positions = leaguePositions();
  el("posseg").innerHTML =
    `<button type="button" data-pos="" class="${query.positions.size ? "" : "on"}" title="Search every position">All</button>` +
    positions
      .map((p) => `<button type="button" data-pos="${p}" class="${query.positions.has(p) ? "on" : ""}">${p}</button>`)
      .join("");
  renderPins();
}

function renderPins() {
  const name = (id) => {
    const c = cards.get(id);
    return c ? `${c.position} ${c.name}` : id;
  };
  const chip = (kind, cls, id, label) =>
    `<span class="pin ${cls}">${label} <b>${escapeHtml(name(id))}</b>` +
    `<button type="button" class="pin-x" data-kind="${kind}" data-id="${escapeAttr(id)}" aria-label="Remove">✕</button></span>`;
  const chips = [
    query.add ? chip("add", "pin-get", query.add, "Add") : "",
    query.drop ? chip("drop", "pin-give", query.drop, "Cut") : "",
    ...[...query.keep].map((id) => chip("keep", "pin-keep", id, "Keep")),
  ].filter(Boolean);
  el("pins").innerHTML = chips.length
    ? chips.join("") + `<button type="button" class="linkbtn" id="clearpins">Clear all</button>`
    : "";
}

function renderMyTeam() {
  const { team, league } = overview;
  const me = overview.league_table.find((t) => t.isMe);
  const chips = [
    `<span class="rk ${oddsClass(team.playoffOdds)}" title="Share of simulated seasons in which you make the playoffs">Playoffs ${pct(team.playoffOdds)}</span>`,
    `<span class="rk" title="Share of simulated seasons in which you win the title">Title ${pct(team.titleOdds)}</span>`,
    league.faab && team.faabLeft != null
      ? `<span class="rk" title="FAAB left of the season budget">$${team.faabLeft} of $${league.budget} FAAB</span>`
      : "",
    team.priority != null
      ? `<span class="rk" title="Waiver priority - the tiebreak on equal bids (1 goes first)">Priority #${team.priority}</span>`
      : "",
  ].join("");
  el("mysummary").innerHTML = `
    <div class="teamline">
      ${me?.avatar ? `<img class="avatar" src="${escapeAttr(me.avatar)}" alt="" />` : ""}
      <div>
        <div class="teamname">${escapeHtml(team.teamName)}</div>
        <div class="muted small">${escapeHtml(team.manager)} · ${escapeHtml(team.record)} · ${team.perWeek.toFixed(1)} pts/wk with no moves</div>
      </div>
    </div>
    <div class="ranks">${chips}</div>`;
  el("myroster").innerHTML = rosterHeader() + team.players.map(rosterRow).join("");
}

function rosterHeader() {
  const sparkWidth = Math.max(1, overview.league.weeks.length * 5 - 1);
  return `<li class="rhead"><span class="rpos"></span><span class="rname"></span>
    <span class="spark-h tip" style="width:${sparkWidth}px" data-tip="Projected points each remaining week. Gaps are byes or injury absences.">by week</span>
    <span class="rval tip tip-r" data-tip="Rest-of-season projected points per week, this league's scoring.">pts/wk</span>
    <span class="rcut tip tip-r" data-tip="What cutting him costs your lineup, in weighted points per week. Green is dead weight - a free cut.">cut</span>
    <span class="racts"></span></li>`;
}

/** Roster rows are narrow: the full status is in the badge's tooltip. */
const INJURY_SHORT = { Questionable: "Q", Doubtful: "D", Probable: "P", Suspended: "SUS", Sus: "SUS" };

function rosterRow(p) {
  const kept = query.keep.has(p.playerId);
  const cutting = query.drop === p.playerId;
  const role = p.reserve ? "bench ir" : p.starting ? "start" : "bench";
  const flags = [
    p.reserve ? `<span class="badge injury">IR</span>` : "",
    p.injuryStatus && !(p.reserve && p.injuryStatus === "IR")
      ? `<span class="badge injury" title="${escapeAttr(p.injuryStatus)}">${escapeHtml(INJURY_SHORT[p.injuryStatus] ?? p.injuryStatus)}</span>`
      : "",
    p.locked ? `<span class="badge lockb" title="His game has started - he cannot be dropped or moved until the next run">Locked</span>` : "",
  ].join("");
  const note = newsNote(p.playerId);
  const noteFlag = note
    ? ` <span class="outlook ${OUTLOOK[note.outlook]?.cls ?? ""}" title="${escapeAttr(`News: ${note.note}`)}">${OUTLOOK[note.outlook]?.sym ?? "•"}</span>`
    : "";
  const title = `${p.name}${p.team ? `, ${p.team}` : ""} - starts ${p.starts} of ${overview.league.weeks.length} remaining weeks in your best lineup${p.starting ? "; in your saved lineup this week" : ""}`;
  const cutTitle = p.cutCost < 0.1 ? "Dead weight: cutting him costs your lineup nothing" : `Cut costs ${p.cutCost.toFixed(1)}/wk`;
  return `<li class="${role}">
    <span class="rpos">${escapeHtml(p.position)}</span>
    <span class="rname" title="${escapeAttr(title)}"><span class="rnm">${escapeHtml(p.name)}</span>${flags}${noteFlag}</span>
    ${sparkline(p.weekly, overview.league.weeks)}
    <span class="rval">${p.perWeek.toFixed(1)}</span>
    <span class="rcut${p.cutCost < 0.1 ? " free" : ""}" title="${escapeAttr(cutTitle)}">${p.cutCost.toFixed(1)}</span>
    <span class="racts">
      <button type="button" class="tog${kept ? " on keep" : ""}" data-act="keep" data-id="${escapeAttr(p.playerId)}" title="Never cut him">Keep</button>
      <button type="button" class="tog${cutting ? " on give" : ""}" data-act="cut" data-id="${escapeAttr(p.playerId)}"${p.locked && !cutting ? ` disabled title="Locked - his game has started"` : ` title="Find the best add that replaces him"`}>Cut</button>
    </span>
  </li>`;
}

function renderLeverage() {
  const { weights, alive, margins, note } = overview.leverage;
  const { weeks, playoffWeekStart } = overview.league;
  const max = Math.max(1, ...weights);
  const bw = 18;
  const gap = 6;
  const h = 64;
  const width = weeks.length * (bw + gap) - gap;
  const scale = (v) => Math.round((v / max) * (h - 2));
  const bars = weights
    .map((w, i) => {
      const week = weeks[i];
      const playoff = playoffWeekStart != null && week >= playoffWeekStart;
      const bh = Math.max(1, scale(w));
      const x = i * (bw + gap);
      const margin = margins[i];
      const tip =
        `Week ${week}${playoff ? " (playoffs)" : ""}: a point is worth ${w.toFixed(2)}x an average week` +
        ` · your game counts in ${pct(alive[i] ?? 0)} of seasons` +
        (margin != null ? ` · projected margin ${signed(margin)}` : "");
      return `<g><title>${escapeHtml(tip)}</title>
        <rect class="${playoff ? "po" : ""}" x="${x}" y="${h - bh}" width="${bw}" height="${bh}" rx="2" />
        <text x="${x + bw / 2}" y="${h + 12}" text-anchor="middle">${week}</text></g>`;
    })
    .join("");
  const avg = h - scale(1);
  el("leverage").innerHTML = `
    <svg viewBox="0 0 ${width} ${h + 16}" width="${width}" height="${h + 16}" role="img" aria-label="Week weights">
      <line class="avg" x1="0" x2="${width}" y1="${avg}" y2="${avg}"><title>An average week</title></line>
      ${bars}
    </svg>`;
  el("levnote").textContent = note;
}

function renderLeagueTable() {
  const { league } = overview;
  const head =
    `<tr><th>Team</th><th>Rec</th>` +
    (league.faab ? `<th class="tip" data-tip="FAAB left">FAAB</th>` : "") +
    `<th class="tip" data-tip="Waiver priority - the tiebreak on equal bids">Pri</th>` +
    `<th class="tip" data-tip="Playoff odds from the season simulation">PO</th>` +
    `<th class="tip tip-r" data-tip="Lineup holes this week and next - a rival with a hole at a position is a rival bidder there">Holes</th></tr>`;
  const rows = [...overview.league_table]
    .sort((a, b) => b.playoffOdds - a.playoffOdds || b.pointsFor - a.pointsFor)
    .map((t) => {
      const holes = t.holes.join(", ");
      return `<tr class="${t.isMe ? "me" : ""}" title="${escapeAttr(`${t.teamName} - ${t.manager}, ${t.record}, ${t.pointsFor.toFixed(1)} points for`)}">
        <td class="tname">${escapeHtml(t.teamName)}</td>
        <td>${escapeHtml(t.record)}</td>
        ${league.faab ? `<td>${t.faabLeft != null ? `$${t.faabLeft}` : "–"}</td>` : ""}
        <td>${t.priority ?? "–"}</td>
        <td class="rk ${oddsClass(t.playoffOdds)}">${pct(t.playoffOdds)}</td>
        <td class="wholes" title="${escapeAttr(holes)}">${holes ? escapeHtml(holes) : `<span class="muted">–</span>`}</td>
      </tr>`;
    })
    .join("");
  el("leaguetable").innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
}

function renderMarket() {
  const panel = el("marketpanel");
  if (!overview.league.faab) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const { winning, clearingByBidders, byPosition } = overview.market;
  const money = (x) => (x && x.n ? `$${x.median}` : "–");
  const bidders = Object.entries(clearingByBidders)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([n, x]) => `<td title="${escapeAttr(`${x.n} contested claim${x.n === 1 ? "" : "s"}`)}">${money(x)}</td>`)
    .join("");
  const bidderHead = Object.keys(clearingByBidders)
    .sort((a, b) => Number(a) - Number(b))
    .map((n) => `<th>${n}${Number(n) >= 5 ? "+" : ""}</th>`)
    .join("");
  const positions = POSITION_ORDER.filter((p) => byPosition[p]?.n);
  el("market").innerHTML = `
    <p class="small mkt-line">
      Winning bids: median <b>$${winning.median}</b> · 75th pct <b>$${winning.p75}</b> · 90th pct <b>$${winning.p90}</b>
      <span class="muted">(${winning.n} won claim${winning.n === 1 ? "" : "s"}, $0 included)</span>
    </p>
    <table class="leaguetable mkt">
      <thead><tr><th class="tip tip-l" data-tip="Teams claiming the same player in one run. The price is the median second-highest bid - what it took to win.">Bidders</th>${bidderHead}</tr></thead>
      <tbody><tr><td class="muted">Clearing</td>${bidders}</tr></tbody>
    </table>
    ${
      positions.length
        ? `<table class="leaguetable mkt">
            <thead><tr><th>Position</th>${positions.map((p) => `<th>${p}</th>`).join("")}</tr></thead>
            <tbody><tr><td class="muted">Median win</td>${positions
              .map((p) => `<td title="${escapeAttr(`${byPosition[p].n} won claim${byPosition[p].n === 1 ? "" : "s"}`)}">$${byPosition[p].median}</td>`)
              .join("")}</tr></tbody>
          </table>`
        : ""
    }`;
}

// ---------------------------------------------------------------------------
// Analysis: plan, holes and streams, moves
// ---------------------------------------------------------------------------

const HORIZON_LINE = {
  auto: "weighted by what each week does for your title odds",
  week: "counting this week only",
  season: "counting every week alike",
  playoffs: "counting the playoff weeks only",
};

function renderAnalysis(data) {
  for (const m of data.moves) rememberMove(m);
  if (data.proposal) rememberMove(data.proposal);

  const n = data.moves.length;
  // With no results the server's note says why, so the headline stays quiet.
  el("searchline").textContent = n
    ? `${n} pickup${n > 1 ? "s" : ""} that improve your lineup, ${HORIZON_LINE[data.horizon] ?? ""}`
    : "";

  renderPlan(data.plan);
  renderStreams(data.streams);

  el("proposal").innerHTML = data.proposal ? renderMove(data.proposal, { proposal: true }) : "";
  // The pinned add is already on top; showing him twice is noise.
  const list = data.moves.filter((m) => m.key !== data.proposal?.key);
  const notes = data.notes.map((nt) => `<p class="empty">${escapeHtml(nt)}</p>`).join("");
  el("results").innerHTML = list.length
    ? list.map((m) => renderMove(m, {})).join("") + notes
    : notes || (data.proposal ? "" : `<p class="empty">No add clears the bar at these settings.</p>`);

  const plural = (k, word) => `${k.toLocaleString()} ${word}${k === 1 ? "" : "s"}`;
  el("meta").textContent =
    `${plural(data.considered, "free agent")} considered · ` +
    `${plural(data.evaluated, "add/drop pair")} valued · ${data.elapsedMs} ms · ` +
    `rosters as of ${clock(overview.updatedAt)}`;

  renderPins();
  renderNewsPanel();
  if (revealProposal && data.proposal) el("proposal").scrollIntoView({ behavior: "smooth", block: "start" });
  revealProposal = false;
}

const STEP_LABEL = {
  lineup: { text: "Lineup", cls: "k-lineup" },
  "ir-healthy": { text: "Out of IR", cls: "k-warn" },
  "ir-move": { text: "To IR", cls: "k-ir" },
  add: { text: "Add now", cls: "k-add" },
  claim: { text: "Claim", cls: "k-claim" },
  later: { text: "Later", cls: "k-later" },
  return: { text: "IR return", cls: "k-ir" },
};

function renderPlan(steps) {
  for (const s of steps) {
    if (s.move) rememberMove(s.move);
    for (const m of [...(s.fallbacks ?? []), ...(s.alternatives ?? [])]) rememberMove(m);
  }
  el("plan").innerHTML = steps.length
    ? steps.map(renderStep).join("")
    : `<li class="empty">Nothing to do: no lineup fix, and nothing on the wire beats what you have.</li>`;
}

function renderStep(s, i) {
  const label = STEP_LABEL[s.kind] ?? { text: s.kind, cls: "" };
  const badge = s.kind === "later" ? `Week ${s.week}` : label.text;
  let body = "";
  switch (s.kind) {
    case "lineup":
      body = `<div class="mvline">
        <span class="mvarrow">start</span>${s.start.map((p) => playerChip(p)).join("")}
        ${s.sit.length ? `<span class="mvarrow">sit</span>${s.sit.map((p) => playerChip(p)).join("")}` : ""}
      </div>`;
      break;
    case "ir-healthy":
    case "ir-move":
      body = `<div class="mvline">${playerChip(s.player)}</div>`;
      break;
    case "add":
      body = moveLine(s.move);
      break;
    case "claim":
      body =
        moveLine(s.move) +
        bidBox(s.move.bid) +
        altList(s.fallbacks, "If you lose him", "Fallback claims share the drop and bid no more, so they process after this one.");
      break;
    case "later":
      body =
        moveLine(s.move) +
        bidBox(s.move.bid) +
        altList(s.alternatives, "Or", "Similar fills for the same week - why winning any one of them is worth little.");
      break;
    case "return":
      body = `<div class="mvline">${playerChip(s.player)}${s.cut ? `<span class="mvarrow">cut</span>${playerChip(s.cut)}` : ""}</div>`;
      break;
  }
  return `<li class="step step-${escapeAttr(s.kind)}">
    <span class="step-n">${i + 1}</span>
    <div class="step-body">
      <div class="step-head"><span class="badge stepk ${label.cls}">${escapeHtml(badge)}</span><span class="step-text">${escapeHtml(s.text)}</span></div>
      ${body}
    </div>
  </li>`;
}

/** Add -> drop, compactly, for a plan step. */
function moveLine(m) {
  const room = m.drop
    ? `<span class="mvarrow">drop</span>${playerChip(m.drop)}`
    : m.irMove
      ? `<span class="mvarrow">IR first</span>${playerChip(m.irMove)}`
      : `<span class="mvarrow">into an open spot</span>`;
  return `<div class="mvline">
    <span class="mvarrow">add</span>${playerChip(m.add, `<span class="pos-val">${signed(m.gain, 2)}</span><span class="muted">/wk</span>`)}
    ${room}
    <span class="avail av-${escapeAttr(m.availability.mode)}">${escapeHtml(m.availability.label)}</span>
  </div>`;
}

function altList(moves, label, tip) {
  if (!moves?.length) return "";
  const items = moves
    .map(
      (m) =>
        `<li>${playerChip(m.add, `<span class="pos-val">${signed(m.gain, 2)}</span>`)}` +
        `${m.bid ? `<span class="muted small">bid $${m.bid.amount}</span>` : ""}` +
        `${m.drop ? `<span class="muted small">drop ${escapeHtml(m.drop.name)}</span>` : ""}</li>`,
    )
    .join("");
  return `<div class="alts"><span class="why-h tip tip-l" data-tip="${escapeAttr(tip)}">${escapeHtml(label)}</span><ul>${items}</ul></div>`;
}

function renderStreams(weeks) {
  for (const w of weeks) for (const s of w.streams) remember(s.player);
  const nothing = weeks.every((w) => !w.holes.length && !w.streams.length);
  if (nothing) {
    el("streams").innerHTML = `<p class="empty">No holes this week or next, and no stream beats your starters.</p>`;
    return;
  }
  el("streams").innerHTML = weeks
    .map((w) => {
      const holes = w.holes.length
        ? `<ul class="holes">${w.holes.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>`
        : `<p class="muted small sweek-ok">No holes in your lineup.</p>`;
      const rows = w.streams.length
        ? `<ul class="srows">${w.streams.map(streamRow).join("")}</ul>`
        : `<p class="muted small">Nobody on the wire beats your starters this week.</p>`;
      return `<div class="sweek">
        <div class="sweek-h">Week ${w.week}${w.week === overview.league.nflWeek ? ` <span class="muted">· this week</span>` : ""}</div>
        ${holes}${rows}
      </div>`;
    })
    .join("");
}

function streamRow(s) {
  const p = s.player;
  const pinned = query.add === p.playerId;
  return `<li class="srow">
    ${miniPhoto(p)}
    <span class="badge pos">${escapeHtml(p.position)}</span>
    <span class="sname" title="${escapeAttr(`${p.name}${p.team ? `, ${p.team}` : ""}`)}">${escapeHtml(p.name)}${p.injuryStatus ? ` <span class="badge injury">${escapeHtml(p.injuryStatus)}</span>` : ""}</span>
    <span class="sgain pos-val" title="What he adds to that week's lineup">${signed(s.gain)}</span>
    <span class="spts muted" title="His projection that week">${s.points.toFixed(1)} pts</span>
    <span class="srep muted">${s.replaces ? `over ${escapeHtml(s.replaces)}` : "fills an empty slot"}</span>
    <span class="avail av-${escapeAttr(s.availability.mode)}">${escapeHtml(s.availability.label)}</span>
    <button type="button" class="tog${pinned ? " on get" : ""}" data-pin="${escapeAttr(p.playerId)}" title="${pinned ? "Unpin" : "Judge him against every drop"}">${pinned ? "Pinned" : "Pin"}</button>
  </li>`;
}

const VERDICT = {
  do: { text: "Do it", cls: "v-do" },
  consider: { text: "Consider", cls: "v-consider" },
  skip: { text: "Skip", cls: "v-skip" },
};

const OUTLOOK = {
  up: { sym: "▲", cls: "o-up", word: "Up" },
  down: { sym: "▼", cls: "o-down", word: "Down" },
  steady: { sym: "▶", cls: "o-steady", word: "Steady" },
  unknown: { sym: "?", cls: "o-unknown", word: "Unclear" },
};

function renderMove(m, opts) {
  const pinned = query.add === m.add.playerId;
  const badges = [];
  if (opts.proposal) badges.push(`<span class="badge topper">Your pick</span>`);
  badges.push(
    m.kind === "stream"
      ? `<span class="badge k-stream tip tip-r" data-tip="${escapeAttr(`${Math.round(m.peakShare * 100)}% of the value is in week ${m.peakWeek}: add him for that week, drop him after.`)}">Stream wk ${m.peakWeek}</span>`
      : `<span class="badge flag tip tip-r" data-tip="The value is spread over the season - a player to keep, not a one-week rental.">Hold</span>`,
  );
  if (m.canWait) {
    badges.push(
      `<span class="badge wait tip tip-r" data-tip="Most of his value is in a later week. You can claim him in a later run instead of cutting someone today.">Can wait</span>`,
    );
  }
  if (m.verdict) {
    const v = VERDICT[m.verdict.verdict] ?? { text: m.verdict.verdict, cls: "" };
    badges.push(`<span class="badge ${v.cls} tip tip-r" data-tip="${escapeAttr(`News check: ${m.verdict.reason}`)}">News: ${escapeHtml(v.text)}</span>`);
  }

  const dropSide = m.drop
    ? tplayer(m.drop)
    : m.irMove
      ? `${tplayer(m.irMove)}<div class="muted small">moves to IR - no cut needed</div>`
      : `<div class="tplayer muted">Open roster spot - no cut needed</div>`;

  const contextBits = [
    m.add.usage ? escapeHtml(m.add.usage) : "",
    m.add.trendingAdds ? `added in ${fmtCount(m.add.trendingAdds)} Sleeper leagues today` : "",
    m.add.trendingDrops ? `dropped in ${fmtCount(m.add.trendingDrops)}` : "",
  ].filter(Boolean);
  const context = contextBits.length
    ? `<p class="muted small wctx"><span class="tip tip-l" data-tip="Context, not a reason he ranked: the projections already price in recent usage. Shown so you can sanity-check the pick.">Recent</span> ${contextBits.join(" · ")}</p>`
    : "";

  const dropNote = m.drop ? newsNote(m.drop.playerId) : null;
  const news = [
    m.news ? newsLine(m.add.name, m.news) : "",
    dropNote ? newsLine(m.drop.name, dropNote) : "",
    m.verdict ? `<p class="wverdict ${VERDICT[m.verdict.verdict]?.cls ?? ""}"><b>${escapeHtml(VERDICT[m.verdict.verdict]?.text ?? m.verdict.verdict)}:</b> ${escapeHtml(m.verdict.reason)}</p>` : "",
  ].join("");

  return `
    <article class="card trade wmove${opts.proposal ? " proposal" : ""}" data-key="${escapeAttr(m.key)}">
      <div class="trade-head">
        <div class="trade-who">
          <span class="name">Add ${escapeHtml(m.add.name)}</span>
          <span class="muted small">${
            m.drop
              ? `drop ${escapeHtml(m.drop.name)}`
              : m.irMove
                ? `move ${escapeHtml(m.irMove.name)} to IR first`
                : "into an open roster spot"
          }</span>
        </div>
        <div class="trade-badges">${badges.join("")}</div>
      </div>

      <div class="tsides">
        <div class="tside"><div class="tside-h">Add</div>${tplayer(m.add)}</div>
        <div class="tarrow" aria-hidden="true">⇄</div>
        <div class="tside"><div class="tside-h">${m.drop ? "Drop" : "Room"}</div>${dropSide}</div>
      </div>

      <div class="tscore">
        <span><span class="tip tip-l" data-tip="Change in your best lineup's projected points per week, each week weighted by the horizon - the number moves rank on.">Gain</span> <b class="${valClass(m.gain)}">${signed(m.gain, 2)}</b><span class="muted">/wk weighted</span></span>
        <span><span class="tip" data-tip="Projected points the move adds to this week's lineup, unweighted. Zero when his game is locked or he only helps later.">This week</span> <b class="${valClass(m.gainThisWeek)}">${signed(m.gainThisWeek)}</b></span>
        <span><span class="tip" data-tip="Projected points the move adds over every remaining week, unweighted.">Total</span> <b class="${valClass(m.pointsTotal)}">${signed(m.pointsTotal)}</b><span class="muted"> pts</span></span>
        ${weeklyBars(m.weeklyDelta)}
      </div>

      <div class="wsched">
        <span class="why-h tip tip-l" data-tip="His projection each remaining week against his own average: green weeks are better matchups by the numbers, red worse. @ is an away game.">Schedule</span>
        ${scheduleStrip(m.add.strip, m.kind === "stream" ? m.peakWeek : null)}
      </div>

      <div class="availline"><span class="avail av-${escapeAttr(m.availability.mode)}">${escapeHtml(m.availability.label)}</span></div>

      <ul class="rationale wreasons">${m.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
      ${context}
      ${m.bid != null ? bidBox(m.bid) : ""}
      ${streamAlternatives(m)}
      ${news}
      ${dropOptions(m, opts)}

      <div class="tactions">
        <button type="button" data-pin="${escapeAttr(m.add.playerId)}" title="${pinned ? "Back to the open search" : "Judge him against every drop on your roster"}">${pinned ? "Unpin" : "Pin"}</button>
        ${pinned ? "" : `<span class="muted small">see him against every drop</span>`}
      </div>
    </article>`;
}

/** The lesser streams for the same week and position, folded into this card. */
function streamAlternatives(m) {
  if (!m.alternatives?.length) return "";
  for (const a of m.alternatives) remember(a.player);
  const items = m.alternatives
    .map(
      (a) =>
        `<li>${playerChip(a.player, `<span class="pos-val">${signed(a.gain, 2)}</span>`)}` +
        `<span class="muted small">${escapeHtml(a.availability.label)}</span></li>`,
    )
    .join("");
  return `<div class="alts"><span class="why-h tip tip-l" data-tip="Other free agents who fill the same week about as well - if you lose him, take one of these.">Or</span><ul>${items}</ul></div>`;
}

/**
 * Other ways to make room. On the pinned add every option is listed with a
 * button to choose it; elsewhere only the runners-up, since the first option is
 * the drop already shown.
 */
function dropOptions(m, opts) {
  const options = opts.proposal ? m.dropOptions : m.dropOptions.slice(1);
  if (!options.length) return "";
  const items = options
    .map((o, i) => {
      const chosen = opts.proposal && (query.drop ? o.player?.playerId === query.drop : i === 0);
      const who = o.player
        ? playerChip(o.player)
        : `<span class="muted">${m.irMove ? `Open spot - ${escapeHtml(m.irMove.name)} to IR first` : "Open spot"}</span>`;
      const act =
        o.player && !chosen
          ? `<button type="button" class="tog" data-usedrop="${escapeAttr(o.player.playerId)}" data-add="${escapeAttr(m.add.playerId)}" title="Pin this add with this drop">Use</button>`
          : chosen
            ? `<span class="badge flag">Chosen</span>`
            : "";
      return `<li class="${chosen ? "on" : ""}">${who}<span class="${valClass(o.gain)}">${signed(o.gain, 2)}<span class="muted">/wk</span></span>${act}</li>`;
    })
    .join("");
  return `<div class="dropopts">
    <div class="why-h">${opts.proposal ? "Every way to make room" : "Other drops"}</div>
    <ul>${items}</ul>
  </div>`;
}

function newsLine(name, note) {
  const o = OUTLOOK[note.outlook] ?? OUTLOOK.unknown;
  return `<p class="wnews"><span class="outlook ${o.cls}" title="${escapeAttr(`Outlook: ${o.word}`)}">${o.sym}</span> <b>${escapeHtml(name)}:</b> ${escapeHtml(note.note)}</p>`;
}

function bidBox(bid) {
  if (!bid) return "";
  const lines = bid.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
  return `<div class="bidbox${bid.outbidLikely ? " outbid" : ""}">
    <div class="bid-amt">
      <span class="bid-n">$${bid.amount}</span>
      <span class="bid-label">suggested bid<br /><span class="muted">a starting point, not a solver</span></span>
    </div>
    <div class="bid-why">
      <ul class="bid-lines">${lines}</ul>
      <p class="muted small bid-stats">~${bid.bidders} bidder${bid.bidders === 1 ? "" : "s"} expected, you included · likely clearing price ~$${bid.clearing} · worth up to $${bid.worthCap} to you${bid.outbidLikely ? ` · <span class="warnval">you may lose him - not worth paying more</span>` : ""}</p>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Small renderers
// ---------------------------------------------------------------------------

function playerChip(p, extra = "") {
  if (!p) return "";
  return `<span class="pchip" title="${escapeAttr(`${p.name}${p.team ? `, ${p.team}` : ""} - ${p.perWeek.toFixed(1)} pts/wk`)}">
    ${miniPhoto(p)}<span class="badge pos">${escapeHtml(p.position)}</span><b>${escapeHtml(p.name)}</b>${p.injuryStatus ? `<span class="badge injury">${escapeHtml(p.injuryStatus)}</span>` : ""}${extra}
  </span>`;
}

function tplayer(p) {
  return `<div class="tplayer">
    ${miniPhoto(p)}
    <span class="badge pos">${escapeHtml(p.position)}</span>
    <span class="tpname">${escapeHtml(p.name)}</span>
    ${p.team ? `<span class="muted small">${escapeHtml(p.team)}</span>` : ""}
    ${p.injuryStatus ? `<span class="badge injury">${escapeHtml(p.injuryStatus)}</span>` : ""}
    <span class="tpval">${p.perWeek.toFixed(1)}<span class="muted">/wk</span></span>
  </div>`;
}

/** One cell per remaining week: opponent (@ away), coloured by how the projection rates it. */
function scheduleStrip(strip, peakWeek) {
  if (!strip?.length) return "";
  const TONE = {
    good: "a better week than his average",
    bad: "a worse week than his average",
    even: "about his average",
    out: "projected out",
  };
  const cells = strip
    .map((s) => {
      const opp = s.tone === "bye" ? "BYE" : s.opponent ? `${s.home ? "" : "@"}${s.opponent}` : "–";
      const title =
        s.tone === "bye"
          ? `Week ${s.week}: bye`
          : `Week ${s.week} ${s.home ? "vs" : "at"} ${s.opponent ?? "?"}: ${s.points.toFixed(1)} projected - ${TONE[s.tone] ?? s.tone}`;
      return `<span class="wcell t-${escapeAttr(s.tone)}${s.week === peakWeek ? " peak" : ""}" title="${escapeAttr(title)}">
        <span class="wcell-wk">${s.week}</span><span class="wcell-opp">${escapeHtml(opp)}</span></span>`;
    })
    .join("");
  return `<div class="wstrip">${cells}</div>`;
}

/** Your week-by-week change, as tiny diverging bars: when does this move help? */
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
  return `<span class="wk tip tip-r" data-tip="Projected points the move adds each remaining week, unweighted. One tall bar is a stream for a bye or an injury; an even row is a hold.">
    <svg class="wkbars" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" aria-hidden="true">
      <line x1="0" x2="${width}" y1="${mid}" y2="${mid}" />${bars}
    </svg></span>`;
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
  const width = Math.max(1, values.length * (w + gap) - gap);
  return `<svg class="spark" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" aria-hidden="true">${bars}</svg>`;
}

function miniPhoto(p) {
  if (!p) return `<span class="mini mini-fallback">?</span>`;
  return `<img class="mini" src="${escapeAttr(p.photo)}" alt="" loading="lazy" data-fallback="${escapeAttr(p.photoFallback ?? "")}" data-initials="${escapeAttr(p.initials)}" />`;
}

function onPhotoError(img) {
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

// Image errors do not bubble, but they do pass through the capture phase, so one
// listener covers every photo any render puts on the page.
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.classList.contains("mini")) onPhotoError(img);
  },
  true,
);

// ---------------------------------------------------------------------------
// News: a background job on the server, followed by polling
// ---------------------------------------------------------------------------

/** Today's note on a player, from the last news job the page has seen. */
function newsNote(playerId) {
  return newsJob?.items?.find((i) => i.playerId === playerId) ?? null;
}

/**
 * The job's status, or a thrown error when there is none. A job view carries an
 * `error` field of its own (why a finished job failed), so only a non-2xx
 * response or a body without a status counts as the request failing.
 */
async function newsRequest(init) {
  const res = await fetch("/api/waivers/news", init);
  const data = await res.json();
  if (!res.ok || typeof data.status !== "string") throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function loadNewsStatus() {
  if (!overview?.newsAvailable) return;
  try {
    newsJob = await newsRequest();
  } catch {
    // No status is the same as no news yet; the button still works.
    return;
  }
  renderNews();
  renderMyTeam();
  // Another tab (or an earlier visit) may have one in flight.
  if (newsJob.status === "running") followNews(newsJob.startedAt);
}

async function startNews() {
  newsError = null;
  el("newsbtn").disabled = true;
  try {
    newsJob = await newsRequest({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody()),
    });
  } catch (err) {
    newsError = err.message ?? String(err);
    renderNews();
    return;
  }
  // A job already in flight (another tab started it) keeps its own start time.
  if (newsJob.status === "running") followNews(newsJob.startedAt);
  else newsSettled();
  renderNews();
}

/**
 * Poll the job while it runs. The elapsed counter ticks every second on its own
 * so a slow model call is visibly slow, not stuck.
 */
function followNews(since) {
  clearTimeout(newsPoll);
  clearInterval(newsTick);
  newsFollowing = true;
  // The server's clock is this machine's, but a stale or odd startedAt should not
  // show a counter in the thousands.
  newsSince = since && Math.abs(Date.now() - since) < 3_600_000 ? since : Date.now();
  newsMisses = 0;
  newsTick = setInterval(renderNewsLine, 1000);
  const poll = async () => {
    try {
      newsJob = await newsRequest();
      newsMisses = 0;
    } catch (err) {
      // A blip while polling is not the job failing; give up only on a streak.
      // The job itself carries on, and pressing the button again rejoins it.
      if (++newsMisses >= NEWS_MAX_MISSES) {
        newsError = `Lost track of the news check: ${err.message ?? err}`;
        stopFollowing();
        renderNews();
        return;
      }
      newsPoll = setTimeout(poll, NEWS_POLL_MS);
      return;
    }
    if (newsJob.status === "running") {
      newsPoll = setTimeout(poll, NEWS_POLL_MS);
      renderNewsLine();
      return;
    }
    newsSettled();
    renderNews();
  };
  newsPoll = setTimeout(poll, NEWS_POLL_MS);
}

function stopFollowing() {
  clearTimeout(newsPoll);
  clearInterval(newsTick);
  newsFollowing = false;
}

/** The job finished: stop the timers, and re-run the search so cards carry the notes and verdicts. */
function newsSettled() {
  stopFollowing();
  if (newsJob?.status === "done") {
    renderMyTeam();
    void search();
  }
}

function renderNews() {
  if (!overview) return;
  const available = overview.newsAvailable;
  const btn = el("newsbtn");
  btn.disabled = !available || newsFollowing;
  btn.textContent = newsFollowing ? "Checking…" : "Check the news";
  // A disabled button shows no tooltip in some browsers; its wrapper always does.
  el("newswrap").title = available
    ? "One web-searching model call over the top moves, their drops and your injured starters: a note on each player and a verdict on each move. It costs money; results are cached for the day."
    : "The news check is not available in this mode - it runs against the live league with an Anthropic API key.";
  renderNewsLine();
  renderNewsPanel();
}

function renderNewsLine() {
  const line = el("newsline");
  if (!overview?.newsAvailable) {
    line.textContent = "Not available in this mode.";
    return;
  }
  if (newsError) {
    line.innerHTML = `<span class="err">${escapeHtml(newsError)}</span>`;
    return;
  }
  if (newsFollowing) {
    const secs = Math.max(0, Math.round((Date.now() - newsSince) / 1000));
    line.innerHTML = `<span class="thinking">Checking the news… ${secs}s</span>`;
    return;
  }
  const job = newsJob;
  if (!job || job.status === "idle" || job.status === "running") {
    line.textContent = "Notes and verdicts from today's news on the top moves.";
    return;
  }
  if (job.status === "error") {
    line.innerHTML = `<span class="err">News check failed: ${escapeHtml(job.error ?? "unknown error")}</span>`;
    return;
  }
  line.textContent = `Checked${job.finishedAt ? ` at ${clock(job.finishedAt)}` : " today"}: ${newsCost(job)}`;
}

/** "$0.42, 6 searches", or "from today's cache" when nothing new had to be looked up. */
function newsCost(job) {
  if (!job.costUsd && !job.searches) return "from today's cache";
  const parts = [`$${job.costUsd.toFixed(2)}`, `${job.searches} search${job.searches === 1 ? "" : "es"}`];
  if (job.cachedPlayers) parts.push(`${job.cachedPlayers} player${job.cachedPlayers === 1 ? "" : "s"} from today's cache`);
  return parts.join(", ");
}

function renderNewsPanel() {
  const panel = el("newsout");
  const job = newsJob?.status === "done" ? newsJob : null;
  const summary = job?.summary ?? lastResult?.news?.summary ?? null;
  const items = job?.items ?? [];
  if (!summary && !items.length) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  const notes = items
    .map((it) => {
      const o = OUTLOOK[it.outlook] ?? OUTLOOK.unknown;
      return `<li><span class="outlook ${o.cls}" title="${escapeAttr(`Outlook: ${o.word}`)}">${o.sym}</span> <b>${escapeHtml(it.name)}</b> ${escapeHtml(it.note)}</li>`;
    })
    .join("");
  panel.innerHTML = `
    <h2>Today's news</h2>
    ${summary ? `<p class="newssum">${escapeHtml(summary)}</p>` : ""}
    ${items.length ? `<details><summary class="muted small">Every note (${items.length})</summary><ul class="newsnotes">${notes}</ul></details>` : ""}
    <p class="muted small">From a web-searching model call. It annotates the engine's moves; it never re-ranks or hides one.</p>`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

el("horizonseg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-horizon]");
  if (!b) return;
  query.horizon = b.dataset.horizon;
  renderControls();
  scheduleSearch(0);
});

el("posseg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-pos]");
  if (!b) return;
  const pos = b.dataset.pos;
  if (!pos) query.positions.clear();
  else if (query.positions.has(pos)) query.positions.delete(pos);
  else query.positions.add(pos);
  // Every position selected is the same search as none.
  if (query.positions.size === leaguePositions().length) query.positions.clear();
  renderControls();
  scheduleSearch();
});

el("newsbtn").addEventListener("click", () => void startNews());

document.addEventListener("click", (e) => {
  const tog = e.target.closest("button.tog[data-act]");
  if (tog) {
    togglePin(tog.dataset.act, tog.dataset.id);
    return;
  }

  const x = e.target.closest("button.pin-x");
  if (x) {
    if (x.dataset.kind === "keep") query.keep.delete(x.dataset.id);
    else query[x.dataset.kind] = null;
    afterPinChange();
    return;
  }

  if (e.target.closest("#clearpins")) {
    query.keep.clear();
    query.add = null;
    query.drop = null;
    afterPinChange(0);
    return;
  }

  const pin = e.target.closest("button[data-pin]");
  if (pin) {
    const id = pin.dataset.pin;
    // Pinning shows him against every drop, so a pinned drop from before goes.
    if (query.add === id) query.add = null;
    else {
      query.add = id;
      revealProposal = true;
    }
    query.drop = null;
    afterPinChange(0);
    return;
  }

  const use = e.target.closest("button[data-usedrop]");
  if (use) {
    query.add = use.dataset.add;
    query.drop = use.dataset.usedrop;
    query.keep.delete(query.drop);
    revealProposal = true;
    afterPinChange(0);
  }
});

function togglePin(act, id) {
  if (act === "keep") {
    if (query.keep.has(id)) query.keep.delete(id);
    else {
      query.keep.add(id);
      if (query.drop === id) query.drop = null;
    }
  } else if (act === "cut") {
    query.drop = query.drop === id ? null : id;
    query.keep.delete(id);
  }
  afterPinChange();
}

function afterPinChange(delay) {
  renderControls();
  renderMyTeam();
  scheduleSearch(delay);
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

function signed(v, digits = 1) {
  return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(digits)}`;
}

function valClass(v) {
  return v > 0.005 ? "pos-val" : v < -0.005 ? "neg-val" : "";
}

/** Good odds green, slim odds red - the same reading as the trade page's ranks. */
function oddsClass(p) {
  if (p >= 0.75) return "rk-good";
  if (p < 0.2) return "rk-bad";
  return "";
}

function pct(p) {
  return p > 0 && p < 0.01 ? "<1%" : `${Math.round(p * 100)}%`;
}

function fmtCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** "9:41am", local time. */
function clock(epochMs) {
  return new Date(epochMs)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .replace(" AM", "am")
    .replace(" PM", "pm");
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
  if (!ok) return;
  void search();
  void loadNewsStatus();
});
