/**
 * Standalone assert-based tests for the 2026 Topps imprint year override.
 * Run via:
 *
 *   npx tsx server/__tests__/yearOverrides.test.ts
 *
 * Sample OCR back texts come from the bulk-28 batch — the four cards that
 * came back year=2025 from Gemini despite the "& 2026 THE TOPPS" imprint
 * (the OCR sometimes reads © as &) and the CMP123053 set identifier.
 */

import assert from 'node:assert/strict';
import { applyTopps2026ImprintOverride } from '../yearOverrides';

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

// Real OCR back-text snippets from the four bulk-28 misses. Each ends
// with the legal strip line containing "& 2026 THE TOPPS" + CMP123053.

const HENRIQUEZ_BACK = `290
SERIES ONE
RONNY HENRIQUEZ
MIAMI MARLINS
... stat rows ending in "25 MARLINS" ...
In his first 50 appearances for the 2025 Marlins, Ronny delivered a 2.91 ERA...
& 2026 THE TOPPS COMPANY, INC. ALL RIGHTS RESERVED.
WWW.TOPPS.COM. CODE#CMP123053`;

const WILLIAMS_BACK = `239
SERIES ONE
DEVIN WILLIAMS
NEW YORK YANKEES
... 25 YANKEES 67 4 6 62 45 37 33 25 90 0 18 1.13 4.79 -0.3 ...
Devin hit full stride with the Yankees in June 2025, posting a 0.93 ERA...
& 2026 THE TOPPS COMPANY, INC. ALL RIGHTS RESERVED.
WWW.TOPPS.COM. CODE #CMP123053`;

const FREELAND_BACK = `74
SERIES ONE
ALEX FREELAND
LOS ANGELES DODGERS
... 25 OKLAHOMA CITY ... 25 DODGERS ...
Alex finally attacked the right part of the park to clear the fence on August 22, 2025.
&2026 THE TOPPS COMPANY, INC. ALL RIGHTS RESERVED.
WWW.TOPPS.COM. CODE#CMP123053`;

const RODRIGUEZ_BACK = `146
SERIES ONE
RODRIGUEZ
... 25 ... 2025 ...
& 2026 THE TOPPS COMPANY, INC. ALL RIGHTS RESERVED.
WWW.TOPPS.COM. CODE#CMP123053`;

// Genuine 2025 © Topps card (no override should fire). The imprint year
// in this OCR text is 2025, not 2026 — the regex must not match.
const NON_TOPPS_2026 = `Some prose
Stat rows
©2025 THE TOPPS COMPANY, INC. ALL RIGHTS RESERVED.
WWW.TOPPS.COM. CODE#CMP100123`;

// ── Override fires on the four known-bad scans ──────────────────────────

check('overrides Henriquez (bulk-28-786) year=2025 → 2026', () => {
  const r = applyTopps2026ImprintOverride({
    scanId: 'bulk-28-786',
    vlmYear: 2025,
    ocrBackText: HENRIQUEZ_BACK,
  });
  assert.equal(r.year, 2026);
  assert.equal(r.overridden, true);
});

check('overrides Williams (bulk-28-787) year=2025 → 2026', () => {
  const r = applyTopps2026ImprintOverride({
    scanId: 'bulk-28-787',
    vlmYear: 2025,
    ocrBackText: WILLIAMS_BACK,
  });
  assert.equal(r.year, 2026);
  assert.equal(r.overridden, true);
});

check('overrides Freeland (bulk-28-791) year=2025 → 2026 via &2026 (no space)', () => {
  const r = applyTopps2026ImprintOverride({
    scanId: 'bulk-28-791',
    vlmYear: 2025,
    ocrBackText: FREELAND_BACK,
  });
  assert.equal(r.year, 2026);
  assert.equal(r.overridden, true);
});

check('overrides Rodríguez (bulk-28-792) year=2025 → 2026', () => {
  const r = applyTopps2026ImprintOverride({
    scanId: 'bulk-28-792',
    vlmYear: 2025,
    ocrBackText: RODRIGUEZ_BACK,
  });
  assert.equal(r.year, 2026);
  assert.equal(r.overridden, true);
});

// ── No-op when VLM already returned 2026 ────────────────────────────────

check('no-op when vlmYear is already 2026', () => {
  const r = applyTopps2026ImprintOverride({
    scanId: 'bulk-28-784',
    vlmYear: 2026,
    ocrBackText: HENRIQUEZ_BACK,
  });
  assert.equal(r.year, 2026);
  assert.equal(r.overridden, false);
});

// ── No-op when neither imprint nor CMP appears ──────────────────────────

check('no-op when neither imprint nor CMP signal is present', () => {
  const r = applyTopps2026ImprintOverride({
    scanId: 'test',
    vlmYear: 2025,
    ocrBackText: NON_TOPPS_2026,
  });
  assert.equal(r.year, 2025);
  assert.equal(r.overridden, false);
});

check('no-op when ocrBackText is empty', () => {
  const r = applyTopps2026ImprintOverride({
    scanId: 'test',
    vlmYear: 2025,
    ocrBackText: '',
  });
  assert.equal(r.overridden, false);
});

check('no-op when ocrBackText is null', () => {
  const r = applyTopps2026ImprintOverride({
    scanId: 'test',
    vlmYear: 2025,
    ocrBackText: null,
  });
  assert.equal(r.overridden, false);
});

// ── CMP-only signal also fires ──────────────────────────────────────────

check('overrides on CMP123053 alone (no imprint match)', () => {
  const r = applyTopps2026ImprintOverride({
    scanId: 'cmp-only',
    vlmYear: 2025,
    ocrBackText: 'Some text without imprint. CMP123053 trailing',
  });
  assert.equal(r.year, 2026);
  assert.equal(r.overridden, true);
});

check('overrides on CMP123059 (CMP12305X family)', () => {
  const r = applyTopps2026ImprintOverride({
    scanId: 'cmp-only',
    vlmYear: 2025,
    ocrBackText: 'Some text without imprint. CMP123059 trailing',
  });
  assert.equal(r.year, 2026);
  assert.equal(r.overridden, true);
});

check('does NOT fire on CMP100358 (different set)', () => {
  const r = applyTopps2026ImprintOverride({
    scanId: 'cmp-other',
    vlmYear: 2025,
    ocrBackText: 'CMP100358 only',
  });
  assert.equal(r.year, 2025);
  assert.equal(r.overridden, false);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll yearOverrides tests passed');
}
