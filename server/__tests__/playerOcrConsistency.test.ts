/**
 * Tests for the VLM player-OCR consistency guard.
 *
 * Run via:
 *   npx tsx server/__tests__/playerOcrConsistency.test.ts
 */
import assert from 'node:assert/strict';
import { checkPlayerOcrConsistency } from '../playerOcrConsistency';

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

// Allensworth case — the bug that motivated this module.
check('Allensworth: gemini=Dye hallucinated, legacy=Allensworth in OCR → fallback-to-legacy', () => {
  const r = checkPlayerOcrConsistency({
    geminiFirstName: 'Jermaine',
    geminiLastName: 'Dye',
    legacyFirstName: 'Jermaine',
    legacyLastName: 'Allensworth',
    frontOcrText: 'JERMAINE ALLENSWORTH OUTFIELD',
    backOcrText: 'JERMAINE ALLENSWORTH 122 PIRATES JERMAINE ALLENSWORTH',
  });
  assert.equal(r.decision, 'fallback-to-legacy');
  if (r.decision === 'fallback-to-legacy') {
    assert.match(r.reason, /gemini lastName not in OCR/i);
  }
});

check('Happy path: gemini=Trout, OCR has TROUT → gemini-ok', () => {
  const r = checkPlayerOcrConsistency({
    geminiFirstName: 'Mike',
    geminiLastName: 'Trout',
    legacyFirstName: '',
    legacyLastName: '',
    frontOcrText: 'MIKE TROUT ANGELS',
    backOcrText: 'TROUT 27 OUTFIELD',
  });
  assert.equal(r.decision, 'gemini-ok');
});

check('Both missing from OCR (legacy empty) → no-confident-player', () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: 'Dye',
    legacyLastName: '',
    frontOcrText: 'TOPPS BASEBALL 2026',
    backOcrText: 'CARD #50 STATS 2025 SEASON',
  });
  assert.equal(r.decision, 'no-confident-player');
});

check('Both missing from OCR (legacy non-empty but also missing) → no-confident-player', () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: 'Dye',
    legacyLastName: 'Smith',
    frontOcrText: 'TOPPS BASEBALL',
    backOcrText: 'STATS',
  });
  assert.equal(r.decision, 'no-confident-player');
});

check('Substring trap: gemini="Ye", OCR="DYE" (no other context, legacy empty) → no-confident-player (NOT gemini-ok)', () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: 'Ye',
    legacyLastName: '',
    frontOcrText: 'DYE OUTFIELD',
    backOcrText: 'JERMAINE DYE STATS',
  });
  // Word-boundary match: "Ye" must NOT match the substring of "DYE".
  assert.notEqual(r.decision, 'gemini-ok');
  assert.equal(r.decision, 'no-confident-player');
});

check('Substring trap with legacy match: gemini="Ye" miss, legacy="Dye" matches DYE → fallback-to-legacy', () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: 'Ye',
    legacyLastName: 'Dye',
    frontOcrText: 'JERMAINE DYE OUTFIELD',
    backOcrText: 'DYE 23 ATHLETICS',
  });
  assert.equal(r.decision, 'fallback-to-legacy');
});

check('Empty geminiLastName → gemini-ok (nothing to challenge)', () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: '',
    legacyLastName: 'Smith',
    frontOcrText: 'NOTHING HERE',
    backOcrText: '',
  });
  assert.equal(r.decision, 'gemini-ok');
});

check('Null geminiLastName → gemini-ok', () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: null,
    legacyLastName: 'Smith',
    frontOcrText: 'SMITH 5',
    backOcrText: '',
  });
  assert.equal(r.decision, 'gemini-ok');
});

check("Apostrophe normalization: gemini=O'Neill matches OCR 'ONEILL' (apostrophe stripped)", () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: "O'Neill",
    legacyLastName: '',
    frontOcrText: 'PAUL ONEILL YANKEES',
    backOcrText: 'ONEILL 21',
  });
  assert.equal(r.decision, 'gemini-ok');
});

check("Apostrophe normalization (other direction): gemini='ONeill' matches OCR \"O'NEILL\"", () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: 'ONeill',
    legacyLastName: '',
    frontOcrText: "O'NEILL OUTFIELD",
    backOcrText: '',
  });
  assert.equal(r.decision, 'gemini-ok');
});

check('Hyphenated last name: gemini="Smith-Jones", OCR has both SMITH and JONES tokens → gemini-ok', () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: 'Smith-Jones',
    legacyLastName: '',
    frontOcrText: 'BOBBY SMITH JONES INFIELD',
    backOcrText: 'SMITH JONES 14',
  });
  assert.equal(r.decision, 'gemini-ok');
});

check('Hyphenated last name where one segment missing → falls through to legacy/no-confident-player', () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: 'Smith-Jones',
    legacyLastName: '',
    frontOcrText: 'BOBBY SMITH INFIELD',
    backOcrText: 'STATS',
  });
  // Without "JONES" present, the hyphenated lastName cannot match.
  assert.equal(r.decision, 'no-confident-player');
});

check('Case-insensitivity: lowercase gemini lastName, uppercase OCR → gemini-ok', () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: 'trout',
    legacyLastName: '',
    frontOcrText: 'MIKE TROUT',
    backOcrText: '',
  });
  assert.equal(r.decision, 'gemini-ok');
});

check('Mixed punctuation in OCR: commas, periods, slashes do not block match', () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: 'Allensworth',
    legacyLastName: '',
    frontOcrText: 'JERMAINE ALLENSWORTH, OF.',
    backOcrText: '',
  });
  assert.equal(r.decision, 'gemini-ok');
});

check('Same gemini and legacy lastName (both match OCR) → gemini-ok (no fallback)', () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: 'Trout',
    legacyLastName: 'Trout',
    frontOcrText: 'MIKE TROUT',
    backOcrText: '',
  });
  assert.equal(r.decision, 'gemini-ok');
});

check('Legacy equals Gemini but neither in OCR → no-confident-player', () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: 'Smith',
    legacyLastName: 'Smith',
    frontOcrText: 'NOTHING',
    backOcrText: '',
  });
  // Legacy === Gemini after normalization, so the !== guard prevents fallback.
  assert.equal(r.decision, 'no-confident-player');
});

check('Empty OCR text on both sides → no-confident-player when gemini lastName present', () => {
  const r = checkPlayerOcrConsistency({
    geminiLastName: 'Trout',
    legacyLastName: '',
    frontOcrText: '',
    backOcrText: '',
  });
  assert.equal(r.decision, 'no-confident-player');
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nALL OK');
