/**
 * PR U — server tests for stage-1 streaming Gemini.
 *
 * Covers:
 *   1. tryParsePartialJson: tolerant prefix parse for in-flight JSON.
 *   2. diffStage1Fields: emits each newly-completed field exactly once
 *      across a sequence of incremental partial parses.
 *   3. Full simulated chunk sequence: feed prefix-by-prefix, assert
 *      the per-field event order matches Gemini's emit order.
 *   4. Edge cases: extra unknown keys are ignored; mid-string prefixes
 *      do not surface a partial value; empty/whitespace strings are
 *      not emitted.
 */

import assert from 'node:assert/strict';
import {
  diffStage1Fields,
  tryParsePartialJson,
  tryParsePartialJsonWithSafety,
  type Stage1FieldSnapshot,
} from '../partialJson';

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err: any) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err?.message || err);
  }
}

// ── tryParsePartialJson ─────────────────────────────────────────────

check('tryParsePartialJson: empty / non-JSON returns null', () => {
  assert.equal(tryParsePartialJson(''), null);
  assert.equal(tryParsePartialJson('   '), null);
});

check('tryParsePartialJson: complete JSON object', () => {
  const got = tryParsePartialJson('{"year":2026,"brand":"Topps"}');
  assert.deepEqual(got, { year: 2026, brand: 'Topps' });
});

check('tryParsePartialJson: prefix mid-string drops the in-flight key', () => {
  // "Topp" is unterminated — partial parser should NOT surface a brand.
  const got = tryParsePartialJson('{"year":2026,"brand":"Topp');
  // Expected: only the year survives because the brand string wasn't
  // closed yet.
  assert.equal((got as any)?.year, 2026);
  assert.equal((got as any)?.brand, undefined);
});

check('tryParsePartialJson: prefix after completed value emits it', () => {
  // "Topps" closed, then a comma — brand IS available.
  const got = tryParsePartialJson('{"year":2026,"brand":"Topps",');
  assert.equal((got as any)?.year, 2026);
  assert.equal((got as any)?.brand, 'Topps');
});

check('tryParsePartialJson: balances open arrays', () => {
  const got = tryParsePartialJson('{"players":[{"firstName":"Mike","lastName":"Trout"},');
  assert.ok(Array.isArray((got as any)?.players));
  const first = (got as any).players[0];
  assert.equal(first.firstName, 'Mike');
  assert.equal(first.lastName, 'Trout');
});

check('tryParsePartialJson: handles escaped quotes inside strings', () => {
  const got = tryParsePartialJson('{"player":"O\\"Connor",');
  assert.equal((got as any)?.player, 'O"Connor');
});

// ── diffStage1Fields ────────────────────────────────────────────────

check('diffStage1Fields: emits a field once on first completion', () => {
  const prev: Stage1FieldSnapshot = {};
  const { changed, next } = diffStage1Fields(
    { year: 2026, brand: 'Topps' },
    prev,
  );
  assert.equal(changed.year, 2026);
  assert.equal(changed.brand, 'Topps');
  assert.equal(next.year, 2026);
  assert.equal(next.brand, 'Topps');
});

check('diffStage1Fields: re-emit if value changes', () => {
  const prev: Stage1FieldSnapshot = { year: 2025 };
  const { changed } = diffStage1Fields({ year: 2026 }, prev);
  assert.equal(changed.year, 2026);
});

check('diffStage1Fields: same value does not re-emit', () => {
  const prev: Stage1FieldSnapshot = { year: 2026, brand: 'Topps' };
  const { changed } = diffStage1Fields(
    { year: 2026, brand: 'Topps' },
    prev,
  );
  assert.deepEqual(Object.keys(changed), []);
});

check('diffStage1Fields: empty / whitespace strings are skipped', () => {
  const prev: Stage1FieldSnapshot = {};
  const { changed } = diffStage1Fields(
    { brand: '', set: '   ', collection: 'Base Set' } as any,
    prev,
  );
  assert.equal(changed.brand, undefined);
  assert.equal(changed.set, undefined);
  assert.equal(changed.collection, 'Base Set');
});

check('diffStage1Fields: ignores unknown keys (extra keys do not crash)', () => {
  const prev: Stage1FieldSnapshot = {};
  const { changed } = diffStage1Fields(
    {
      year: 2026,
      mysteryNewField: 'wat',
      anotherUnknown: { nested: 'stuff' },
    } as any,
    prev,
  );
  assert.deepEqual(Object.keys(changed).sort(), ['year']);
});

check('diffStage1Fields: non-string types for string fields are ignored', () => {
  const prev: Stage1FieldSnapshot = {};
  const { changed } = diffStage1Fields(
    { brand: 123 as any, set: { foo: 'bar' } as any, year: 'not-a-year' } as any,
    prev,
  );
  // brand/set rejected; year accepts string after trim.
  assert.equal(changed.brand, undefined);
  assert.equal(changed.set, undefined);
  assert.equal(changed.year, 'not-a-year');
});

check('diffStage1Fields: player falls back to players[0] when top-level absent', () => {
  const prev: Stage1FieldSnapshot = {};
  const { changed } = diffStage1Fields(
    { players: [{ firstName: 'Mike', lastName: 'Trout' }] } as any,
    prev,
  );
  assert.equal(changed.player, 'Mike Trout');
});

check('diffStage1Fields: top-level player wins over players[0]', () => {
  const prev: Stage1FieldSnapshot = {};
  const { changed } = diffStage1Fields(
    {
      player: 'Shohei Ohtani',
      players: [{ firstName: 'Mike', lastName: 'Trout' }],
    } as any,
    prev,
  );
  assert.equal(changed.player, 'Shohei Ohtani');
});

// ── Number flicker suppression ──────────────────────────────────────

check('number field: not emitted until terminator seen', () => {
  // Simulate the prefix reaching `{"year":2`, `{"year":20`, etc.
  const states = [
    '{"year":2',
    '{"year":20',
    '{"year":202',
    '{"year":2026',
  ];
  const snapshot: Stage1FieldSnapshot = {};
  const events: any[] = [];
  for (const s of states) {
    const safe = tryParsePartialJsonWithSafety(s);
    if (!safe) continue;
    const { changed, next } = diffStage1Fields(
      safe.parsed,
      snapshot,
      safe.terminated,
    );
    Object.assign(snapshot, next);
    for (const k of Object.keys(changed)) events.push({ k, v: (changed as any)[k] });
  }
  // None of these prefixes are terminated — `year` should NOT have
  // been emitted to avoid `2 → 20 → 202 → 2026` flicker.
  assert.deepEqual(events, [], `expected no events but got ${JSON.stringify(events)}`);
});

check('number field: emitted once after terminator', () => {
  const snapshot: Stage1FieldSnapshot = {};
  const safeBefore = tryParsePartialJsonWithSafety('{"year":2026');
  // Untermianted -> no emit.
  let { changed } = diffStage1Fields(
    safeBefore!.parsed,
    snapshot,
    safeBefore!.terminated,
  );
  assert.deepEqual(Object.keys(changed), []);
  const safeAfter = tryParsePartialJsonWithSafety('{"year":2026,"brand":"Topps"');
  // Year is now followed by a terminator (the comma), brand is open
  // string (incomplete) — but parser has lastSafe>0 because comma
  // was seen — so emit year. brand is suppressed because it is
  // incomplete (not in the parsed object).
  const { changed: changed2, next } = diffStage1Fields(
    safeAfter!.parsed,
    snapshot,
    safeAfter!.terminated,
  );
  Object.assign(snapshot, next);
  assert.equal(changed2.year, 2026);
  assert.equal(changed2.brand, undefined);
});

// ── Simulated chunk sequence ────────────────────────────────────────

check('simulated stream: emits each field exactly once in arrival order', () => {
  // Gemini's actual emit order is not guaranteed. Here we simulate
  // chunks landing as: year first → brand → set → collection →
  // cardNumber → player, with one chunk every few characters.
  const fullText =
    '{"year":2026,"brand":"Topps","set":"Series One","collection":"Base Set","cardNumber":"#100","player":"Mike Trout"}';
  const events: Array<{ field: string; value: any }> = [];
  const snapshot: Stage1FieldSnapshot = {};
  // Walk one character at a time, attempting a parse on each step.
  for (let i = 1; i <= fullText.length; i++) {
    const prefix = fullText.slice(0, i);
    const safe = tryParsePartialJsonWithSafety(prefix);
    if (!safe) continue;
    const { changed, next } = diffStage1Fields(
      safe.parsed,
      snapshot,
      safe.terminated,
    );
    Object.assign(snapshot, next);
    for (const k of Object.keys(changed)) {
      events.push({ field: k, value: (changed as any)[k] });
    }
  }
  // Each of the six fields should appear exactly once.
  const fieldSeq = events.map((e) => e.field);
  assert.deepEqual(
    fieldSeq,
    ['year', 'brand', 'set', 'collection', 'cardNumber', 'player'],
    `expected one event per field in stream order, got ${JSON.stringify(events)}`,
  );
  assert.equal(events.find((e) => e.field === 'year')?.value, 2026);
  assert.equal(events.find((e) => e.field === 'brand')?.value, 'Topps');
  assert.equal(
    events.find((e) => e.field === 'collection')?.value,
    'Base Set',
  );
  assert.equal(events.find((e) => e.field === 'player')?.value, 'Mike Trout');
});

check('simulated stream: out-of-order field emit order matches Gemini order', () => {
  // If Gemini surfaces brand BEFORE year, our diff must emit brand
  // first. The render order in the UI is fixed; the SSE event order
  // tracks Gemini.
  const fullText =
    '{"brand":"Panini","year":2024,"set":"Prizm","collection":"Base Set","cardNumber":"#1","player":"Wembanyama"}';
  const events: string[] = [];
  const snapshot: Stage1FieldSnapshot = {};
  for (let i = 1; i <= fullText.length; i++) {
    const safe = tryParsePartialJsonWithSafety(fullText.slice(0, i));
    if (!safe) continue;
    const { changed, next } = diffStage1Fields(
      safe.parsed,
      snapshot,
      safe.terminated,
    );
    Object.assign(snapshot, next);
    for (const k of Object.keys(changed)) events.push(k);
  }
  // brand fires first because Gemini emitted brand before year.
  assert.equal(events[0], 'brand');
  assert.equal(events[1], 'year');
});

check('simulated stream: drop in mid-call falls back gracefully', () => {
  // Stream cuts off after only 2 fields. Diff emits them; the rest
  // never arrive — no events for the missing fields.
  const partialText = '{"year":2026,"brand":"Topps",';
  const events: string[] = [];
  const snapshot: Stage1FieldSnapshot = {};
  for (let i = 1; i <= partialText.length; i++) {
    const safe = tryParsePartialJsonWithSafety(partialText.slice(0, i));
    if (!safe) continue;
    const { changed, next } = diffStage1Fields(
      safe.parsed,
      snapshot,
      safe.terminated,
    );
    Object.assign(snapshot, next);
    for (const k of Object.keys(changed)) events.push(k);
  }
  assert.deepEqual(events, ['year', 'brand']);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll PR U streaming stage-1 tests passed.');
