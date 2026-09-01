# AGENTS.md

Notes for anyone — human or agent — picking this up **on a machine that can reach the
network**. The whole project was built in a sandbox whose egress policy blocked every
Sleeper host, ESPN, and the CDN, so a specific set of things could never be checked
here. They are listed below, worst-first, with the exact command to settle each one.

Everything in `bun test` passes offline against `fixtures/` and stays that way. The
open items are all about **live data**, not code correctness.

---

## Context you need

- League `1348178795533701120`, user `tugger_woods` (`434221843767881728`).
- Confirmed live by `bun run doctor` on 2026-09-01: **THE MAIN LEAGUE**, 12 teams,
  snake, 15 rounds, 120s pick timer, `pre_draft`. You are **roster 3, draft slot 9**.
- Scoring is **half PPR with 6-point passing touchdowns** (not the usual 4).
- Roster: `QB, RB, RB, WR, WR, TE, FLEX, FLEX, DEF` + 6 bench. **There is no kicker
  slot.** `fixtures/real-league.json` encodes all of this and
  `test/real-league.test.ts` asserts the engine handles it.

---

## Open items

### 1. Confirm `adp_dd_ppr` is redraft ADP, not something else — HIGH

**Why it matters.** ADP feeds the survival model, VONA, and the "is he falling to
me?" number. When it is wrong the board still renders and every number still looks
reasonable — it just quietly stops answering the question that decides picks.

**What is known.** `doctor` showed `adp_dd_ppr` and `pos_adp_dd_ppr` inside `stats`.
The extractor in `src/data/adp.ts` now finds `adp_dd_ppr` and explicitly refuses
`pos_adp_*` (positional ADP is a different scale — "the 5th running back", not "pick
5" — and feeding it in would be silently catastrophic).

**What is not known.** What `dd` stands for. It is almost certainly Sleeper's own
redraft ADP, but that is inference, not verification. If it turns out to be dynasty
ADP the ordering would be wrong in a way that looks plausible.

```sh
bun run doctor        # now prints every adp key WITH its value, plus a sanity check
```

Sanity check to apply by eye: the consensus 1.01 player should sit near 1–3, and a
round-10 player near 110–120. If `adp_dd_ppr` instead ranks young players far above
their redraft value, it is dynasty ADP — add `dd` to `WRONG_GAME` in
`src/data/adp.ts` and look for another key.

The automated version of that check is `checkAdpSanity()`, which flags a
distribution that never starts near pick 1 or that crowds too many players into the
first round. It cannot detect dynasty-vs-redraft. Only your eyes can.

### 2. Verify how many projection weeks are actually published — MEDIUM

`fetchWeeklyProjections` sums weeks 1–18. Week 1 returned 3303 rows. Whether weeks
2–18 are published this early is unverified.

If only a few weeks exist, summing them under-projects everyone. The code detects
this (fewer than 14 weeks with data) and extrapolates a per-game average to a
17-game season, logging a warning. That path has **never run against real data**.

```sh
bun run sync          # watch for: "[projections] only N of 18 weeks are published"
```

If it warns, spot-check that the top running back lands near 250–320 half-PPR points
rather than 40. If the numbers look like a single week, the extrapolation is broken.

### 3. Confirm projections carry team defenses — MEDIUM

The league starts a DEF and the engine expects to rank them. The bulk projections
call requests `position[]=DEF`, but whether Sleeper returns rows for defenses is
unverified.

```sh
bun run sync && bun run mock --live-league
```

If no DEF appears in any shortlist, defenses fall through to the `search_rank`
fallback, which is workable but coarse. Worth knowing before draft day.

### 4. Run a live dry run — MEDIUM

Everything has been exercised against fixtures and a canned recommendation. The
combination of real projections, real ADP and a real model call has never run
end-to-end.

```sh
bun run sync
bun run news          # optional, ~$0.30-1.00, one time
bun start             # league is pre_draft, so it will sit waiting
```

Open `http://localhost:5173` and press **Refresh** to force one real model call
against the live board. Check: the cards name real players, the numbers on the cards
match the shortlist table, and `Status` shows a non-zero `cache read` on the *second*
refresh. If cache reads stay at zero across refreshes, something upstream is
rewriting the prompt prefix — see `test/prompt.test.ts` for the byte-stability guard.

### 5. Sweep news close to the draft — LOW

`bun run news` caches to `data/news.json` and is **not** re-run automatically. Notes
go stale. Run it the morning of the draft, not days before.

---

## Things already settled — do not redo

`bun run doctor` on 2026-09-01 returned 17 ok, 0 warnings, 0 failures. In particular:

- All documented Sleeper endpoints work.
- The undocumented `api.sleeper.com` host works: bulk projections (3303 rows),
  per-player projections, and the season schedule.
- **All three CDN image paths work**, including `images/team_logos/nfl/{team}.png`,
  which the original plan flagged as probably wrong, and the `thumb/` variant.
- `ANTHROPIC_API_KEY` is set.

`data/capabilities.json` records this and the adapters read it.

---

## How to work on this safely

**Run the simulation and read the output.** Six roster-construction bugs were found
that way, and none would have been caught by a unit test — in every case each
individual number was correct and fifteen rounds of interaction were still wrong
(three quarterbacks in a one-QB league, a kicker in round ten, a draft that finished
with no receivers). `test/draft-integration.test.ts` documents each one.

```sh
bun run mock --verbose
```

If you touch anything in `src/engine/rank.ts`, `roster.ts`, or the value curve in
`projections.ts`, run this and look at the final roster before trusting the tests.

**Do not over-tune against the fixtures.** The synthetic value curve is calibrated to
real half-PPR totals but is smooth where real projections are lumpy. Structural
properties — starters filled, one DEF, no kicker, no backup hoarding — are worth
asserting. Fine positional preferences are not; past a point you are fitting to
invented data.

**Bun gives a server no SSE disconnect signal.** As of 1.3.11 the stream's `cancel`
callback never fires, the request abort signal never aborts, and `enqueue` keeps
succeeding into a dead socket — all three verified directly, not assumed. Liveness is
therefore client-driven via heartbeats and `SubscriberRegistry`. If you rework the
server, do not "simplify" that away; re-verify first.

**The prompt prefix must stay byte-stable.** It carries a 1-hour cache breakpoint and
a single drifting byte makes every request pay full input price with no error
anywhere. `test/prompt.test.ts` guards it. Never interpolate a clock, a pick number,
or anything per-request into `buildStaticPrefix`.

---

## Commands

| Command | What it does |
|---|---|
| `bun run doctor` | Probe every endpoint and CDN path; write `data/capabilities.json` |
| `bun run sync` | Cache players, league, projections, ADP, bye weeks |
| `bun run news` | One-time pre-draft news sweep (costs money) |
| `bun start` | Live draft server at `localhost:5173` |
| `bun run demo` | Real UI against fixtures — no Sleeper, no API key |
| `bun run mock` | Simulate a full 15-round draft in the terminal |
| `bun test` | Full suite, offline |
| `bun run typecheck` | `tsc --noEmit` |
