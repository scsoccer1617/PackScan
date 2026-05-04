/**
 * PR V hotfix — Regression test for the chip-3 gate dismissal path.
 *
 * Failure mode (pre-fix): Both StreamingParallelConfirmDialog and
 * StreamingManualParallelDialog rendered Radix Sheets without an
 * `onOpenChange` handler. Dismissing the modal via the built-in close
 * X button or the ESC key animated the dialog closed but never
 * resolved the chip-3 gate promise (`confirmResolveRef.current`),
 * leaving the analyze flow's `await waitForConfirmRef.current()` hung
 * forever. The user was stranded on a silent screen and the eBay
 * fetch / pricing never completed — so the Sheet row landed without
 * Average eBay price (col 16) or eBay search URL (col 19) populated.
 *
 * This test guards three properties:
 *
 *  1. Both dialogs accept and forward an `onDismiss` prop.
 *  2. Both dialogs wire `onOpenChange` on their <Sheet> root, so
 *     X-button / ESC dismissal routes through it.
 *  3. Scan.tsx defends with a 60s `Promise.race` timeout on the gate
 *     so a future regression that introduces another untracked
 *     dismissal path can't hang the flow forever.
 *
 * Source-text level — no React renderer needed. The fix is structural
 * and these structural assertions detect any future revert.
 *
 * Run via:
 *   npx tsx server/__tests__/prVChip3GateDismiss.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');
const confirmDialogPath = join(
  ROOT, 'client/src/components/StreamingParallelConfirmDialog.tsx',
);
const manualDialogPath = join(
  ROOT, 'client/src/components/StreamingManualParallelDialog.tsx',
);
const scanPath = join(ROOT, 'client/src/pages/Scan.tsx');

const confirmSrc = readFileSync(confirmDialogPath, 'utf8');
const manualSrc = readFileSync(manualDialogPath, 'utf8');
const scanSrc = readFileSync(scanPath, 'utf8');

let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

// ── 1. Confirm dialog wires onOpenChange + onDismiss ────────────────────
check(
  'StreamingParallelConfirmDialog: declares onDismiss in Props',
  () => {
    assert.match(
      confirmSrc,
      /onDismiss\?:\s*\(\)\s*=>\s*void/,
      'expected `onDismiss?: () => void` in Props',
    );
  },
);

check(
  'StreamingParallelConfirmDialog: <Sheet> has onOpenChange wired',
  () => {
    // Sheet must declare onOpenChange — otherwise X / ESC dismissal
    // is silent and the gate hangs.
    const sheetBlock = confirmSrc.match(/<Sheet[\s\S]*?<SheetContent/)?.[0] ?? '';
    assert.match(
      sheetBlock,
      /onOpenChange=\{/,
      'expected onOpenChange={...} on the <Sheet>',
    );
    // The handler must invoke onDismiss on close (next === false).
    assert.ok(
      sheetBlock.includes('onDismiss') || sheetBlock.includes('onNo'),
      'expected onOpenChange handler to fall through to onDismiss / onNo',
    );
  },
);

check(
  'StreamingParallelConfirmDialog: outside-tap is prevented (no accidental close)',
  () => {
    assert.match(
      confirmSrc,
      /onInteractOutside=\{[^}]*preventDefault/,
      'outside-tap handler must call e.preventDefault()',
    );
  },
);

// ── 2. Manual dialog wires onOpenChange + onDismiss ────────────────────
check(
  'StreamingManualParallelDialog: declares onDismiss in Props',
  () => {
    assert.match(
      manualSrc,
      /onDismiss\?:\s*\(\)\s*=>\s*void/,
      'expected `onDismiss?: () => void` in Props',
    );
  },
);

check(
  'StreamingManualParallelDialog: <Sheet> has onOpenChange wired',
  () => {
    const sheetBlock = manualSrc.match(/<Sheet[\s\S]*?<SheetContent/)?.[0] ?? '';
    assert.match(
      sheetBlock,
      /onOpenChange=\{/,
      'expected onOpenChange={...} on the <Sheet>',
    );
    assert.ok(
      sheetBlock.includes('onDismiss') || sheetBlock.includes('onSave'),
      'expected onOpenChange handler to fall through to onDismiss / onSave',
    );
  },
);

// ── 3. Scan.tsx wires onDismiss for both dialogs ───────────────────────
check(
  'Scan.tsx: StreamingParallelConfirmDialog receives onDismiss',
  () => {
    const block =
      scanSrc.match(/<StreamingParallelConfirmDialog[\s\S]*?\/>/)?.[0] ?? '';
    assert.match(
      block,
      /onDismiss=\{/,
      'expected onDismiss={...} on <StreamingParallelConfirmDialog>',
    );
    // Must call resolveConfirmGate so the analyze flow proceeds.
    assert.ok(
      block.includes('resolveConfirmGate'),
      'expected dismiss handler to call resolveConfirmGate()',
    );
    assert.ok(
      block.includes('releaseChip3Gate'),
      'expected dismiss handler to call releaseChip3Gate()',
    );
  },
);

check(
  'Scan.tsx: StreamingManualParallelDialog receives onDismiss',
  () => {
    const block =
      scanSrc.match(/<StreamingManualParallelDialog[\s\S]*?\/>/)?.[0] ?? '';
    assert.match(
      block,
      /onDismiss=\{/,
      'expected onDismiss={...} on <StreamingManualParallelDialog>',
    );
    assert.ok(
      block.includes('resolveConfirmGate'),
      'expected dismiss handler to call resolveConfirmGate()',
    );
    assert.ok(
      block.includes('releaseChip3Gate'),
      'expected dismiss handler to call releaseChip3Gate()',
    );
  },
);

// ── 4. Defensive Promise.race timeout on the analyze gate ──────────────
check(
  'Scan.tsx: gate await uses Promise.race with a timeout fallback',
  () => {
    // Locate the gate-await region (skip the applyStageEvent gate
    // check which uses the same predicate).
    const matches = [
      ...scanSrc.matchAll(
        /confirmModalOpenRef\.current \|\| manualModalOpenRef\.current[\s\S]{0,2500}/g,
      ),
    ];
    const region = matches.find((m) => m[0].includes('await'))?.[0] ?? '';
    assert.ok(region.length > 0, 'could not locate gate-await region');
    assert.match(
      region,
      /Promise\.race/,
      'gate await must use Promise.race so a hung gate cannot strand the flow',
    );
    assert.match(
      region,
      /GATE_TIMEOUT_MS|setTimeout/,
      'gate await must include a timeout',
    );
    // On timeout, must clean up modal state + release gate.
    assert.ok(
      region.includes('releaseChip3Gate') &&
        region.includes('resolveConfirmGate'),
      'timeout branch must release chip 3 + resolve the gate',
    );
  },
);

// ── 5. Observability — warn logs on dismissal paths ────────────────────
check(
  'Scan.tsx: dismissal paths emit observability logs',
  () => {
    // We log every transition so production debugging can see whether
    // a stuck-pricing report came from a dismissal path vs. a true
    // server failure.
    assert.match(scanSrc, /\[holo-gate\]/);
  },
);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll PR V chip-3 gate dismiss tests passed.');
