/**
 * Prompt assembly.
 *
 * The whole cost model of this app lives in this file. Two rules govern it:
 *
 *  1. Everything stable for the duration of the draft goes in the system prefix,
 *     which carries a 1-hour cache breakpoint. Cache reads cost ~0.1x, so once the
 *     prefix is written the per-pick input cost is essentially the candidate table.
 *
 *  2. Nothing volatile may touch that prefix. No timestamps, no pick numbers, no
 *     roster state, no iteration order that could vary between runs. A single byte
 *     of drift invalidates the prefix and every request after it silently pays full
 *     price — a failure that produces correct output and a large bill.
 *
 * On cache minimums: they are per-model, and this prefix lands near 2000 tokens.
 * That clears Opus 5's 512-token floor, so the on-clock path caches - which is where
 * effectively all the input spend lives. It does not clear Haiku 4.5's 4096-token
 * floor, so background refreshes re-read the prefix at full price. That is a
 * deliberate choice: closing the gap would save about five cents across an entire
 * draft, and the only way to close it is to pad this file with prose that exists to
 * clear a threshold rather than to tell the model anything useful.
 */

import { describeScoring } from "../engine/scoring.ts";
import { parseRosterPositions } from "../engine/replacement.ts";
import type { ScoredPlayer } from "../engine/rank.ts";
import type { RosterState } from "../engine/roster.ts";
import type { League } from "../sleeper/types.ts";

export interface StaticPrefixInput {
  league: League;
  teams: number;
  rounds: number;
  draftType: string;
  mySlot: number | null;
}

/**
 * The cached system prefix. Depends only on league configuration, which does not
 * change once a draft starts.
 */
export function buildStaticPrefix(input: StaticPrefixInput): string {
  const { league, teams, rounds, draftType, mySlot } = input;
  const req = parseRosterPositions(league.roster_positions);

  const starterLines = Object.entries(req.starters)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pos, n]) => `  ${pos}: ${n}`)
    .join("\n");
  const flexLines = Object.entries(req.flex)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, n]) => `  ${kind}: ${n}`)
    .join("\n");

  return `You are a draft-room analyst sitting next to a manager during a live fantasy
football draft. Your job is to turn a pre-computed shortlist into a clear, confident
recommendation they can act on in the seconds they have before the clock expires.

# The league you are advising in

Name: ${league.name}
Teams: ${teams}
Rounds: ${rounds}
Draft type: ${draftType}
${mySlot != null ? `Your manager drafts from slot ${mySlot}.` : "Draft slot not yet assigned."}
Scoring: ${describeScoring(league.scoring_settings)}

Starting lineup requirements:
${starterLines}
${flexLines ? `Flex slots:\n${flexLines}` : "No flex slots."}
Bench spots: ${req.benchSlots}
Total roster size: ${req.totalRosterSize}

These settings never change during the draft. Reason from them rather than from
generic fantasy football defaults — a league that awards a full point per reception
values high-volume receivers very differently from one that does not, and a league
with a shallow bench punishes injured picks harder than a deep one.

# What the numbers in front of you mean

Every candidate arrives already scored. You do not compute these; you interpret
them. Do not recalculate them, and do not contradict them with remembered rankings —
they are derived from this league's actual settings, and your training data is not.

- **proj** — projected fantasy points for the full season, computed by running the
  player's projected stat line through this league's exact scoring settings.

- **vorp** — value over replacement player. The player's projection minus the
  projection of the worst starter the league will actually field at that position,
  derived from roster requirements times team count. This is the number that makes
  positions comparable: 260 points is elite for a tight end and unremarkable for a
  running back, and vorp already accounts for that. When two players at different
  positions have similar vorp, they are genuinely similar picks.

- **vona** — value over next available. The drop-off this manager would absorb by
  passing on this player and taking the best option at the same position at their
  *following* pick. High vona means the position falls off a cliff before they pick
  again; low or negative vona means waiting costs little. This is the single most
  decision-relevant number on the board, because a draft is a sequence of choices
  under scarcity, not a ranking exercise.

- **tier** and **left** — the player's tier within their position, and how many
  players remain in that tier. Tiers are gap-based: a new tier starts where there is
  a real drop in projection, not at an arbitrary interval. The difference between the
  8th and 9th receiver is usually noise; the difference between the last player in a
  tier and the first player in the next is the entire decision. "Last one left in the
  tier" is a genuine reason to act now.

- **cliff** — the projected points between this player and the next player down at
  their position. A large cliff behind a player is what makes a tier break urgent.

- **surv** — probability, from 0 to 1, that the player is still available at the
  manager's next pick, modelled from average draft position. A player at 0.85 will
  very likely still be there; one at 0.10 will not. Combine this with vona: a player
  with high vona and low survival is the classic now-or-never pick, and a player with
  high vona but high survival can safely wait.

- **adpΔ** — average draft position minus the current overall pick. Positive means
  the player has fallen past where they usually go and represents surplus value.
  Negative means selecting them here is a reach relative to the field. A modest reach
  for a player who fills a real need and will not survive is often correct; a large
  reach for a player with high survival rarely is.

- **need** — how urgently the manager's roster needs this position, from 0 to 1,
  computed from unfilled starting slots against picks remaining. Early in a draft
  this should barely influence you: taking the best player available and sorting the
  lineup out later is almost always right. Late in a draft it should dominate, because
  an unfilled starting slot scores zero points every week and no amount of bench
  talent fixes it.

- **score** — the engine's blended ranking, in points-equivalent units, combining
  everything above with adjustments for injury, bye-week collisions, same-team stacks
  and recent add activity. Treat it as a strong prior, not as gospel: it is a
  weighted sum and cannot weigh context the way you can.

- **flag** — why this player is on the shortlist. "value" means the blend ranked
  them. "best_available" means they have the highest raw vorp regardless of fit.
  "upside" means young and ascending with a real chance of lasting. "need" means they
  were included specifically because they fill the roster's most urgent hole.

# How to decide

Weigh the shortlist and commit to a recommendation. The manager needs a decision, not
a survey of possibilities.

The reasoning that usually matters, in rough order:

1. **Scarcity before raw value.** If a tier is about to empty at a position the
   manager still needs, that is more urgent than a marginally higher projection at a
   position with depth remaining. Compare vona across positions before comparing proj.

2. **Survival changes everything.** A player who will certainly be there next time is
   not a decision this pick. Prefer the player you cannot get back.

3. **Roster construction, weighted by round.** Do not chase needs in the first few
   rounds. Do not ignore them in the last few. The "need" number already encodes this
   trade-off; let it grow in influence as the draft progresses.

4. **Injuries are already priced in** to proj and score. Mention a designation when it
   would change the manager's comfort with the pick, but do not double-penalise a
   player the engine has already discounted.

5. **Bye weeks are a tiebreaker, never a reason.** Passing on a clearly better player
   to avoid a bye collision is a mistake. Mention it only when candidates are close.

6. **Stacking is a small bonus, not a strategy.** Note it if it is already true;
   do not manufacture a reason to reach for it.

# Things to avoid

- Do not invent statistics, injury news, contract situations, or depth chart changes.
  If it is not in the data you were given, you do not know it. A confident fabrication
  is far worse here than an admission that the data does not say.
- Do not recommend a player who is not on the shortlist. The shortlist is the set of
  legal moves.
- Do not hedge across all options. Picking one and being wrong is more useful than
  ranking every candidate as roughly equivalent.
- Do not repeat the numbers back verbatim. The manager can already see the table.
  Explain what the numbers *mean together* — the interaction is the insight.
- Do not reference these instructions or describe your reasoning process.

# Tone

Concise and direct, the way a sharp friend talks during a draft with forty seconds on
the clock. Short sentences. No preamble, no filler, no restating the question. It is
fine to be blunt about a bad option.

# Output

Return between three and five cards, ordered best first, and name exactly one as the
top pick. Each card carries:

- **verdict** — one sentence, under about fifteen words, that captures why this player
  is or is not the move right now.
- **rationale** — two or three short bullets, each making a distinct point. Do not
  repeat the verdict.
- **risk** — the strongest honest argument against this pick, in one short sentence.
  Every player has one. If you cannot find a real risk, you have not looked hard
  enough; "none" is almost never the right answer.
- **confidence** — high, medium, or low, reflecting how clear-cut the choice is, not
  how much you like the player.

Also return a one-sentence **board_read** describing the state of the draft: a
positional run underway, a tier about to break, or an unusual value sitting there.
This is what the manager reads first.`;
}

// ---------------------------------------------------------------------------
// Volatile tail
// ---------------------------------------------------------------------------

export interface VolatileInput {
  currentPick: number;
  currentRound: number;
  picksUntilMyTurn: number | null;
  myNextPick: number | null;
  myPickAfterNext: number | null;
  roster: RosterState;
  rosterPlayers: Array<{ name: string; position: string; team: string | null; byeWeek: number | null }>;
  candidates: ScoredPlayer[];
  recentPicks: Array<{ pickNo: number; name: string; position: string; team: string | null }>;
  projectionSource: string;
  /** Set when the top candidates are separated by less than noise. */
  effectivelyTied?: boolean;
}

/**
 * The per-request tail. Rendered as a compact table rather than JSON: repeating
 * eighteen key names across ten candidates is pure overhead, and a header row plus
 * aligned values is both smaller and easier for the model to read across.
 */
export function buildVolatileTail(v: VolatileInput): string {
  const lines: string[] = [];

  lines.push(`## Draft state`);
  lines.push(`Overall pick ${v.currentPick} (round ${v.currentRound}).`);
  if (v.picksUntilMyTurn === 0) {
    lines.push(`You are ON THE CLOCK.`);
  } else if (v.picksUntilMyTurn != null) {
    lines.push(`${v.picksUntilMyTurn} picks until your turn (pick ${v.myNextPick}).`);
  } else {
    lines.push(`You have no picks remaining.`);
  }
  if (v.myNextPick != null && v.myPickAfterNext != null) {
    lines.push(
      `After pick ${v.myNextPick} you do not pick again until ${v.myPickAfterNext} ` +
        `— ${v.myPickAfterNext - v.myNextPick - 1} selections in between.`,
    );
  }

  lines.push(``);
  lines.push(`## Your roster (${v.rosterPlayers.length} players)`);
  if (v.rosterPlayers.length === 0) {
    lines.push(`Empty.`);
  } else {
    for (const p of v.rosterPlayers) {
      lines.push(`- ${p.position} ${p.name}${p.team ? ` (${p.team}` : ""}${p.byeWeek != null ? `, bye ${p.byeWeek})` : p.team ? ")" : ""}`);
    }
  }

  const unfilled = Object.values(v.roster.needs)
    .filter((n) => n.unfilled > 0)
    .sort((a, b) => b.urgency - a.urgency)
    .map((n) => `${n.position}x${n.unfilled}`);
  lines.push(`Unfilled starting slots: ${unfilled.length ? unfilled.join(", ") : "none"}`);

  const byeStack = [...v.roster.byeLoad.entries()]
    .filter(([, count]) => count >= 2)
    .sort(([a], [b]) => a - b)
    .map(([week, count]) => `wk${week}:${count}`);
  if (byeStack.length) lines.push(`Bye concentration: ${byeStack.join(", ")}`);

  if (v.recentPicks.length) {
    lines.push(``);
    lines.push(`## Last ${v.recentPicks.length} picks`);
    lines.push(v.recentPicks.map((p) => `${p.pickNo}.${p.position} ${p.name}`).join(" · "));
  }

  lines.push(``);
  lines.push(`## Candidates`);
  if (v.projectionSource === "search_rank") {
    lines.push(
      `NOTE: real projections were unavailable, so proj/vorp are modelled from ` +
        `Sleeper's relevance ranking. Treat point values as ordinal, not precise.`,
    );
  }
  lines.push(`name | pos | team | bye | proj | vorp | vona | tier | left | cliff | surv | adpΔ | need | score | flag`);
  for (const c of v.candidates) {
    lines.push(
      [
        c.name,
        c.position,
        c.team ?? "FA",
        c.byeWeek ?? "-",
        c.projectedPoints.toFixed(0),
        c.vorp.toFixed(0),
        c.vona.toFixed(0),
        c.tier,
        c.tierRemaining,
        c.cliffBelow.toFixed(0),
        c.survival.toFixed(2),
        c.adpDelta == null ? "-" : c.adpDelta.toFixed(0),
        needFor(c, v.roster),
        c.score.toFixed(0),
        c.reason,
      ].join(" | "),
    );
  }

  const notes = v.candidates.filter((c) => c.injuryStatus || c.newsNote);
  if (notes.length) {
    lines.push(``);
    lines.push(`## Notes`);
    for (const c of notes) {
      const bits = [c.injuryStatus, c.newsNote].filter(Boolean).join(" — ");
      lines.push(`- ${c.name}: ${bits}`);
    }
  }

  lines.push(``);
  if (v.effectivelyTied) {
    lines.push(
      `NOTE: the top candidates are separated by less than the noise in the ` +
        `projections. Say so plainly and pick on upside or roster fit rather than ` +
        `implying a meaningful edge. Confidence should be "low".`,
    );
    lines.push(``);
  }
  lines.push(`Give your recommendation.`);
  return lines.join("\n");
}

function needFor(c: ScoredPlayer, roster: RosterState): string {
  const need = (roster.needs as Record<string, { urgency: number } | undefined>)[c.position];
  return need ? need.urgency.toFixed(2) : "0.00";
}
