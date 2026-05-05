/**
 * Best-effort partial-JSON tolerant parse of an in-flight JSON prefix.
 * Used by streaming Gemini callers (the SSE endpoint and stage-1 OCR
 * progress events) to surface partial fields while the model is still
 * emitting tokens.
 *
 * Returns the parsed object on success, or null when the prefix is too
 * truncated to recover.
 *
 * Strategy: walk the prefix tracking open `{`, `[`, `"` levels. Truncate
 * to the last value-completing boundary outside any open string, then
 * append the closers that would balance any still-open levels. Drops a
 * trailing partial token (comma, colon, or half-finished number/key)
 * before closing so JSON.parse doesn't reject. Best-effort only —
 * callers tolerate null.
 *
 * PR U: extracted from server/routes.ts so the dual-side OCR path can
 * share it without depending on the routes module (avoids the circular
 * import dualSideOCR ← routes ← dualSideOCR).
 */
export function tryParsePartialJson(prefix: string): Record<string, unknown> | null {
  const result = tryParsePartialJsonWithSafety(prefix);
  return result ? result.parsed : null;
}

/**
 * Same as tryParsePartialJson but also returns whether the parsed
 * fields are guaranteed terminated. `terminated=true` means EVERY key
 * in the parsed object had a trailing `,` / `}` / `]` in the source —
 * i.e. its value is fully complete. `terminated=false` means the LAST
 * key in the parse may still be in-flight (most relevant for numeric
 * values: `2` could grow into `2026`, and we must NOT emit until the
 * parser sees a terminator).
 *
 * Implementation note: when `lastSafe > 0` we truncate to that
 * boundary; everything in the result is committed. When `lastSafe ===
 * 0` and the buffer still parsed (because all open brackets balanced
 * naturally), the trailing token may be unterminated — flag it.
 */
export function tryParsePartialJsonWithSafety(
  prefix: string,
): { parsed: Record<string, unknown>; terminated: boolean } | null {
  const stack: Array<'{' | '[' | '"'> = [];
  let lastSafe = 0;
  let i = 0;
  while (i < prefix.length) {
    const c = prefix[i];
    const top = stack[stack.length - 1];
    if (top === '"') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') stack.pop();
      i += 1;
      continue;
    }
    if (c === '"') stack.push('"');
    else if (c === '{') stack.push('{');
    else if (c === '[') stack.push('[');
    else if (c === '}') {
      if (top !== '{') return null;
      stack.pop();
    } else if (c === ']') {
      if (top !== '[') return null;
      stack.pop();
    }
    i += 1;
    if (stack[stack.length - 1] !== '"' && (c === ',' || c === '}' || c === ']')) {
      lastSafe = i;
    }
  }
  const safeBoundary = lastSafe || prefix.length;
  const terminated = lastSafe !== 0;
  let body = prefix.slice(0, safeBoundary).replace(/\s+$/, '');
  const truncStack: Array<'{' | '['> = [];
  let inStr = false;
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (inStr) {
      if (c === '\\') {
        j += 1;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') truncStack.push('{');
    else if (c === '[') truncStack.push('[');
    else if (c === '}') truncStack.pop();
    else if (c === ']') truncStack.pop();
  }
  if (body.endsWith(',')) body = body.slice(0, -1);
  let closers = '';
  for (let k = truncStack.length - 1; k >= 0; k--) {
    closers += truncStack[k] === '{' ? '}' : ']';
  }
  try {
    const parsed = JSON.parse(body + closers) as Record<string, unknown>;
    return { parsed, terminated };
  } catch {
    return null;
  }
}

/**
 * The six card-info fields the stage-1 ScanInfoHeader displays. Used by
 * the streaming progress emitter to know which keys to lift out of a
 * partially-parsed Gemini JSON blob.
 */
export const STAGE1_FIELD_KEYS = [
  'year',
  'brand',
  'set',
  'collection',
  'cardNumber',
  'player',
  // PR X: surface the verbatim printed year ("2024-25") to the client
  // so the streaming ScanInfoHeader can render YYYY-YY for season
  // sports as soon as Gemini emits it. Not displayed standalone — the
  // header pairs it with `year` + `sport` (via displayYear).
  'yearPrintedRaw',
  // PR X: needed alongside yearPrintedRaw so displayYear() on the
  // client knows whether to render the season range or the integer.
  'sport',
] as const;

export type Stage1FieldKey = (typeof STAGE1_FIELD_KEYS)[number];

export interface Stage1FieldSnapshot {
  year?: number | string | null;
  brand?: string | null;
  set?: string | null;
  collection?: string | null;
  cardNumber?: string | null;
  player?: string | null;
  yearPrintedRaw?: string | null;
  sport?: string | null;
}

/**
 * Diff a freshly-parsed partial JSON object against the previously
 * emitted snapshot. Returns the subset of stage-1 keys whose values are
 * NEW or CHANGED in the new parse and pass the "fully complete" gate
 * (non-empty after trim, not an in-flight partial like "Mich").
 *
 * The stream emits ONLY when a field is fully complete — i.e., when its
 * closing quote (string fields) or numeric terminator (year) has been
 * seen. For string fields, "Mich" arrives in the buffer as `"Mich`
 * (unterminated, so tryParsePartialJson drops it) until the closing
 * `"` lands. For numeric fields like `year`, the partial parser will
 * happily return `2` for prefix `{"year":2` even though the model is
 * actually emitting `2026` — so the caller must pass `terminated`
 * (from tryParsePartialJsonWithSafety): when false, we suppress the
 * LAST key in iteration order because Gemini may still be writing it.
 *
 * For multi-player cards Gemini emits a `players[]` array AND a
 * top-level `player` string mirror. We only watch the `player` mirror
 * — the array has its own life cycle and isn't displayed in the
 * header.
 */
export function diffStage1Fields(
  parsed: Record<string, unknown>,
  prev: Stage1FieldSnapshot,
  terminated = true,
): { changed: Partial<Stage1FieldSnapshot>; next: Stage1FieldSnapshot } {
  // When the parse boundary is unterminated, Gemini may still be
  // writing the LAST key. Drop it from consideration so a number like
  // `year=2` doesn't flicker through to `year=2026`. String fields are
  // safe (the partial parser already requires the closing quote), but
  // we apply the same rule uniformly — the next partial parse will
  // pick the field up the moment its terminator lands.
  if (!terminated) {
    const keys = Object.keys(parsed);
    if (keys.length > 0) {
      const lastKey = keys[keys.length - 1];
      // Mutate-safe: shallow-clone and drop the last key.
      const filtered: Record<string, unknown> = { ...parsed };
      delete filtered[lastKey];
      parsed = filtered;
    }
  }
  const next: Stage1FieldSnapshot = { ...prev };
  const changed: Partial<Stage1FieldSnapshot> = {};

  // YEAR — accept number or string, must be non-empty/finite.
  if ('year' in parsed) {
    const v = parsed.year;
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (next.year !== v) {
        next.year = v;
        changed.year = v;
      }
    } else if (typeof v === 'string' && v.trim()) {
      const t = v.trim();
      if (next.year !== t) {
        next.year = t;
        changed.year = t;
      }
    }
  }

  // String fields. Empty / whitespace-only are skipped — we wait for
  // the model to emit a real value.
  for (const key of ['brand', 'set', 'collection', 'cardNumber', 'yearPrintedRaw', 'sport'] as const) {
    if (key in parsed) {
      const v = parsed[key];
      if (typeof v === 'string' && v.trim()) {
        const t = v.trim();
        if (next[key] !== t) {
          next[key] = t;
          changed[key] = t;
        }
      }
    }
  }

  // PLAYER — Gemini's prompt emits the top-level `player` as the
  // canonical display name. Some responses populate `players[0]` first
  // (multi-player path) — fall through to that as a backup so the
  // header can fill before the mirror lands.
  let playerCandidate: string | null = null;
  const topPlayer = parsed.player;
  if (typeof topPlayer === 'string' && topPlayer.trim()) {
    playerCandidate = topPlayer.trim();
  } else if (Array.isArray((parsed as any).players)) {
    const first = (parsed as any).players[0];
    if (first && typeof first === 'object') {
      const fn = typeof first.firstName === 'string' ? first.firstName.trim() : '';
      const ln = typeof first.lastName === 'string' ? first.lastName.trim() : '';
      const combined = [fn, ln].filter(Boolean).join(' ').trim();
      if (combined) playerCandidate = combined;
    }
  }
  if (playerCandidate && next.player !== playerCandidate) {
    next.player = playerCandidate;
    changed.player = playerCandidate;
  }

  return { changed, next };
}
