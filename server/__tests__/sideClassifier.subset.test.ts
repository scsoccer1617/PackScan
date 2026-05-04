/**
 * Tests for the vintage subset/leaderboard back signal added to
 * `server/bulkScan/sideClassifier.ts`. Run via:
 *
 *   npx tsx server/__tests__/sideClassifier.subset.test.ts
 *
 * Covers the failure mode from the side-detection audit on bulk-40-1073:
 * leaderboard backs that carry no stat-header / bio-prefix / recognized
 * copyright marker were classifying as `unknown` and letting the position
 * default route the wrong file as the front. Plus regression coverage for
 * the existing front and stat-table back paths.
 */

import assert from 'node:assert/strict';
import { classifyCardSide } from '../bulkScan/sideClassifier';

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

// ── Subset-back signal ───────────────────────────────────────────────────

check('1986 NL Leaders leaderboard back classifies as back with subset_back signal', () => {
  // Verbatim from the audit (problem statement): the leaderboard layout has
  // a subset banner header and a tiny "No." column instead of a full stat
  // grid. Pre-fix this text scored 0 and verdict was `unknown`.
  const ocr = [
    '604 1986 NL LEADERS',
    'VICTORIES',
    'Pitcher Team No.',
    'F. VALENZUELA .DODGERS. .21',
    'Mike Krukow .Giants. .20',
    'Bob Ojeda Mets 18',
    'Rick Rhoden Pirates 15',
    'Mike Scott Astros 18',
    'TOPPS CHEWING GUM, INC.',
  ].join('\n');
  const r = classifyCardSide(ocr);
  assert.equal(r.verdict, 'back', `expected back, got ${r.verdict} (${r.signals.join(',')})`);
  assert.ok(r.signals.some((s) => s.startsWith('subset_back(')), `expected subset_back signal, got ${r.signals.join(',')}`);
  assert.equal(r.signals.find((s) => s.startsWith('subset_back('))!, 'subset_back("LEADERS")');
});

check('Record Breakers back classifies as back', () => {
  const ocr = [
    '202 RECORD BREAKERS',
    'NOLAN RYAN',
    'Most career strikeouts',
    'On October 1, 1986 Ryan recorded his 4,277th career K.',
  ].join('\n');
  const r = classifyCardSide(ocr);
  assert.equal(r.verdict, 'back', `expected back, got ${r.verdict} (${r.signals.join(',')})`);
  assert.ok(r.signals.some((s) => s.startsWith('subset_back(')));
});

check('All-Star back classifies as back', () => {
  const ocr = [
    'AMERICAN LEAGUE ALL-STAR',
    'WADE BOGGS THIRD BASE',
    'Selected to his fifth straight All-Star team in 1987.',
    'Boggs led the league in batting for the third year running.',
  ].join('\n');
  const r = classifyCardSide(ocr);
  assert.equal(r.verdict, 'back', `expected back, got ${r.verdict} (${r.signals.join(',')})`);
  assert.ok(r.signals.some((s) => s.startsWith('subset_back(')));
});

check('Future Stars back classifies as back', () => {
  const ocr = [
    '1986 TOPPS FUTURE STARS',
    'JOSE CANSECO OF',
    'Athletics rookie',
  ].join('\n');
  const r = classifyCardSide(ocr);
  assert.equal(r.verdict, 'back', `expected back, got ${r.verdict} (${r.signals.join(',')})`);
});

check('Team Leaders back classifies as back', () => {
  const ocr = [
    'TEAM LEADERS',
    'NEW YORK METS',
    'Batting Average: K. Hernandez .310',
    'Home Runs: D. Strawberry 27',
  ].join('\n');
  const r = classifyCardSide(ocr);
  assert.equal(r.verdict, 'back', `expected back, got ${r.verdict} (${r.signals.join(',')})`);
});

check('Turn Back The Clock back classifies as back', () => {
  const ocr = [
    '311 TURN BACK THE CLOCK',
    '1981 - HENDERSON STEALS 130',
    'Rickey set a new modern record.',
  ].join('\n');
  const r = classifyCardSide(ocr);
  assert.equal(r.verdict, 'back', `expected back, got ${r.verdict} (${r.signals.join(',')})`);
});

// ── Regressions ──────────────────────────────────────────────────────────

check('Sparse front (player photo) still classifies as front', () => {
  const ocr = 'TOPPS FERNANDO VALENZUELA DODGERS';
  const r = classifyCardSide(ocr);
  assert.equal(r.verdict, 'front', `expected front, got ${r.verdict} (${r.signals.join(',')})`);
});

check('Stat-table back still classifies as back', () => {
  const ocr = [
    'YEAR TEAM G AB R H 2B 3B HR RBI SB BB SO AVG',
    '1983 LA   10  35  4  9  1  0  1   3  0  2  6 .257',
    '1984 LA  142 562 89 168 26 4 22  93 5 50 80 .299',
    'BORN: November 1, 1960 in Navojoa, Mexico',
    '© 1985 TOPPS CHEWING GUM, INC.',
  ].join('\n');
  const r = classifyCardSide(ocr);
  assert.equal(r.verdict, 'back', `expected back, got ${r.verdict} (${r.signals.join(',')})`);
  assert.ok(r.signals.some((s) => s.startsWith('stat_header(')));
});

check('Front mentioning "manager" in flowing prose does NOT trigger subset signal', () => {
  // "manager" appearing inside flowing prose with lots of surrounding tokens
  // on the same line — this is the false-positive shape we explicitly avoid.
  const ocr = 'JOE TORRE 1996 World Series winning manager of the New York Yankees signed';
  const r = classifyCardSide(ocr);
  assert.ok(
    !r.signals.some((s) => s.startsWith('subset_back("MANAGER"')),
    `expected no MANAGER subset signal, got ${r.signals.join(',')}`,
  );
});

check('Word "leader" (singular) does NOT trigger LEADERS marker', () => {
  // The regex requires plural "LEADERS" with word boundaries — singular
  // "leader" should not trigger.
  const ocr = 'JIM LEYLAND TEAM LEADER PITTSBURGH PIRATES';
  const r = classifyCardSide(ocr);
  // It WILL hit "TEAM LEADER" via the LEADERS \b match? Actually \bLEADERS\b
  // requires final S — single "LEADER" should not match. Verify.
  const subsetSignals = r.signals.filter((s) => s.startsWith('subset_back('));
  assert.ok(
    subsetSignals.length === 0 || !subsetSignals.some((s) => s.includes('LEADERS')),
    `singular "leader" should not match LEADERS marker, got ${subsetSignals.join(',')}`,
  );
});

check('MANAGER as standalone banner heading triggers signal', () => {
  // A single short line of MANAGER (banner header) should match.
  const ocr = [
    'MANAGER',
    'TOMMY LASORDA',
    'Los Angeles Dodgers',
  ].join('\n');
  const r = classifyCardSide(ocr);
  assert.ok(
    r.signals.some((s) => s === 'subset_back("MANAGER")'),
    `expected MANAGER subset signal, got ${r.signals.join(',')}`,
  );
});

check('Empty OCR still returns unknown', () => {
  const r = classifyCardSide('');
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.signals.length, 0);
  assert.equal(r.debug.subsetMarkerHits, 0);
});

check('debug.subsetMarkerHits reflects matched-marker count', () => {
  const ocr = [
    '1986 NL LEADERS',
    'WORLD SERIES',
    'one-line per banner',
  ].join('\n');
  const r = classifyCardSide(ocr);
  assert.equal(r.debug.subsetMarkerHits, 2);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
