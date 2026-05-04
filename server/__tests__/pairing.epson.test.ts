/**
 * Standalone assert-based tests for the Epson side-default invert in
 * `bulkScan/pairing.ts` `pairPages`. Run via:
 *
 *   npx tsx server/__tests__/pairing.epson.test.ts
 *
 * The repo has no vitest/jest config (see PR #208 vlmApply.coercion.test.ts
 * for prior precedent), so we keep the dependency surface minimal and
 * lean on `node:assert`.
 *
 * Audit context: the user's Epson DS scanner saves duplex pages with
 * filenames like `Epson_05042026080452(1).jpg` where odd N = front,
 * even N = back — the OPPOSITE of the Brother iPrint&Scan default the
 * existing position rule was tuned for. Without the invert,
 * `bulk-40-1073` (1987 Topps Valenzuela #555) persisted with the
 * leaderboard back as `frontFileId` because the classifier landed on
 * `front + unknown` and the unknown branch fell through to the Brother
 * default. See `side_detection_audit.md` for the full trace.
 */

import assert from 'node:assert/strict';
import { pairPages, type ScanPage } from '../bulkScan/pairing';
import type { SideClassification } from '../bulkScan/sideClassifier';

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

type TestFile = { id: string; name: string };

function classification(verdict: SideClassification['verdict']): SideClassification {
  return {
    verdict,
    confidence: verdict === 'unknown' ? 0 : 0.6,
    signals: [],
    debug: { bioPrefixLines: 0, copyrightHits: 0, statHeaderTokens: 0, totalWords: 0 },
  };
}

function page(
  position: number,
  fileName: string,
  verdict: SideClassification['verdict'],
): ScanPage<TestFile> {
  return {
    position,
    file: { id: `id-${position}`, name: fileName },
    ocrText: '',
    classification: classification(verdict),
  };
}

// ── Epson-named pair, both classified `unknown` (Valenzuela case) ─────────
check('Epson pair, both unknown → invert default; (1)=front, (2)=back', () => {
  const pages = [
    page(1, 'Epson_05042026080452(1).jpg', 'unknown'),
    page(2, 'Epson_05042026080452(2).jpg', 'unknown'),
  ];
  const [pair] = pairPages(pages);
  assert.equal(pair.front?.file.name, 'Epson_05042026080452(1).jpg');
  assert.equal(pair.back?.file.name, 'Epson_05042026080452(2).jpg');
  assert.deepEqual(pair.warnings, ['classifier_unknown']);
});

// ── Epson-named pair, classifier says (1)=back, (2)=front → swap ──────────
check('Epson pair, classifier disagrees with Epson default → swap', () => {
  const pages = [
    page(1, 'Epson_x(1).jpg', 'back'),
    page(2, 'Epson_x(2).jpg', 'front'),
  ];
  const [pair] = pairPages(pages);
  // Epson default would make (1)=front, (2)=back. Classifier disagrees;
  // swap fires → (1)=back, (2)=front and warning swapped_by_classifier.
  assert.equal(pair.front?.file.name, 'Epson_x(2).jpg');
  assert.equal(pair.back?.file.name, 'Epson_x(1).jpg');
  assert.deepEqual(pair.warnings, ['swapped_by_classifier']);
});

// ── Epson-named pair, classifier confirms Epson default → happy path ─────
check('Epson pair, classifier agrees with Epson default → no warning', () => {
  const pages = [
    page(1, 'Epson_x(1).jpg', 'front'),
    page(2, 'Epson_x(2).jpg', 'back'),
  ];
  const [pair] = pairPages(pages);
  assert.equal(pair.front?.file.name, 'Epson_x(1).jpg');
  assert.equal(pair.back?.file.name, 'Epson_x(2).jpg');
  assert.deepEqual(pair.warnings, []);
});

// ── Epson same-side both fronts ──────────────────────────────────────────
check('Epson pair, both classify front → same-side warning, position kept', () => {
  const pages = [
    page(1, 'Epson_x(1).jpg', 'front'),
    page(2, 'Epson_x(2).jpg', 'front'),
  ];
  const [pair] = pairPages(pages);
  // Position kept (Epson default): (1)=front, (2)=back.
  assert.equal(pair.front?.file.name, 'Epson_x(1).jpg');
  assert.equal(pair.back?.file.name, 'Epson_x(2).jpg');
  assert.deepEqual(pair.warnings, ['classifier_same_side_front']);
});

// ── Brother (non-Epson) regression: original default preserved ────────────
check('Brother-named pair, both unknown → original default; (1)=back, (2)=front', () => {
  const pages = [
    page(1, 'page-1.jpg', 'unknown'),
    page(2, 'page-2.jpg', 'unknown'),
  ];
  const [pair] = pairPages(pages);
  assert.equal(pair.back?.file.name, 'page-1.jpg');
  assert.equal(pair.front?.file.name, 'page-2.jpg');
  assert.deepEqual(pair.warnings, ['classifier_unknown']);
});

check('Brother pair, classifier says (1)=front, (2)=back → swap', () => {
  const pages = [
    page(1, 'page-1.jpg', 'front'),
    page(2, 'page-2.jpg', 'back'),
  ];
  const [pair] = pairPages(pages);
  assert.equal(pair.front?.file.name, 'page-1.jpg');
  assert.equal(pair.back?.file.name, 'page-2.jpg');
  assert.deepEqual(pair.warnings, ['swapped_by_classifier']);
});

check('Brother pair, classifier agrees with Brother default → no warning', () => {
  const pages = [
    page(1, 'page-1.jpg', 'back'),
    page(2, 'page-2.jpg', 'front'),
  ];
  const [pair] = pairPages(pages);
  assert.equal(pair.back?.file.name, 'page-1.jpg');
  assert.equal(pair.front?.file.name, 'page-2.jpg');
  assert.deepEqual(pair.warnings, []);
});

// ── Mixed naming (only one page has Epson naming) → Brother default ──────
check('Mixed naming (only one Epson) → Brother default preserved', () => {
  const pages = [
    page(1, 'Epson_x(1).jpg', 'unknown'),
    page(2, 'IMG_1234.jpg', 'unknown'),
  ];
  const [pair] = pairPages(pages);
  // Brother default: (1)=back, (2)=front.
  assert.equal(pair.back?.file.name, 'Epson_x(1).jpg');
  assert.equal(pair.front?.file.name, 'IMG_1234.jpg');
  assert.deepEqual(pair.warnings, ['classifier_unknown']);
});

// ── Trailing-orphan path unchanged ────────────────────────────────────────
check('odd page count: trailing orphan flagged', () => {
  const pages = [
    page(1, 'Epson_x(1).jpg', 'front'),
    page(2, 'Epson_x(2).jpg', 'back'),
    page(3, 'Epson_x(3).jpg', 'front'),
  ];
  const result = pairPages(pages);
  assert.equal(result.length, 2);
  assert.deepEqual(result[1].warnings, ['unpaired_trailing_page']);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
