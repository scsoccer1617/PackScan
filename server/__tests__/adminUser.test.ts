/**
 * Tests for the PR AB admin-user identification + bulk-scan routing helper.
 * Run via:
 *
 *   npx tsx server/__tests__/adminUser.test.ts
 *
 * Spec — admin (Daniel) bulk scans MUST always go to the review queue,
 * regardless of confidence. External users keep the existing confidence-gate
 * behavior. The four required scenarios all hit `shouldAutoSaveCard`:
 *
 *   admin    + 95% gate=auto_save  → review (NOT auto-sync)
 *   external + 95% gate=auto_save  → auto-sync
 *   admin    + 50% gate=review     → review
 *   external + 50% gate=review     → review
 */

import assert from 'node:assert/strict';
import { isAdminEmail, shouldAutoSaveCard } from '../lib/adminUser.pure';

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

// ── isAdminEmail ─────────────────────────────────────────────────────────

check('isAdminEmail: matches default admin email exactly', () => {
  assert.equal(isAdminEmail('daniel.j.holley@gmail.com'), true);
});

check('isAdminEmail: case-insensitive', () => {
  assert.equal(isAdminEmail('Daniel.J.Holley@Gmail.com'), true);
  assert.equal(isAdminEmail('DANIEL.J.HOLLEY@GMAIL.COM'), true);
});

check('isAdminEmail: trims whitespace', () => {
  assert.equal(isAdminEmail('  daniel.j.holley@gmail.com  '), true);
});

check('isAdminEmail: rejects non-admin emails', () => {
  assert.equal(isAdminEmail('alice@example.com'), false);
  assert.equal(isAdminEmail('beta-tester@gmail.com'), false);
  assert.equal(isAdminEmail('daniel@gmail.com'), false);
});

check('isAdminEmail: rejects empty / null / undefined', () => {
  assert.equal(isAdminEmail(''), false);
  assert.equal(isAdminEmail('   '), false);
  assert.equal(isAdminEmail(null), false);
  assert.equal(isAdminEmail(undefined), false);
});

// ── shouldAutoSaveCard — the four locked scenarios ───────────────────────

check('admin + high confidence (gate=auto_save) → REVIEW (not auto-sync)', () => {
  const out = shouldAutoSaveCard({
    reviewerIsAdmin: true,
    gateVerdict: 'auto_save',
    dryRun: false,
  });
  assert.equal(out, false, 'admin must NEVER auto-save, even at 95% confidence');
});

check('external + high confidence (gate=auto_save) → AUTO-SYNC (current behavior)', () => {
  const out = shouldAutoSaveCard({
    reviewerIsAdmin: false,
    gateVerdict: 'auto_save',
    dryRun: false,
  });
  assert.equal(out, true, 'external high-confidence cards still auto-sync');
});

check('admin + low confidence (gate=review) → REVIEW', () => {
  const out = shouldAutoSaveCard({
    reviewerIsAdmin: true,
    gateVerdict: 'review',
    dryRun: false,
  });
  assert.equal(out, false);
});

check('external + low confidence (gate=review) → REVIEW (current behavior)', () => {
  const out = shouldAutoSaveCard({
    reviewerIsAdmin: false,
    gateVerdict: 'review',
    dryRun: false,
  });
  assert.equal(out, false);
});

// ── shouldAutoSaveCard — supporting invariants ───────────────────────────

check('dryRun blocks auto-save for both admin and external', () => {
  for (const reviewerIsAdmin of [true, false]) {
    const out = shouldAutoSaveCard({
      reviewerIsAdmin,
      gateVerdict: 'auto_save',
      dryRun: true,
    });
    assert.equal(out, false, `dryRun=true admin=${reviewerIsAdmin} must not auto-save`);
  }
});

check('admin flag wins even when other inputs would auto-save', () => {
  // Belt-and-suspenders: matches the spec phrase "admin = mandatory review".
  const out = shouldAutoSaveCard({
    reviewerIsAdmin: true,
    gateVerdict: 'auto_save',
    dryRun: false,
  });
  assert.equal(out, false);
});

check('external + auto_save + non-dryRun is the only auto-sync combo', () => {
  // Truth-table sanity: of the 8 combinations, exactly one returns true.
  const truthy: string[] = [];
  for (const reviewerIsAdmin of [true, false]) {
    for (const gateVerdict of ['auto_save', 'review'] as const) {
      for (const dryRun of [true, false]) {
        if (shouldAutoSaveCard({ reviewerIsAdmin, gateVerdict, dryRun })) {
          truthy.push(`admin=${reviewerIsAdmin} verdict=${gateVerdict} dry=${dryRun}`);
        }
      }
    }
  }
  assert.deepEqual(truthy, ['admin=false verdict=auto_save dry=false']);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
