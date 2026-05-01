/**
 * Multi-player card support.
 *
 * Vintage Topps subsets (1971 N.L. Strikeout Leaders, 1968 Batting Leaders,
 * 1968 Pitching Leaders, 1968 Rookie Stars, 1969 Strikeout Leaders, 1967 ERA
 * Leaders, Manager's Dream, Super Stars) print 2–3 named players on a single
 * card. The persisted DB columns (`playerFirstName`/`playerLastName`) still
 * carry the *primary* player so existing readers keep working, but a richer
 * `players: Player[]` array travels alongside on the form-values shape and
 * downstream Sheet writes so the user can capture every named player.
 *
 * Invariant: `players[0]` is always the primary player and matches the
 * legacy single-name fields. `joinPlayerNames(players, key)` produces the
 * " / "-joined cell value used in the Sheet (e.g. first names
 * "Tom / Ferguson / Bill", last names "Seaver / Jenkins / Niekro").
 */

import { z } from 'zod';

export interface Player {
  firstName: string;
  lastName: string;
  /**
   * Optional inline role/position printed next to the name on the card
   * (OUTFIELDER, PITCHER, MANAGER, etc.). Blank unless the card itself
   * shows a label — VLM extraction is conservative here.
   */
  role?: string;
}

export const playerSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  role: z.string().optional().nullable(),
});

/** Zod schema for a non-empty `players` list. Used by both card form
 *  validation and the VLM apply path. */
export const playersSchema = z.array(playerSchema).min(1);

/**
 * Return the canonical primary player. `players[0]` if present and the list
 * is non-empty, otherwise an empty placeholder so callers don't have to
 * branch on undefined. Use this anywhere a single headline name is needed
 * (MOLO, sort, default UI title).
 */
export function primaryPlayer(players: Player[] | null | undefined): Player {
  if (players && players.length > 0) return players[0];
  return { firstName: '', lastName: '' };
}

const NAME_DELIMITER = ' / ';

/**
 * Join one field across every player with " / " — the Sheet cell format the
 * user agreed on (e.g. firstName join → "Tom / Ferguson / Bill"). Trims each
 * value, drops empties so a half-filled second slot doesn't produce a
 * trailing " / ".
 */
export function joinPlayerNames(
  players: Player[] | null | undefined,
  key: 'firstName' | 'lastName',
): string {
  if (!players || players.length === 0) return '';
  return players
    .map((p) => (p[key] ?? '').trim())
    .filter((v) => v.length > 0)
    .join(NAME_DELIMITER);
}

/**
 * Coerce legacy single-name fields into a 1-element `players` list. Used at
 * read boundaries (DB rows, older VLM responses, single-card append API)
 * where the source only carries `playerFirstName`/`playerLastName`. Callers
 * pass empty strings when a field is missing — the resulting list is still
 * length 1 so primaryPlayer / joinPlayerNames behave consistently.
 */
export function playersFromLegacy(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): Player[] {
  return [{ firstName: (firstName ?? '').trim(), lastName: (lastName ?? '').trim() }];
}

/**
 * Inverse of playersFromLegacy: when writing back to DB columns or older
 * APIs, pull the primary player out of the array. Caller decides how to
 * handle the rest (joined cell for Sheets, dropped for legacy DB).
 */
export function legacyFromPlayers(players: Player[] | null | undefined): {
  firstName: string;
  lastName: string;
} {
  const p = primaryPlayer(players);
  return { firstName: p.firstName, lastName: p.lastName };
}
