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
| `bun start` | Live draft server at `localhost:5173` |
| `bun run demo` | Real UI against fixtures — no Sleeper, no API key |
| `bun run mock` | Simulate a full 15-round draft in the terminal (fixtures) |
| `bun test` | Full suite, offline |
| `bun run typecheck` | `tsc --noEmit` |
