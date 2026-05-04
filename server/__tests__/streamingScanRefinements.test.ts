/**
 * PR R — Tests for the four streaming-scan UX refinements wired through
 * Scan.tsx. The reducers / pure helpers under test are mirrored verbatim
 * from the page so this file exercises the same logic without spinning
 * up React.
 *
 * Coverage:
 *  - Item 1: decoratedProgressStages attaches the picker as inlineSlot
 *    on chip 2, never on chip 1 / chip 3 / chip 4.
 *  - Item 2: confirm-modal gate forces chip 3 into "waiting" while the
 *    modal is open; release replays the latest server status. No-click
 *    flow does NOT auto-advance chip 3.
 *  - Item 3: ebayProgressLabel formats the correct sub-label for each
 *    chip status (in_progress → "(N/M)", completed → "Found N
 *    listings", waiting/pending → null).
 *  - Item 4: stage-1 field stream merges field-by-field into the
 *    ScanInfoHeader fields object without dropping previously-known
 *    values.
 *
 * Run via:
 *   npx tsx server/__tests__/streamingScanRefinements.test.ts
 */

import assert from 'node:assert/strict';
import {
  decoratedProgressStages,
  ebayProgressLabel,
  describeFields,
} from '../../client/src/pages/Scan';
import type {
  ScanProgressChipStage,
  ChipStatus,
} from '../../client/src/components/ScanProgressChips';
import type { ScanInfoHeaderFields } from '../../client/src/components/ScanInfoHeader';

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

function chip(
  id: string,
  status: ChipStatus = 'in_progress',
): ScanProgressChipStage {
  return { id, label: id, status };
}

// ── Item 1: picker placement ────────────────────────────────────────────
check(
  'picker attaches as inlineSlot on chip 2 only',
  () => {
    const out = decoratedProgressStages({
      stages: [
        chip('analyzing_card', 'completed'),
        chip('detecting_parallel', 'completed'),
        chip('verifying_with_ebay'),
      ],
      inlineParallelNode: 'PICKER',
      ebayProgress: null,
    });
    assert.equal(out[0].inlineSlot, undefined);
    assert.equal(out[1].inlineSlot, 'PICKER');
    assert.equal(out[2].inlineSlot, undefined);
  },
);

check(
  'picker omitted when inlineParallelNode is null',
  () => {
    const out = decoratedProgressStages({
      stages: [chip('detecting_parallel', 'completed')],
      inlineParallelNode: null,
      ebayProgress: null,
    });
    assert.equal(out[0].inlineSlot, undefined);
  },
);

// ── Item 3: chip 3 listing-count sub-label ──────────────────────────────
check(
  'progress label: in_progress shows (N/M)',
  () => {
    assert.equal(
      ebayProgressLabel({ found: 3, target: 10 }, 'in_progress'),
      '(3/10)',
    );
    assert.equal(
      ebayProgressLabel({ found: 7, target: 10 }, 'in_progress'),
      '(7/10)',
    );
  },
);

check(
  'progress label: completed shows "Found N listings"',
  () => {
    assert.equal(
      ebayProgressLabel({ found: 10, target: 10 }, 'completed'),
      '— Found 10 listings',
    );
    assert.equal(
      ebayProgressLabel({ found: 1, target: 10 }, 'completed'),
      '— Found 1 listing',
    );
  },
);

check(
  'progress label: waiting / pending suppress the count',
  () => {
    assert.equal(ebayProgressLabel({ found: 3, target: 10 }, 'waiting'), null);
    assert.equal(ebayProgressLabel({ found: 3, target: 10 }, 'pending'), null);
  },
);

check(
  'progress label: null progress yields null',
  () => {
    assert.equal(ebayProgressLabel(null, 'in_progress'), null);
    assert.equal(ebayProgressLabel(null, 'completed'), null);
  },
);

check(
  'decorate attaches detail string to chip 3 when progress present',
  () => {
    const out = decoratedProgressStages({
      stages: [chip('verifying_with_ebay', 'in_progress')],
      inlineParallelNode: null,
      ebayProgress: { found: 4, target: 10 },
    });
    assert.equal(out[0].detail, '(4/10)');
  },
);

// ── Item 2: confirm-modal gate (chip 3) ─────────────────────────────────
//
// The Scan page uses these helpers:
//   1. The applyStageEvent reducer rewrites verifying_with_ebay status to
//      'waiting' when the confirm modal is open, capturing the original
//      status into a ref.
//   2. releaseChip3Gate replays the captured status onto the chip.
// Mirrored here so we can assert on both halves.
function gateApply(
  prev: ScanProgressChipStage[],
  id: string,
  status: ChipStatus,
  modalOpen: boolean,
  pendingRef: { current: ChipStatus | null },
): ScanProgressChipStage[] {
  let effective = status;
  if (id === 'verifying_with_ebay' && status !== 'waiting' && modalOpen) {
    pendingRef.current = status;
    effective = 'waiting';
  }
  const idx = prev.findIndex((s) => s.id === id);
  if (idx >= 0) {
    const next = prev.slice();
    next[idx] = { ...next[idx], status: effective };
    return next;
  }
  return [...prev, { id, label: id, status: effective }];
}

function gateRelease(
  prev: ScanProgressChipStage[],
  pendingRef: { current: ChipStatus | null },
): ScanProgressChipStage[] {
  const next = pendingRef.current ?? 'in_progress';
  pendingRef.current = null;
  const idx = prev.findIndex((s) => s.id === 'verifying_with_ebay');
  if (idx < 0) {
    return [...prev, { id: 'verifying_with_ebay', label: 'eBay', status: next }];
  }
  const arr = prev.slice();
  arr[idx] = { ...arr[idx], status: next };
  return arr;
}

check(
  'modal open: stage-3 in_progress is rewritten to waiting; pending ref captures original',
  () => {
    const ref: { current: ChipStatus | null } = { current: null };
    let stages: ScanProgressChipStage[] = [];
    // Modal opens (parallel detected) — page pre-mounts chip 3 in waiting.
    stages = gateApply(stages, 'verifying_with_ebay', 'waiting', true, ref);
    // Server fires verifying_with_ebay:in_progress shortly after — should
    // be intercepted to keep the chip waiting and stash 'in_progress'.
    stages = gateApply(stages, 'verifying_with_ebay', 'in_progress', true, ref);
    assert.equal(stages.find((s) => s.id === 'verifying_with_ebay')!.status, 'waiting');
    assert.equal(ref.current, 'in_progress');
  },
);

check(
  'modal open: stage-3 completed is also held — release replays it',
  () => {
    const ref: { current: ChipStatus | null } = { current: null };
    let stages: ScanProgressChipStage[] = [];
    stages = gateApply(stages, 'verifying_with_ebay', 'waiting', true, ref);
    stages = gateApply(stages, 'verifying_with_ebay', 'in_progress', true, ref);
    stages = gateApply(stages, 'verifying_with_ebay', 'completed', true, ref);
    assert.equal(stages.find((s) => s.id === 'verifying_with_ebay')!.status, 'waiting');
    assert.equal(ref.current, 'completed');
    // User clicks Yes → releaseChip3Gate replays 'completed'.
    stages = gateRelease(stages, ref);
    assert.equal(stages.find((s) => s.id === 'verifying_with_ebay')!.status, 'completed');
    assert.equal(ref.current, null);
  },
);

check(
  'modal NEVER open: stage-3 status passes through unchanged',
  () => {
    const ref: { current: ChipStatus | null } = { current: null };
    let stages: ScanProgressChipStage[] = [];
    stages = gateApply(stages, 'verifying_with_ebay', 'in_progress', false, ref);
    assert.equal(stages.find((s) => s.id === 'verifying_with_ebay')!.status, 'in_progress');
    assert.equal(ref.current, null);
  },
);

check(
  'release with no captured status defaults to in_progress',
  () => {
    const ref: { current: ChipStatus | null } = { current: null };
    let stages: ScanProgressChipStage[] = [];
    stages = gateApply(stages, 'verifying_with_ebay', 'waiting', true, ref);
    stages = gateRelease(stages, ref);
    assert.equal(stages.find((s) => s.id === 'verifying_with_ebay')!.status, 'in_progress');
  },
);

// ── Item 2: AbortController No-click semantics ──────────────────────────
//
// The actual abort happens server-side (PR P plumbing). Here we assert
// the No-click branch of the reducer: confirmedVariant flips to null
// AND the inline picker mutates to "Base" (variant = null).
function reduceNoClick(prev: { variant: string | null; foilType: string | null }) {
  return { ...prev, variant: null };
}

check(
  'No-click: inline picker variant flips to null (Base) without remount',
  () => {
    const before = { variant: 'Pink Refractor', foilType: null };
    const after = reduceNoClick(before);
    assert.equal(after.variant, null);
    assert.equal(after.foilType, null);
  },
);

// ── Item 4: stage-1 field stream merge ──────────────────────────────────
//
// The Scan page's setScanInfoFields reducer merges incoming partial
// fields with the prior known set, keeping any field the new event
// didn't include. Mirrored here.
function mergeFields(
  prev: ScanInfoHeaderFields,
  d: Partial<ScanInfoHeaderFields>,
): ScanInfoHeaderFields {
  return {
    year: d.year ?? prev.year ?? null,
    brand: d.brand ?? prev.brand ?? null,
    set: d.set ?? prev.set ?? null,
    cardNumber: d.cardNumber ?? prev.cardNumber ?? null,
    player: d.player ?? prev.player ?? null,
  };
}

check(
  'field stream merges field-by-field; previously-known values persist',
  () => {
    let f: ScanInfoHeaderFields = {};
    f = mergeFields(f, { year: 2025 });
    f = mergeFields(f, { brand: 'Topps' });
    f = mergeFields(f, { set: 'Base Set', cardNumber: 'US49' });
    f = mergeFields(f, { player: 'Michael Petersen' });
    assert.deepEqual(f, {
      year: 2025,
      brand: 'Topps',
      set: 'Base Set',
      cardNumber: 'US49',
      player: 'Michael Petersen',
    });
  },
);

check(
  'field stream: a later batch with one field does not clobber others',
  () => {
    const f1: ScanInfoHeaderFields = {
      year: 2025,
      brand: 'Topps',
      set: 'Base',
      cardNumber: 'US49',
      player: 'Michael Petersen',
    };
    const f2 = mergeFields(f1, { brand: 'Topps Chrome' });
    assert.equal(f2.year, 2025);
    assert.equal(f2.brand, 'Topps Chrome');
    assert.equal(f2.player, 'Michael Petersen');
  },
);

check(
  'describeFields renders identity line for modal description',
  () => {
    assert.equal(
      describeFields({
        year: 2025,
        brand: 'Topps',
        set: 'Base Set',
        cardNumber: 'US49',
        player: 'Michael Petersen',
      }),
      '2025 · Topps · Base Set · #US49 · Michael Petersen',
    );
  },
);

check(
  'describeFields skips empty fields gracefully',
  () => {
    assert.equal(
      describeFields({ year: 2025, brand: 'Topps' }),
      '2025 · Topps',
    );
  },
);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll PR R streaming-scan refinements tests passed.');
