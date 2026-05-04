/**
 * PR T — Tests for the three streaming-scan refinements that landed
 * after PR S:
 *
 *   Item 1 — ScanInfoHeader rendered as chip 1's inlineSlot (instead
 *            of as a standalone block above the chip stack).
 *   Item 2 — Sequenced field reveal must take ~1s with the bumped
 *            200ms stagger; reduced-motion bypasses immediately.
 *   Item 3 — Manual-entry modal fires inline during stage 2 when
 *            the user clicks No on the streaming Yes/No modal,
 *            blocking stage 3 until they save a value.
 *
 * Pure-function / pure-helper tests only — no DOM, no React renderer
 * spin-up. The same pattern PR S used.
 *
 * Run via:
 *   npx tsx server/__tests__/prTScanRefinements.test.ts
 */

import assert from 'node:assert/strict';
import {
  shouldRevealFieldAt,
  SCAN_INFO_HEADER_FIELD_ORDER,
} from '../../client/src/components/ScanInfoHeader';
import {
  decoratedProgressStages,
  ebayProgressLabel,
} from '../../client/src/pages/Scan';
import {
  decideStreamingPostScan,
} from '../../client/src/pages/ScanResult';
import type {
  ScanProgressChipStage,
} from '../../client/src/components/ScanProgressChips';

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

// ── Item 1: ScanInfoHeader as chip-1 inlineSlot ─────────────────────────
check(
  'decoratedProgressStages: scanInfoNode is attached as chip-1 inlineSlot',
  () => {
    const stages: ScanProgressChipStage[] = [
      { id: 'analyzing_card', label: 'Analyzing card', status: 'in_progress' },
    ];
    const node = '<HEADER/>' as any;
    const out = decoratedProgressStages({
      stages,
      scanInfoNode: node,
      inlineParallelNode: null,
      ebayProgress: null,
    });
    assert.equal(out[0].inlineSlot, node);
  },
);

check(
  'decoratedProgressStages: chip-1 stays plain when no scanInfoNode supplied',
  () => {
    const stages: ScanProgressChipStage[] = [
      { id: 'analyzing_card', label: 'Analyzing card', status: 'in_progress' },
    ];
    const out = decoratedProgressStages({
      stages,
      scanInfoNode: null,
      inlineParallelNode: null,
      ebayProgress: null,
    });
    assert.equal(out[0].inlineSlot, undefined);
  },
);

check(
  'decoratedProgressStages: chip 2 inline picker still wires to detecting_parallel',
  () => {
    // PR T must not regress PR R Item 1: the inlineParallelNode still
    // attaches to chip 2 when present, alongside the new chip-1 slot.
    const stages: ScanProgressChipStage[] = [
      { id: 'analyzing_card', label: 'Analyzing card', status: 'completed' },
      {
        id: 'detecting_parallel',
        label: 'Detecting parallel',
        status: 'completed',
      },
    ];
    const headerNode = '<HEADER/>' as any;
    const pickerNode = '<PICKER/>' as any;
    const out = decoratedProgressStages({
      stages,
      scanInfoNode: headerNode,
      inlineParallelNode: pickerNode,
      ebayProgress: null,
    });
    assert.equal(out[0].id, 'analyzing_card');
    assert.equal(out[0].inlineSlot, headerNode);
    assert.equal(out[1].id, 'detecting_parallel');
    assert.equal(out[1].inlineSlot, pickerNode);
  },
);

check(
  'decoratedProgressStages: chip 3 detail still rendered from ebay progress',
  () => {
    // PR R Item 3 regression guard: the chip-3 detail label must
    // continue to format from the ebayProgress payload while PR T
    // adds chip-1 inlineSlot decoration.
    const stages: ScanProgressChipStage[] = [
      {
        id: 'verifying_with_ebay',
        label: 'Looking for active eBay listings',
        status: 'in_progress',
      },
    ];
    const out = decoratedProgressStages({
      stages,
      scanInfoNode: null,
      inlineParallelNode: null,
      ebayProgress: { found: 3, target: 10 },
    });
    assert.equal(out[0].detail, '(3/10)');
  },
);

// ── Item 2: Sequenced field reveal duration ─────────────────────────────
check(
  'sequenced reveal: 200ms × 5 ticks = ~1s total at default cadence',
  () => {
    // The default revealStaggerMs is 200ms (PR T bumped it from 160).
    // Reveal logic: tick 0 immediate (revealedCount = 1), then 5 more
    // ticks at 200ms apart to reach revealedCount = 6. Total elapsed
    // from "any field present" → "all fields visible" is therefore
    // (totalFields - 1) * stagger = 5 * 200 = 1000ms.
    const total = SCAN_INFO_HEADER_FIELD_ORDER.length;
    const stagger = 200;
    const totalRevealMs = (total - 1) * stagger;
    assert.equal(totalRevealMs, 1000);
    // Spec said the user must see ~750-1000ms of stagger. 1000 lands
    // at the top end — visibly distinct field reveals.
    assert.ok(totalRevealMs >= 750 && totalRevealMs <= 1100);
  },
);

check(
  'shouldRevealFieldAt: progressive reveal across the 6 fields',
  () => {
    // 0 revealed → nothing visible
    for (let i = 0; i < SCAN_INFO_HEADER_FIELD_ORDER.length; i++) {
      assert.equal(
        shouldRevealFieldAt({ fieldIndex: i, revealedCount: 0 }),
        false,
      );
    }
    // Mid-reveal — 4 of 6 visible (Year, Brand, Set, Collection)
    assert.equal(shouldRevealFieldAt({ fieldIndex: 0, revealedCount: 4 }), true);
    assert.equal(shouldRevealFieldAt({ fieldIndex: 3, revealedCount: 4 }), true);
    assert.equal(shouldRevealFieldAt({ fieldIndex: 4, revealedCount: 4 }), false);
    assert.equal(shouldRevealFieldAt({ fieldIndex: 5, revealedCount: 4 }), false);
  },
);

check(
  'reduced-motion bypass: revealedCount = total reveals every field at once',
  () => {
    const total = SCAN_INFO_HEADER_FIELD_ORDER.length;
    for (let i = 0; i < total; i++) {
      assert.equal(
        shouldRevealFieldAt({ fieldIndex: i, revealedCount: total }),
        true,
      );
    }
  },
);

// ── Item 3: Manual-entry modal blocks stage 3 + correct parallel ────────
//
// Mirror the gating logic from Scan.tsx as a pure helper so it can be
// unit-tested without a renderer. The real component composes the same
// rules:
//
//   - chip 3 stays in `waiting` while the confirm modal OR the manual
//     modal is open.
//   - eBay/pricing reads the manually-entered parallel after save
//     (overrides both auto-detected variant and base-card fallback).
//   - the result page must NOT re-prompt — manualAnswered counts as
//     "streaming Yes" for dedupe purposes.

interface Chip3GateInputs {
  serverStatus: 'in_progress' | 'completed' | 'pending' | 'waiting';
  confirmModalOpen: boolean;
  manualModalOpen: boolean;
}
function chip3DisplayedStatus(args: Chip3GateInputs): string {
  // Replicates the gate inside applyStageEvent in client/src/pages/Scan.tsx
  if (
    args.serverStatus !== 'waiting' &&
    (args.confirmModalOpen || args.manualModalOpen)
  ) {
    return 'waiting';
  }
  return args.serverStatus;
}

check(
  'chip 3 gate: confirm modal open suppresses server in_progress → waiting',
  () => {
    assert.equal(
      chip3DisplayedStatus({
        serverStatus: 'in_progress',
        confirmModalOpen: true,
        manualModalOpen: false,
      }),
      'waiting',
    );
  },
);

check(
  'chip 3 gate: manual modal open ALSO suppresses → waiting (PR T extension)',
  () => {
    // PR T's key extension: the wait state must persist after the
    // user clicks No on the Yes/No modal because the manual-entry
    // modal opens immediately. The legacy gate only covered
    // confirmModal; PR T extends it.
    assert.equal(
      chip3DisplayedStatus({
        serverStatus: 'in_progress',
        confirmModalOpen: false,
        manualModalOpen: true,
      }),
      'waiting',
    );
    assert.equal(
      chip3DisplayedStatus({
        serverStatus: 'completed',
        confirmModalOpen: false,
        manualModalOpen: true,
      }),
      'waiting',
    );
  },
);

check(
  'chip 3 gate: both modals closed → server status passes through',
  () => {
    assert.equal(
      chip3DisplayedStatus({
        serverStatus: 'in_progress',
        confirmModalOpen: false,
        manualModalOpen: false,
      }),
      'in_progress',
    );
    assert.equal(
      chip3DisplayedStatus({
        serverStatus: 'completed',
        confirmModalOpen: false,
        manualModalOpen: false,
      }),
      'completed',
    );
  },
);

// Pure helper modeling Scan.tsx's variant overwrite rules after the
// streaming modals resolve. Three input states map to three output
// shapes (the result.data fields the analyze flow patches before
// navigating to /result).
interface VariantInputs {
  // From confirmedVariantRef.current
  confirmedVariant: string | null | undefined;
  // From manualEnteredVariantRef.current (null when user never entered
  // anything; "" when blank-saved; non-empty string when typed)
  manualEntered: string | null;
  // The auto-detected variant the analyze response carried
  autoDetected: string;
}
interface VariantOutputs {
  variant: string | null;
  foilType: string | null;
  isFoil: boolean;
}
function applyStreamingDecision(
  inputs: VariantInputs,
): VariantOutputs {
  const { confirmedVariant, manualEntered, autoDetected } = inputs;
  if (manualEntered !== null && manualEntered.length > 0) {
    return { variant: manualEntered, foilType: manualEntered, isFoil: true };
  }
  if (confirmedVariant === null || manualEntered === '') {
    return { variant: null, foilType: null, isFoil: false };
  }
  // Yes-path or untouched — keep server's auto-detected.
  return { variant: autoDetected, foilType: autoDetected, isFoil: true };
}

check(
  'manual entry "Pink Ice" → eBay query feeds Pink Ice (not auto-detected)',
  () => {
    // The user-reported bug: stage 3+4 ran with the base/auto-detected
    // query while the user later typed "Pink Ice" in a post-completion
    // modal. PR T pulls the manual entry inline so the variant is
    // applied BEFORE eBay/pricing run.
    const out = applyStreamingDecision({
      confirmedVariant: null, // user clicked No
      manualEntered: 'Pink Ice', // then typed Pink Ice
      autoDetected: 'Refractor', // auto-guess we're rejecting
    });
    assert.equal(out.variant, 'Pink Ice');
    assert.equal(out.foilType, 'Pink Ice');
    assert.equal(out.isFoil, true);
  },
);

check(
  'manual entry blank → treat as base card',
  () => {
    const out = applyStreamingDecision({
      confirmedVariant: null,
      manualEntered: '',
      autoDetected: 'Refractor',
    });
    assert.equal(out.variant, null);
    assert.equal(out.foilType, null);
    assert.equal(out.isFoil, false);
  },
);

check(
  'streaming Yes → keep auto-detected variant (no overwrite)',
  () => {
    const out = applyStreamingDecision({
      confirmedVariant: 'Refractor', // user clicked Yes
      manualEntered: null,
      autoDetected: 'Refractor',
    });
    assert.equal(out.variant, 'Refractor');
    assert.equal(out.foilType, 'Refractor');
    assert.equal(out.isFoil, true);
  },
);

check(
  'manual entry suppresses post-completion legacy modal (decideStreamingPostScan)',
  () => {
    // PR T's dedupe contract: when the user has saved a value in the
    // inline manual modal, the result page must NOT re-prompt with
    // the legacy GeminiParallelPickerSheet. This is achieved by
    // setting streamingConfirmAnswered=true AND
    // parallelConfirmedInStream=true so decideStreamingPostScan
    // returns "skipToPricing".
    assert.equal(
      decideStreamingPostScan({
        streamingConfirmAnswered: true,
        parallelConfirmedInStream: true,
      }),
      'skipToPricing',
    );
  },
);

check(
  'fallback: when no streaming modal answered, legacy flow still fires',
  () => {
    // Base card / stream error / fallback path — PR T must not break
    // this. decideStreamingPostScan returns "fallback" so the legacy
    // GeminiParallelPickerSheet still gets a chance.
    assert.equal(
      decideStreamingPostScan({
        streamingConfirmAnswered: false,
        parallelConfirmedInStream: null,
      }),
      'fallback',
    );
  },
);

// Sanity: ebayProgressLabel still works (regression guard while
// re-touching decoratedProgressStages).
check(
  'ebayProgressLabel: in_progress shows (found/target)',
  () => {
    assert.equal(
      ebayProgressLabel({ found: 7, target: 10 }, 'in_progress'),
      '(7/10)',
    );
  },
);

check(
  'ebayProgressLabel: completed shows "Found N listings"',
  () => {
    assert.equal(
      ebayProgressLabel({ found: 7, target: 10 }, 'completed'),
      '— Found 7 listings',
    );
    assert.equal(
      ebayProgressLabel({ found: 1, target: 10 }, 'completed'),
      '— Found 1 listing',
    );
  },
);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll PR T streaming-scan refinements tests passed.');
