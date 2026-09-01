/**
 * Which optional data sources actually work.
 *
 * Several of the endpoints this app can use are undocumented and live on a
 * different host from the documented API. They may work perfectly, or 404 without
 * warning. Rather than guess at build time, `bun run doctor` probes them on the
 * machine that will run the draft and writes the result here; the adapters read it
 * and pick their source chain accordingly.
 */

import { readCache, writeCache } from "../sleeper/client.ts";
import { config } from "../config.ts";

export interface Capabilities {
  checkedAt: string;
  /** Bulk weekly projections: /projections/nfl/{season}/{week}?position[]=... */
  bulkProjections: boolean;
  /** Per-player season projections: /projections/nfl/player/{id}?season=... */
  playerProjections: boolean;
  /** Season schedule: /schedule/nfl/regular/{season} */
  schedule: boolean;
  /** Player headshots on the Sleeper CDN. */
  playerPhotos: boolean;
  /** The thumbnail variant of the above. */
  playerPhotoThumbs: boolean;
  /** Team logos — the least corroborated of the CDN paths. */
  teamLogos: boolean;
  /** Whether trending accepts lookback_hours. */
  trending: boolean;
  notes: string[];
}

export const DEFAULT_CAPABILITIES: Capabilities = {
  checkedAt: "never",
  bulkProjections: false,
  playerProjections: false,
  schedule: false,
  playerPhotos: true, // widely reported to work; the UI degrades gracefully anyway
  playerPhotoThumbs: false,
  teamLogos: false,
  trending: true,
  notes: ["doctor has not been run — using conservative defaults"],
};

export async function loadCapabilities(): Promise<Capabilities> {
  return (await readCache<Capabilities>(config.paths.capabilities)) ?? DEFAULT_CAPABILITIES;
}

export async function saveCapabilities(caps: Capabilities): Promise<void> {
  await writeCache(config.paths.capabilities, caps);
}
