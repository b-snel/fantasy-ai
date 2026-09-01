# Sleeper Draft Assistant

A live draft assistant for Sleeper fantasy football. It follows your draft in real
time, tracks who is gone and what your roster still needs, and puts three to five
recommendation cards in front of you with a reason for each.

The value math runs in TypeScript. The model gets a shortlist of about ten
pre-scored candidates and writes the cards — it never sees the player pool, which is
both why this is cheap to run and why the numbers are reproducible instead of
imagined.

Built for league `1348178795533701120`, user `tugger_woods`.

---

## Quick start

```sh
# 1. Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash

# 2. Install and configure
bun install
cp .env.example .env      # then add your ANTHROPIC_API_KEY

# 3. Check what actually works from your machine  <-- do this first
bun run doctor

# 4. Pull player data, projections, ADP
bun run sync

# 5. On draft day
bun start                 # then open http://localhost:5173
```

**Run `bun run doctor` before anything else.** It probes every endpoint and image
path, prints what works, and writes `data/capabilities.json`, which the data
adapters read to pick their source chain. Several of the endpoints this app can use
are undocumented and were never verifiable from the environment it was built in — 
doctor is what turns those assumptions into facts on the machine that matters.

---

## Commands

| Command | What it does |
|---|---|
| `bun run doctor` | Probe every endpoint and CDN path; write `data/capabilities.json` |
| `bun run sync` | Cache players, league, projections, ADP, bye weeks |
| `bun run news` | One-time pre-draft news sweep over the top ~150 players |
| `bun start` | The live draft server at `localhost:5173` |
| `bun run demo` | The real UI against fixture data — no Sleeper, no API key |
| `bun run mock` | Simulate a full 15-round draft in the terminal |
| `bun run mock --llm` | Same, and call the model at your first three picks |
| `bun test` | 171 tests, all offline |
| `bun run typecheck` | `tsc --noEmit` |

`bun run demo --advance` steps a pick every few seconds if you want to watch the UI
update. `bun run mock --verbose` prints a deeper board at each of your picks.
`bun run news --limit=200` widens the sweep.

### The Ask box

The side panel takes free-form questions — "best available or fill my flex?", "who's
left at tight end?", "compare these two". That path runs an agentic tool loop over
the same engine functions the pipeline calls, so the numbers it quotes are the
numbers on the cards rather than a second, driftable code path.

The split is deliberate. Recommendations know exactly what data they need, so they
compute a shortlist and make one structured call. A free-form question has no fixed
data requirement — the model has to decide what to look at — and that is the case a
tool loop is actually for. It is slower and pricier per answer, which is why it sits
behind a button rather than firing on its own.

---

## How it decides

Every candidate is scored before the model sees it:

- **VORP** — projection minus the worst starter the league will actually field at
  that position, derived from `roster_positions` × team count. This is what makes
  positions comparable.
- **VONA** — value over the player you would get at that position at your *following*
  pick, using an ADP-based survival model. The most decision-relevant number on the
  board, because a draft is a sequence of choices under scarcity.
- **Tiers** — gap-based, capped in size so "3 left in this tier" stays meaningful.
- **Roster need** — unfilled starting slots weighted against picks remaining. Quiet
  early, dominant late.
- **Marginal value** — how much of a player's value accrues to *your* roster. A
  backup at a covered position is discounted; kickers and defenses are suppressed
  until the endgame, because they are streamable and their spread is ~30 points.
- **Adjustments** — injury designation, practice participation, bye-week collisions,
  same-team stacks, recent add activity.

Projections are multiplied through your league's own `scoring_settings`, so PPR,
half-PPR and TE premium are handled automatically rather than configured.

The engine also measures **decisiveness**. Separation at the top of the board runs to
hundreds of points in round one and collapses to about two by round fourteen. When
the leaders are within noise, the UI says so and the model is told to stop
manufacturing a rationale.

---

## Cost

Roughly **$1–2 for a full draft**. Actual spend is logged per call from
`response.usage` and shown in the UI, so you can check rather than trust the
estimate.

Four things keep it there:

1. **The model never sees the player pool** — ten pre-scored candidates instead of
   several hundred players. This is the whole game; everything else is a rounding
   adjustment next to it.
2. **A 1-hour cache TTL on the system prefix.** Gaps between your picks in a 12-team
   snake run 15–20 minutes, which outlives the 5-minute default. This is the specific
   case where the doubled write cost repays itself.
3. **Trigger discipline.** The engine recomputes on every 2-second poll because that
   is free. The model is called only when you are within three picks (Opus 5), when
   the top of the board changed and you are within eight (Haiku 4.5), or when you hit
   refresh. Identical board states are served from cache without a call.
4. **News as a one-time pre-draft sweep**, not a lookup per pick.

On cache minimums: they are per-model, and the prefix here is ~2000 tokens. That
clears Opus 5's 512-token floor so the on-clock path caches, and misses Haiku 4.5's
4096-token floor so background refreshes do not. Closing that gap would save about
five cents across a whole draft and would mean padding the prompt with prose written
to clear a threshold rather than to say anything, so the gap stays.

---

## Data sources

The documented Sleeper API (`api.sleeper.app/v1`) carries the league, draft, picks,
rosters and player dump. It is read-only, needs no auth, and asks that you stay under
1000 calls/min — polling picks every 2s uses about 30.

Projections, ADP and the schedule come from `api.sleeper.com` (note: `.com`, not
`.app`), which is **undocumented**. Sleeper has said these endpoints are not meant
for consumers, may be blocked at any time, and carry third-party data licensing. So
every one of them sits behind an adapter with a fallback chain that bottoms out at
`search_rank` from the official player dump:

| Need | Primary | Fallback |
|---|---|---|
| Projections | `api.sleeper.com/projections/nfl/{season}/{week}` | `search_rank` through a calibrated value curve |
| ADP | ADP fields in the projections payload | `search_rank` ordering |
| Bye weeks | `api.sleeper.com/schedule/nfl/regular/{season}` | none — byes become a no-op |

If the undocumented host disappears the morning of your draft, the app gets worse,
not broken. The UI shows a banner when it is running on the fallback so you know the
point values are approximate.

**Live updates are polled, not pushed.** Sleeper documents no push mechanism; an
internal Phoenix-channel WebSocket exists but has no stable public contract and no
maintained client. Polling `/picks` at 2s is what every working open-source draft
tool does.

---

## Notes for whoever works on this next

**This was built somewhere it could not run.** The development sandbox's egress
policy blocked every Sleeper host, ESPN, and the CDN. Nothing here may depend on the
network to be verified — the whole suite runs offline against `fixtures/`, and
`bun run demo` drives the real UI with the real renderer against fixture data.

**The interesting bugs were emergent, not local.** Six roster-construction bugs came
out of running `bun run mock` and reading the output; in each case every individual
number was correct and the fifteen-round behaviour was still wrong — three
quarterbacks in a one-QB league, a kicker in round ten, five kickers, a draft that
finished without a receiver. `test/draft-integration.test.ts` documents each one and
guards against its return. If you change the scoring blend, run the simulation and
read the roster it builds. The unit tests will not catch this class of thing.

**Bun gives a server no SSE disconnect signal.** As of 1.3.11 the stream's `cancel`
callback never fires, the request abort signal never aborts, and `enqueue` keeps
succeeding into a dead socket — all three verified directly. Since EventSource
reconnects itself on every hiccup, liveness has to be client-driven: each stream
carries an id, the page heartbeats against it, and `SubscriberRegistry` reaps
anything that stops beating.

**Tuning against synthetic fixtures has a floor.** The fixture value curve is
calibrated against real PPR season totals, but it is still smooth where real
projections are lumpy. Structural properties (starters filled, one K, one DEF, no
backup hoarding) are worth asserting; fine positional preferences are not — past a
point you are fitting to invented data.
