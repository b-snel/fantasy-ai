/**
 * Positional tiers.
 *
 * Tiers matter more than ranks during a draft. The difference between WR8 and WR9
 * is usually noise; the difference between the last player in a tier and the first
 * player in the next one is the whole game. "Two left in this tier" is the single
 * most actionable thing a draft assistant can tell you.
 */

export interface TierAssignment {
  /** 1-indexed tier within the position. */
  tier: number;
  /** How far this player is above the best player in the next tier down. */
  cliffBelow: number;
}

export interface TieredPlayer {
  playerId: string;
  position: string;
  points: number;
}

/**
 * Gap-based tiering: walk a position's players in descending order and start a new
 * tier whenever the drop to the next player exceeds the position's threshold.
 *
 * Simple beats clever here — k-means style clustering produces prettier boundaries
 * and no better decisions, and this stays trivially explainable to the model.
 */
/**
 * Largest a tier may get before it is split.
 *
 * A pure gap rule produces one-player tiers where the curve is steep and enormous
 * ones where it is flat - "159 left in WR tier 1" is technically true and tells you
 * nothing. A tier is only useful as a decision aid if its size is comprehensible,
 * so a run of near-identical players is broken into chunks.
 */
const MAX_TIER_SIZE = 8;

export function assignTiers(
  players: TieredPlayer[],
  gapByPosition: Record<string, number>,
  defaultGap: number,
  maxTierSize = MAX_TIER_SIZE,
): Map<string, TierAssignment> {
  const out = new Map<string, TierAssignment>();
  const byPosition = new Map<string, TieredPlayer[]>();

  for (const p of players) {
    const list = byPosition.get(p.position);
    if (list) list.push(p);
    else byPosition.set(p.position, [p]);
  }

  for (const [position, group] of byPosition) {
    // Sort descending by points; ties broken by id so tiering is deterministic.
    const sorted = [...group].sort(
      (a, b) => b.points - a.points || a.playerId.localeCompare(b.playerId),
    );
    const threshold = gapByPosition[position] ?? defaultGap;

    let tier = 1;
    let sizeOfCurrentTier = 0;

    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i]!;
      const next = sorted[i + 1];
      const cliffBelow = next ? current.points - next.points : 0;

      out.set(current.playerId, { tier, cliffBelow: round2(cliffBelow) });
      sizeOfCurrentTier++;

      if (!next) continue;
      if (cliffBelow > threshold || sizeOfCurrentTier >= maxTierSize) {
        tier++;
        sizeOfCurrentTier = 0;
      }
    }
  }

  return out;
}

/** How many players remain in each (position, tier) among those still available. */
export function tierCounts(
  available: TieredPlayer[],
  tiers: Map<string, TierAssignment>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of available) {
    const t = tiers.get(p.playerId);
    if (!t) continue;
    const key = `${p.position}:${t.tier}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
