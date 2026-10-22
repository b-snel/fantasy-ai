# AGENTS.md

Notes for anyone — human or agent — picking this up. The project was built in a
sandbox that could not reach Sleeper; the open items that created were settled on a
networked machine on **2026-09-01** (verification details below). What remains is
draft-morning routine, not open questions.

Everything in `bun test` passes offline against `fixtures/` and stays that way.

---

## Context you need

- League `1348178795533701120`, user `tugger_woods` (`434221843767881728`).
- Confirmed live: **THE MAIN LEAGUE**, 12 teams, snake, 15 rounds, 120s pick timer,
  `pre_draft`. You are **roster 3, draft slot 9**. The league is **redraft**
  (owner-confirmed).
- Scoring is **half PPR with 6-point passing touchdowns** (not the usual 4).
- Roster: `QB, RB, RB, WR, WR, TE, FLEX, FLEX, DEF` + 6 bench. **There is no kicker
  slot.** `fixtures/real-league.json` encodes all of this and
  `test/real-league.test.ts` asserts the engine handles it.

---

## Remaining before draft day

### 1. Sweep news the morning of the draft

`bun run news` caches to `data/news.json` and is **not** re-run automatically. Notes
go stale. Run it the morning of the draft, not days before. (~$0.30–1.00, one time.)

### 2. Re-sync the morning of the draft

```sh
bun run sync --force     # fresh projections, ADP, byes, trending
bun run doctor           # should stay green; re-checks the ADP field too
bun start                # then open http://localhost:5173
```

Sanity line to look for: `[projections] ADP from adp_dd_ppr (...)` with a range that
starts at 1 and tops out in the low hundreds. If the range ever reaches 999+ the
sentinel filter in `src/data/adp.ts` regressed.

### 3. One thing still unobserved (LOW)

The background auto-call path (Haiku, triggered when the board's top three changes
inside 8 picks of your turn) has been verified against the real API directly, but has
never fired end-to-end inside a live draft — pre-draft boards never change, so it
cannot be exercised before picks actually happen. `lastCallReason` in the Status area
tells you what it is doing on draft day.

---

## Settled 2026-09-01 — do not redo

All five original open items were verified against live data (12-agent verification
run: parallel checks, adversarial review of the ADP conclusion, live model calls).

**`adp_dd_ppr` is genuine overall redraft ADP.** Confirmed three independent ways:
density is exactly 12 players per 12 picks at every threshold (overall scale, not
positional); within-position Spearman between ADP and projected points is 0.84–0.98
(redraft, not dynasty); aging stars sit at their projection ranks — CMC (30) at
overall 3, Derrick Henry (32) at 22, Kelce (36) at TE7 — orderings impossible on a
dynasty board. Caveats that are true but not verdict-changing:

- The values are an **ordinal rank** (consecutive integers, no ties), not a
  fractional average pick. Fine as an expected pick number.
- The flavor is **full PPR** — no half-PPR variant exists anywhere in the payload —
  in a half-PPR, 6-pt-pass-TD league. Pass catchers may go slightly later and QBs
  slightly earlier here than the market number implies.
- Sleeper **caps** untracked ADP instead of omitting it: 999 for positions it does
  not track (every K and DEF), 1000 for undrafted players. `src/data/adp.ts` now
  treats ≥999 as "no data" — a cap fed to the survival model as a real pick would
  claim the player is never drafted, which was exactly wrong for **Josh Jacobs**
  (projected ~RB15, parked at 1000 in the live payload). He and all K/DEF now carry
  `adp: null` → survival's neutral 0.5 prior. If a startable player's card shows
  `adpΔ -`, this is why; trust proj/vorp for them.

**All 18 weeks of 2026 projections are published** (3297–3303 rows each), so the
never-exercised partial-season extrapolation path stays dormant. Summation verified
end-to-end: Gibbs' 18 live weekly stat lines scored through `scoreStatLine` with the
league's live scoring reproduce the cached 347.1 exactly. Totals are ceiling-ish
(they assume all 17 non-bye games played), which is fine for ordering and VORP.

**Defenses are carried with real projections.** 32/32 DEF rows, all
`sleeper_weekly`, compressed spread (LAR 180.4 down to MIA 107.5) — the search_rank
fallback did not engage, and rank.ts's streamable suppression handles them.

**The live end-to-end path works.** Server ran against the live league, a real Opus
call produced cards naming real players with numbers matching the shortlist, the
ask tool-loop answered correctly, and the recommendation prefix was proven
byte-stable across separate API requests (3443-token cache write on call one,
3443-token cache read on call two with a different board).

The earlier connectivity findings also stand: all documented endpoints, the
undocumented `api.sleeper.com` host, and all three CDN image paths work;
`data/capabilities.json` records this and the adapters read it.

---

## Bugs found in the first live run — fixed 2026-09-01

The dry run surfaced four real defects, and the adversarial review of the fixes
surfaced a fifth; all are fixed and covered by tests:

1. **Background Haiku calls 400'd on every 2s poll.** Haiku 4.5 predates
   `thinking: {type: "adaptive"}` and `output_config.effort`; `recommend()` now
   sends neither to pre-4.6 models. The gate (`supportsAdaptiveThinking`) matches
   model *families*, not exact ids, so a draft-day switch to a dated snapshot
   cannot silently re-trigger it. Separately, a failed call now starts a 15s
   cooldown on automatic retries (`FAILURE_COOLDOWN_MS` in `state.ts`) — this
   covers the on-clock window too, where the board fingerprint is never consulted,
   while transient blips still self-heal and manual refresh always goes through.
2. **Cards carried player names in `player_id`.** The schema demanded ids "copied
   exactly from the table" but the candidate table had no id column, so the UI
   (`web/app.js`) could never match cards to candidates. The table now leads with
   an `id` column, and the UI resolves both card ids and the top-pick id through
   the same forgiving id-then-name lookup.
3. **Long responses lost their bodies.** Bun's ~10s default idle timeout dropped a
   12s `/api/refresh` response while a 24s Opus call ran behind it. `Bun.serve` now
   sets `idleTimeout: 240`.
4. **Bun 1.4 activated an SSE reconnect race.** Stream `cancel`/abort callbacks now
   actually fire, asynchronously — so an old connection's late cancel could tear
   down the replacement subscription that reused its id. All cleanup paths now go
   through ownership-checked removal (`SubscriberRegistry.removeIf`).
5. **Cost accounting:** an in-process cache hit no longer zeroes the cost display
   (and says "served from local cache" in Status), ask-path usage sums every
   tool-loop turn — recorded even if the loop dies mid-way — and lands in the same
   spend ledger as recommendations.

A live mock-draft session then surfaced two more, both fixed the same day:

6. **A reaped SSE client froze forever.** Reaping only unsubscribed — it never
   closed the HTTP stream — and the client never read the heartbeat's
   `known:false`. A background tab (browsers throttle timers there) would lapse
   past the 20s heartbeat window, get reaped, and then sit on an open, silent
   connection showing pick-1 state for the rest of the draft. Teardown now closes
   the stream (EventSource auto-reconnects), the client reconnects on
   `known:false`, and a `visibilitychange` beat makes refocus recovery instant.
   Static assets are also served `no-store` so a reload always gets current JS.
7. **Mock-draft picks attribute to nobody.** League drafts fill `roster_id` on
   every pick; mocks leave it null and set only `draft_slot` — so every roster
   looked empty all draft. `rosterOfMadePick` in `snake.ts` resolves through the
   slot map (then pick-order math) and is now the only way picks are attributed.

A second live mock (2026-09-01 evening) surfaced two more, both fixed:

8. **The fast-mode 429 held the on-clock call hostage for minutes.** The SDK
   retries 429s twice by default and sleeps for whatever `retry-after` says —
   uncapped ("just do what it says" in `client.js`). An org-quota rejection is
   deterministic, so the user stared at loading skeletons while the SDK slept,
   with `inFlight` blocking manual refresh the whole time. The recommendation
   path now sends every attempt with `maxRetries: 0, timeout: 90s` — the
   session's own retry loop (15s cooldown with a visible "retrying in ~Ns"
   status, plus the Refresh button) is the only retry mechanism, so failures
   surface fast instead of sleeping invisibly. `probeFastMode()` additionally
   settles fast-mode availability with a 1-token request at boot, so the
   discovery never happens on a clock.
9. **A silently dead SSE stream froze the page with no recovery path.** The
   heartbeat proves to the *server* that the page is alive; nothing proved to
   the *page* that the stream was. A half-open socket or a connection broken in
   tab suspension leaves EventSource reporting OPEN forever. Complete drafts now
   keep polling on the normal path (an emit-only "pulse" variant froze the live
   completion transition and could drop final picks — found in adversarial
   review before it shipped), so a "ready" session pushes a snapshot every poll
   interval, and the client reconnects after 10s of ready-state silence while
   visible (`STALL_MS` in `app.js`). Boot/error states push once per connect and
   are exempt. Skeletons show elapsed seconds, so slow is visibly not stuck.
   The same review hardened the edges: overlapping pick polls can no longer
   land out of order (`pollSeq`), an in-flight ask/recommendation finishing
   during a `switchTo` no longer renders the half-booted session (epoch guards
   on both finally-recomputes), a stale heartbeat verdict can no longer tear
   down a just-built replacement connection, and the cache drift detector keys
   by model family so fast/standard-served Opus calls share one streak.
   Known, accepted: if Sleeper itself stops responding, the pulse keeps flowing
   with the last good board — the watchdog measures stream liveness, not data
   freshness (a full Sleeper outage stalls the real draft too).

A third live mock (same evening) exposed the fast-draft crunch — CPU opponents
pick in seconds, so the model has no warm-up time between your picks:

10. **The on-clock call queued behind an in-flight background call.** A single
    `inFlight` flag gated all calls equally, so when six CPU picks landed while
    a background Haiku refresh was mid-answer, the Opus call for YOUR pick
    waited for an answer to a dead board. On-clock urgency (manual refresh
    included) now supersedes an in-flight background call; `callSeq` strands the
    superseded result (it still completes and bills - pennies - but cannot
    write state, fail the cooldown clock, or clear the newer call's flags).
    `switchTo` bumps the same counter so a draft switch strands calls too.
11. **The pick clock ran against blank skeletons for 20-30s.** That is real
    Opus latency and cannot be waved away, so the wait now shows the engine's
    own top three as provisional cards (dashed border, "Engine #1" badge,
    full stats - the exact numbers the model is reasoning over) the moment a
    call starts. Shimmer skeletons remain only before the draft has anyone to
    rank. The real draft's 120s timer plus human-speed picks between your
    turns make this comfortable; in a CPU mock expect the engine cards to
    carry the first ~20s of most of your picks.

---

## Trade analyzer — added 2026-10-19

In season the draft is over, so the useful question becomes "who should I trade
with?". `/trades` (and `bun run trades`) answers it. Code lives in `src/trade/`
(`value.ts` roster valuation, `search.ts` the search and the three bars,
`explain.ts` reasons and the pitch), `src/data/ros.ts` (rest-of-season weekly
projections) and `src/server/trades.ts` (the service; independent of the draft
session, loads lazily, refreshes rosters when older than a minute).

**How a trade is judged.** Value is the expected points of each roster's best
legal lineup, week by week through the last fantasy-playoff week, with a
waiver-streaming floor under every slot and bench depth priced as injury
insurance. A trade is shown only if (1) your lineup gains at least
`minGainPerWeek`, (2) theirs loses at most `maxPartnerLossPerWeek`, and (3) the
market ratio - what they receive over what they send, on a perception model with
a stud premium and a roster-spot charge per extra body - is at least
`minMarketRatio`. All in `config.trade`. Results rank by your gain times a
logistic acceptance heuristic (`acceptanceLikelihood`); the UI labels it as a
rough read, not a probability, and it should stay labelled that way.

**Data facts, verified live 2026-10-19** (`api.sleeper.com` weekly projections,
Rotowire-sourced, refreshed weekly in season):

- A **bye** is a row with `opponent` and `date` both null and near-empty stats.
- An **injured** player keeps his game row (date, opponent) with near-zero stats;
  IR players project zero until their expected return week, then normal points.
  (Mostly: some IR players carry token 2-4 point projections every week - Tank
  Dell, live 2026-10-21 - so "back" means half his healthy level; see `returnWeek`.)
  So injury timing is in the data - do not add a separate injury model.
- The current week is partly played on most days. Rows with `date` before today
  (America/New_York) are zeroed and the player recorded in `played`, so a game
  already played is neither counted nor reported as an absence.
- `data/ros.json` is keyed by window, date and scoring, and carries
  `CACHE_VERSION` - bump it whenever the cached shape changes, or an old file is
  half-read (this happened once: every player read as "returning from injury").

**How to work on it safely.** Same lesson as the draft engine: run
`bun run trades --league` against the live league and read the trades, not just
the tests. Two bugs only showed up that way: junk throw-ins inflating the paper
ratio (fixed by charging the receiver a roster spot), and that charge priced at a
league-starter level, which made every 2-for-1 look like a fleecing (fixed by
pricing a spot at the second-best non-K/DEF free agent). `test/trade.test.ts`
guards both. Assert structural properties in tests (both sides gain, the RB
surplus goes out); the exact package the search picks is its own call.

**Deep analysis (added 2026-10-21).** "Ask Claude" on a trade card (and
`bun run trades --give=.. --get=.. --deep`) runs `src/llm/trade-review.ts`:
Claude Opus 5.5 at high effort through the beta tool runner, with
`web_search_20260209` and three engine tools (`evaluate_trade`, `find_trades`,
`get_team`) that call the same `findTrades`/`evaluateTrade` the page does. The
user message is `buildBriefing` (`src/trade/briefing.ts`) - deterministic, and
shown to the user under "What Claude was told". The answer is a structured
verdict (`VerdictSchema`); any counter-offer is re-scored by the engine before it
is shown, so the numbers beside it are never the model's paraphrase. Runs are
background jobs (`startDeep` -> 202, the page polls `/api/trades/deep/:id`)
because one takes 1-2 minutes. Server-side refusal fallbacks are on
(`fallbacks: "default"`).

Verified live 2026-10-21 on St. Brown for Watson + Dobbins + McMillan: two runs,
$0.30/69s and $0.47/104s, both "counter" with the same engine-checked variation.
Two things learned: `max_uses` on web search is per request, not per run, so a
multi-turn run can exceed `maxSearches` (12 searches against a cap of 8); and the
model sometimes repeats an identical query, so the prompt asks it to cover each
player once before going deeper. Tests never call the model: every
`TradeService` in `test/` takes `cannedReviewer()` from `fixtures/trade.ts` -
keep it that way, because with a key in `.env` the default reviewer makes billed
calls.

**Known simplifications.** Draft picks are not tradeable assets (this league has
`pick_trading: 0`). K and DEF are left out of open-ended searches (streamable;
pin them to include them). A player received from the other team's IR lands in
your IR if there is room, without checking his designation. The acceptance
heuristic is uncalibrated - it orders results, nothing more.

---

## Waiver analyzer — added 2026-10-21

The weekly question is "who do I pick up, and who do I cut?". `/waivers` (and
`bun run waivers`) answers it with an ordered plan: lineup fix, IR housekeeping,
adds to make now, claims (drop, bid, fallbacks), streams that can wait for the next
run, IR returns that force a cut. Code: `src/waiver/` (one module per concern),
`src/data/{activity,usage}.ts`, `getTeamSchedule` in `src/data/schedule.ts`, and
`src/server/waivers.ts` (the trade analyzer's data source plus those; same lazy
load and one-minute roster refresh as TradeService).

**How a move is judged.** Add a free agent, drop one of yours (no drop when a spot
is open, or when an injured active player projected out this week can take a free
reserve slot - an IR slot does not score). Value is the change in your best
lineup's expected points each week. The trade floor - free streaming under every
starter - is circular when streaming is the advice: live, it credited your 0-6
roster with 5.4 pts/wk of pickups it had not made, capped the best move at
+0.43/wk (under the trade analyzer's 0.5 bar), and hid that its only QB and only
DEF share the week-8 bye. Depth 3/4 floors were measured and do not fix it (rank
correlation 0.97-0.98). So `noFloorWeeks` (2): this week and next have no floor
under starters - that is where the decisions are - and later weeks keep it,
because by then you can stream like everyone else. (Floorless everywhere was
tried first: the review found it told every contender to stockpile defenses in
October for a point in the playoffs.) The floor stays under the injury term in
every week, and each candidate is valued on a floor with him removed
(`floorWithout`). This week's locked starters hold their slots (`WeekZero`): once
his game is over a starter projects 0 for the week, and without that his slot
read as a hole any free agent filled - every Thursday through Monday. The
season simulation keeps the normal floor - rivals do stream. Search is
exhaustive; the plan is greedy and re-searches after each step, so nobody is cut
twice. Bench lock is checked when the claim processes (an instant add now, a
fresh-drop claim ~23h out, nothing for a next-run claim). A claim that processes
after his game counts from next week. A move with `streamShare` of its positive
weekly gain in one week is a stream (judged on plain weekly gains, so the label
does not change with the horizon); it can wait for the next run only if what
waiting gives up - this week's weighted value - is under a quarter of it. A
next-week stream becomes a "next run" step with its own cut; further out stays
in the move list. Same-week, same-position streams fold into one card, and every
bid is priced against the same peers (same position, same week). Thresholds in
`config.waiver`.

**Week weights** (`odds.ts`): leverage = slope of P(win that game) at the projected
margin x what a win is worth (title equity of one more win, pooled over simulated
seasons with analytic bracket equity, plus `winValue` per regular-season win so an
eliminated team still values its next game). Weekly team score sd ~21-22 matched
weeks 1-6. The first attempt - forcing each game's result and counting title
flips - was Monte Carlo noise for a ~1%-odds team and could go negative; do not
go back to it. The `week`/`season`/`playoffs` horizons replace these weights.

**Data facts, verified live 2026-10-21:**

- FAAB (`waiver_type` 2, $100), `waiver_day_of_week` 2 = Wednesday; every run
  09-16 .. 10-21 processed at ~03:08 ET. Drops clear ~23h later (`waiver_clear_days`
  1). Off-cycle clears share a timestamp only among their few bidders (3, vs 21-39
  in weekly runs) - that is how `waiverCalendar` tells them apart. The next run is
  stepped in New York clock time; no run after a daylight-saving change has been
  observed yet, so 03:08 EST on 11-04 is an assumption.
- Players are instant free agents from the run until kickoff, then locked until the
  next run; `bench_lock` means a player whose game started cannot be dropped. The
  schedule has date and status but no kickoff time, so locks are estimated (Thu
  20:15, Sun 13:00, Mon 19:15 ET; a Thursday with several games - Thanksgiving -
  12:30 for all of them; erring early; international games not flagged).
- `/matchups` returns future weeks, but playoff weeks carry fake repeats of the
  regular-season rotation, so only weeks before `playoff_week_start` are used.
- The stats endpoint gives per-game snaps/targets/carries; its `pts_*` fields are
  not league scoring, so `usage.ts` rescores every line.
- FAAB clearing price (2nd-highest bid per auction) rises steeply with bidders: ~$2
  with two, $5 three, $5 four, $23 five-plus here (defaults $2/$3/$7/$18 when the
  history is thin). Position matters: median winning bid QB $0, RB/WR $11. Lineup
  gain does not predict who bids (11 of 12 players claimed in one run had no rival
  gaining from them), so demand comes from trending adds, fresh drops and rivals'
  holes. 41 of 120 failed claims failed on roster size - hence explicit drops, and
  fallbacks that share the drop and never bid more.
- Measured and left out: defense-vs-position (6-week reliability ~0 RB, ~0.1 WR,
  0.35-0.56 QB/TE/DEF, already inside the projections). Usage and trending are
  context only: an opportunity jump moves next week's projection, nothing beyond.

**The news check** is the only paid step: Opus 5.5 + `web_search_20260209`,
server-side fallbacks, `maxRetries: 0`, 150s timeout, `pause_turn` continuations,
search fees ($0.01 each) counted into `recordUsage`, cached per player per Eastern
day in `data/waiver-news.json`. A background job (POST `/api/waivers/news` starts
it, GET polls), so it can never outlive Bun's `idleTimeout`. It annotates; it never
re-ranks or hides a move. It does not reuse `src/data/news.ts` on purpose: that
ignores search fees and `pause_turn` and writes the file the draft board reads.
First live run (2026-10-21, $0.28, 50s, 8 searches billed): search failed after
one query and the model filled the notes with "couldn't check" - which got cached
as news. Server-tool errors arrive as HTTP 200 with an error object in the tool
result, so `news.ts` now counts them and, when failed searches outnumber
successful ones, throws with the error codes and caches nothing. The cause was
found the next day (2026-10-22, from a raw response): `web_search_20260209` runs
its queries from code the model writes, every query counts against `max_uses`,
and at 8 the model spent the whole budget in its first two code steps (repeats
and test queries included) and checked one player. The limit shows up only as
`stderr: "Server tool use limit exceeded"` in the code run's result. Now: a
budget of `config.waiver.newsMaxSearches` (30), a prompt that says one query per
player and no repeats, detection of the stderr form, and only players some query
actually named are cached - the rest are listed as unchecked and asked again on
the next check. First working run: $0.72, 70s, and it caught a stale projection
(a "dead weight" drop who had become his team's lead back).

**How to work on it safely.** Same lesson: run `bun run waivers` against the live
league and read the plan - the floor problem above was found on live output, and
the defense hoarding only on a contender's roster, so read another team's plan
too (point a TradeDataSource wrapper's `userId` at another owner). Also run it on
a game day: the locked-starter bug only exists between Thursday and Monday. A
long-running server reloads projections on a new Eastern day, and a Sleeper blip
on refresh keeps the last good schedule and transactions rather than empty ones.
Every POST under `/api/*` refuses cross-site requests, so another page cannot
start a paid check from your browser (the server still binds every interface).
`bun run demo` serves `/waivers` on `fixtures/waiver.ts` with no news provider.
Assert structure in tests (a bye hole found, nobody cut twice, a later-week stream
waits), not which free agent tops the list. The trade path must stay identical
(`floorStarts` undefined). Never write `data/news.json` or `data/schedule.json`
from here; the new caches (`data/stats.json`, `data/team-schedule.json`,
`data/waiver-news.json`) carry `CACHE_VERSION` keys - bump on shape change.

**Known simplifications.** A healthy player in IR raises an alert worded "Sleeper
may block" (not verified that it does). A returning IR player gets a "you will need
to cut" step, but the valuation does not charge that cut. No stash/handcuff list:
measured near-worthless for a near-eliminated team, and the naive formula
overstated it 1.5-15x - a real one must price the contingency through
`rosterValue`. Ranking maximises expected points, not P(win); a long-shot team
might prefer variance. Claim fallbacks are listed, but Sleeper's league-wide
processing order is not simulated. Bids are a heuristic starting point. Rivals' IR
and roster blocks are not modelled.

---

## How to work on this safely

**Run the simulation and read the output.** Six roster-construction bugs were found
that way, and none would have been caught by a unit test — in every case each
individual number was correct and fifteen rounds of interaction were still wrong.
`test/draft-integration.test.ts` documents each one.

```sh
bun run mock --verbose   # fixtures only — there is no --live-league flag
bun run mock --llm       # additionally makes 3 real model calls at your first picks
```

If you touch anything in `src/engine/rank.ts`, `roster.ts`, or the value curve in
`projections.ts`, run this and look at the final roster before trusting the tests.
Note: mock runs **fixtures** (which do include a kicker slot, unlike the real
league), so a K in a mock roster is correct there.

**Do not over-tune against the fixtures.** The synthetic value curve is calibrated to
real half-PPR totals but is smooth where real projections are lumpy. Structural
properties — starters filled, one DEF, no kicker hoarding — are worth asserting.
Fine positional preferences are not.

**SSE liveness is client-driven — keep it that way.** On Bun 1.3.x the stream
`cancel` callback never fired and `enqueue` succeeded into dead sockets, so
`SubscriberRegistry` reaps anything that stops heartbeating. Bun 1.4 *does* fire
`cancel` on clean client cancels — asynchronously, which is why (a) the server
tests settle the listener count before asserting and (b) every stream cleanup path
uses ownership-checked removal (`removeIf`), so a late cancel from a replaced
connection cannot kill its successor. A silently dead socket still gives no
signal, so the registry remains load-bearing. Do not "simplify" any of this away.
The reverse direction is covered too: while the session is "ready" the server
pushes a snapshot every pick-poll tick in every draft status - complete drafts
included, which keep polling normally on purpose (do NOT re-add a "poll once
then go quiet on complete" optimization: it froze the live completion
transition and could permanently drop final picks). The client treats >10s of
ready-state silence while visible as a dead stream and reconnects (`STALL_MS`
in `web/app.js`); "starting"/"error" snapshots are exempt because those states
legitimately push only once per connect. If you change poll cadence or add a
status that stops emitting, keep that contract or the client will reconnect in
a loop / sit frozen depending on which half you broke.

**The prompt prefix must stay byte-stable.** It carries a 1-hour cache breakpoint
and a single drifting byte makes every request pay full input price with no error
anywhere. `test/prompt.test.ts` guards it. Never interpolate a clock, a pick number,
or anything per-request into `buildStaticPrefix`. (Editing the prefix between
sessions is fine — it re-caches once; drift *within* a draft is what burns money.)

Three layers of caching are in place, all verified against live traffic:
the recommendation prefix (explicit breakpoint, 1h TTL — matches the 15-20 min
gaps between your picks; read on every Opus call through an entire mock draft),
the ask prefix (tools + system, 1h), and the ask tool-loop tail (top-level
automatic caching, 5m — each turn re-reads prior turns instead of re-paying;
observed: 8 fresh input tokens against 8,063 cached). The Haiku background path
deliberately does not cache: its prefix sits under Haiku 4.5's 4096-token
minimum, and padding to clear it would cost more prose than it saves.

Because drift is silent, `recordUsage` in `src/llm/recommend.ts` watches for its
signature — two consecutive calls on one model that *write* a cache entry with
zero *reads*, i.e. every request re-caching a prefix nobody reuses — and raises
a warning that surfaces in the UI alerts bar (`cacheWarning` in LiveState) and
the server log. Zero reads with zero writes is the expected below-minimum Haiku
case and never warns. If that alert ever appears on draft day, the fix is to
diff two consecutive rendered prompts; the invalidator is the first differing
byte.

---

## Commands

**The home page (`/`)** lists every draft the assistant can follow: the league's
own drafts (discovered from Sleeper's user-drafts endpoint - the primary one
shows a countdown to its scheduled start) and mock drafts. Sleeper has **no API
that lists a user's mocks** (probed live 2026-09-01: the documented endpoint
returns league drafts only, every plausible mock URL 404s), so mocks live in a
local registry (`data/mocks.json`): paste a Sleeper draft link once, or open one
any other way, and it is remembered. Opening a draft switches the server's
single session in place - SSE subscribers stay connected and simply start
receiving the new draft (`DraftSession.switchTo`, epoch-guarded against
in-flight callbacks for the old draft). The draft room lives at `/draft`.
The in-season pages, `/trades` and `/waivers`, are independent of the draft session.
`SLEEPER_DRAFT_ID=<id> bun start` still works and registers the mock. Expect
~$0.50-3 of model spend for a full CPU mock.

**FAST_MODE=1** runs the Opus paths (recommendations and ask) in fast mode: same
model, up to 2.5x quicker cards, 2x price. What is known from live observation
(2026-09-01, one evening, three states): (a) hard 429 "0 fast mode input
tokens" in the afternoon; (b) later, an 8-token probe was served fast and a
4.4k-token call was accepted but served standard (`usage.speed` is ground
truth; billing follows the speed that served); (c) later still, real calls
429'd again while the tiny probe passed - enforcement admits requests the
quota cannot actually cover, or the quota flaps. Conclusion: **do not trust
the flag until the console shows a nonzero fast-mode limit** (Settings ->
Limits). The app is safe either way: the boot probe is now sized like a real
request (~4.5k tokens, ~$0.02-0.05 when served, free on 429) so its verdict
matches reality; any 429 - probe or live - logs `[fast-mode] disabled`
instantly (no SDK retry sleeps) and the session falls back to standard for
good (sticky on purpose: flapping speeds would also invalidate the prompt
cache). Set the flag for the whole draft or not at all.

| Command | What it does |
|---|---|
| `bun run doctor` | Probe every endpoint and CDN path; write `data/capabilities.json` |
| `bun run sync` | Cache players, league, projections, ADP, bye weeks (`--force` refetches) |
| `bun run news` | One-time pre-draft news sweep (costs money) |
| `bun run trades` | In-season trade analyzer in the terminal (`--league`, `--team=`, `--get=`, `--give=`, `--fixtures`; `--deep` asks Claude, costs ~$0.30-0.60) |
| `bun run waivers` | In-season waiver analyzer in the terminal (`--fixtures`, `--refresh`, `--horizon=`, `--pos=`, `--keep=`, `--add=`, `--drop=`, `--league`, `--verbose`) - free |
| `bun run waivers --news` | Same, plus the paid news check over the shortlist - the only flag that costs money (free when today's notes are cached; not with `--fixtures`) |
| `bun start` | Live draft server at `localhost:5173` |
| `bun run demo` | Real UI against fixtures — no Sleeper, no API key |
| `bun run mock` | Simulate a full 15-round draft in the terminal (fixtures) |
| `bun test` | Full suite, offline |
| `bun run typecheck` | `tsc --noEmit` |
