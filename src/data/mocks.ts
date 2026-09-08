/**
 * Locally remembered mock drafts.
 *
 * Sleeper has no endpoint that lists a user's mock drafts: the documented
 * /user/{id}/drafts/nfl/{season} returns league drafts only, and every plausible
 * mock-listing URL 404s (probed live 2026-09-01). So mocks are remembered here -
 * pasted onto the home page, or registered automatically when a session opens
 * one. League drafts never belong in this file; they are discoverable.
 */

import { config } from "../config.ts";

export async function listMockIds(path: string = config.paths.mocks): Promise<string[]> {
  try {
    const raw: unknown = await Bun.file(path).json();
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    // Missing or unreadable file just means nothing registered yet.
    return [];
  }
}

export async function registerMock(draftId: string, path: string = config.paths.mocks): Promise<void> {
  const ids = await listMockIds(path);
  if (ids.includes(draftId)) return;
  // Newest first - that is the order the home page wants them in.
  await Bun.write(path, JSON.stringify([draftId, ...ids], null, 2));
}

export async function unregisterMock(draftId: string, path: string = config.paths.mocks): Promise<void> {
  const ids = await listMockIds(path);
  const next = ids.filter((id) => id !== draftId);
  if (next.length !== ids.length) await Bun.write(path, JSON.stringify(next, null, 2));
}

/**
 * Pull a Sleeper draft id out of whatever the user pasted - a bare id, or a URL
 * like https://sleeper.com/draft/nfl/1400652160391249920?ftue=commish.
 */
export function parseDraftId(input: string): string | null {
  const m = input.match(/\d{15,20}/);
  return m ? m[0] : null;
}
