/**
 * Player image URLs.
 *
 * Sleeper's CDN paths are undocumented but widely used. We emit a primary and a
 * fallback so the browser can degrade on its own via an `onerror` handler — no
 * server round-trip, and a missing photo never blocks a card from rendering.
 */

import { config } from "../config.ts";
import type { Player } from "../sleeper/types.ts";

export interface PlayerImages {
  primary: string;
  /** Tried if the primary 404s. */
  fallback: string | null;
  /** Initials to render if both fail. */
  initials: string;
}

export function playerImages(player: Pick<Player, "player_id" | "espn_id" | "first_name" | "last_name" | "full_name" | "position">): PlayerImages {
  const isDefense = player.position === "DEF";

  // Team defenses use the player_id as a team abbreviation.
  const primary = isDefense
    ? `${config.sleeper.cdnBase}/images/team_logos/nfl/${player.player_id.toLowerCase()}.png`
    : `${config.sleeper.cdnBase}/content/nfl/players/${player.player_id}.jpg`;

  const fallback =
    !isDefense && player.espn_id
      ? `https://a.espncdn.com/i/headshots/nfl/players/full/${player.espn_id}.png`
      : null;

  return { primary, fallback, initials: initialsFor(player) };
}

export function initialsFor(
  player: Pick<Player, "first_name" | "last_name" | "full_name" | "player_id">,
): string {
  const first = player.first_name?.trim();
  const last = player.last_name?.trim();
  if (first && last) return `${first[0]}${last[0]}`.toUpperCase();

  const full = player.full_name?.trim();
  if (full) {
    const parts = full.split(/\s+/);
    if (parts.length >= 2) return `${parts[0]![0]}${parts.at(-1)![0]}`.toUpperCase();
    return full.slice(0, 2).toUpperCase();
  }
  return player.player_id.slice(0, 3).toUpperCase();
}

export const teamLogo = (team: string): string =>
  `${config.sleeper.cdnBase}/images/team_logos/nfl/${team.toLowerCase()}.png`;
