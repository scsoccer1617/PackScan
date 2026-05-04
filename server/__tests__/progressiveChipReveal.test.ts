/**
 * PR P — unit tests for the progressive chip-reveal reducer behavior
 * applied in client/src/pages/Scan.tsx (`applyStageEvent`). The test
 * mirrors the inline reducer the page uses so we can exercise the
 * "chip array grows from 0 → 4 progressively as events arrive"
 * contract without spinning up the full React component tree.
 *
 * Run via:
 *
 *   npx tsx server/__tests__/progressiveChipReveal.test.ts
 *
 * Two cases:
 *   1. Cold start → mounts on first `in_progress`, transitions to
 *      `completed` on second event (same chip, no duplication).
 *   2. Full 4-stage sequence — array length 0 → 1 → 1 → 2 → 2 → 3 → 3
 *      → 4 → 4 across the 8 SSE events the server emits.
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_SCAN_STAGES,
  SCAN_STAGE_LABELS,
  type ScanProgressChipStage,
  type ChipStatus,
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

// Mirror of Scan.tsx's `applyStageEvent` — append a fresh chip on first
// event for an id, otherwise update the existing chip's status in
// place. Exported here so a single source of truth drives the test.
function applyStageEvent(
  prev: ScanProgressChipStage[],
  id: string,
  status: ChipStatus,
): ScanProgressChipStage[] {
  const idx = prev.findIndex((s) => s.id === id);
  if (idx >= 0) {
    const next = prev.slice();
    next[idx] = { ...next[idx], status };
    return next;
  }
  const label = SCAN_STAGE_LABELS[id] ?? id;
  return [...prev, { id, label, status }];
}

check('cold-start: in_progress mounts the chip', () => {
  let stages: ScanProgressChipStage[] = [];
  stages = applyStageEvent(stages, 'analyzing_card', 'in_progress');
  assert.equal(stages.length, 1);
  assert.deepEqual(stages[0], {
    id: 'analyzing_card',
    label: 'Analyzing card',
    status: 'in_progress',
  });
});

check('completion updates same chip, does not duplicate', () => {
  let stages: ScanProgressChipStage[] = [];
  stages = applyStageEvent(stages, 'analyzing_card', 'in_progress');
  stages = applyStageEvent(stages, 'analyzing_card', 'completed');
  assert.equal(stages.length, 1);
  assert.equal(stages[0].status, 'completed');
});

check('full 4-stage sequence: array grows 0→4 progressively', () => {
  let stages: ScanProgressChipStage[] = [];
  // Mount Stage 1
  stages = applyStageEvent(stages, 'analyzing_card', 'in_progress');
  assert.equal(stages.length, 1, 'after stage 1 in_progress');
  // Stage 1 completes — still 1 chip
  stages = applyStageEvent(stages, 'analyzing_card', 'completed');
  assert.equal(stages.length, 1, 'after stage 1 completed');
  // Stage 2 mounts
  stages = applyStageEvent(stages, 'detecting_parallel', 'in_progress');
  assert.equal(stages.length, 2, 'after stage 2 in_progress');
  stages = applyStageEvent(stages, 'detecting_parallel', 'completed');
  assert.equal(stages.length, 2, 'after stage 2 completed');
  // Stage 3 mounts
  stages = applyStageEvent(stages, 'verifying_with_ebay', 'in_progress');
  assert.equal(stages.length, 3, 'after stage 3 in_progress');
  stages = applyStageEvent(stages, 'verifying_with_ebay', 'completed');
  assert.equal(stages.length, 3, 'after stage 3 completed');
  // Stage 4 mounts
  stages = applyStageEvent(stages, 'getting_price', 'in_progress');
  assert.equal(stages.length, 4, 'after stage 4 in_progress');
  stages = applyStageEvent(stages, 'getting_price', 'completed');
  assert.equal(stages.length, 4, 'after stage 4 completed');
  // Final state: all four chips, all completed, in stage order.
  assert.deepEqual(
    stages.map((s) => [s.id, s.status]),
    [
      ['analyzing_card', 'completed'],
      ['detecting_parallel', 'completed'],
      ['verifying_with_ebay', 'completed'],
      ['getting_price', 'completed'],
    ],
  );
});

check('SCAN_STAGE_LABELS covers every DEFAULT_SCAN_STAGES id', () => {
  for (const stage of DEFAULT_SCAN_STAGES) {
    assert.equal(
      SCAN_STAGE_LABELS[stage.id],
      stage.label,
      `label mismatch for ${stage.id}`,
    );
  }
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll progressive-chip-reveal tests passed.');
