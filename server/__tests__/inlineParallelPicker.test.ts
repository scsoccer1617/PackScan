/**
 * PR Q — Tests the render-condition + label-resolution logic for the
 * inline parallel picker. The picker mounts as soon as the streaming
 * `detecting_parallel:completed` event arrives with a `data` payload,
 * even when the variant is null/empty (renders "Base" so the user
 * always gets feedback that detection finished).
 *
 * Mirrors:
 *   - client/src/components/InlineParallelPicker.tsx (label resolver)
 *   - client/src/pages/Scan.tsx (SSE → setInlineParallel reducer)
 *
 * Run via:
 *   npx tsx server/__tests__/inlineParallelPicker.test.ts
 */

import assert from 'node:assert/strict';

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

interface InlineParallelData {
  variant: string | null;
  foilType: string | null;
  confidence: number | null;
}

// Mirror of Scan.tsx's reducer when a `detecting_parallel:completed`
// event arrives. Returns null when the event has no `data` payload
// (legacy server) or the picker is being reset.
function reduceStageEvent(
  prev: InlineParallelData | null,
  event: {
    type?: string;
    stage?: string;
    status?: string;
    data?: Partial<InlineParallelData>;
  } | null,
): InlineParallelData | null {
  if (!event || event.type !== 'stage') return prev;
  if (event.stage !== 'detecting_parallel') return prev;
  if (event.status !== 'completed') return prev;
  if (!event.data || typeof event.data !== 'object') return prev;
  const d = event.data;
  return {
    variant:
      typeof d.variant === 'string' && d.variant.length > 0 ? d.variant : null,
    foilType:
      typeof d.foilType === 'string' && d.foilType.length > 0 ? d.foilType : null,
    confidence: typeof d.confidence === 'number' ? d.confidence : null,
  };
}

// Mirror of InlineParallelPicker.tsx's displayLabel() — the picker
// renders this string whenever it's open.
function displayLabel(
  variant: string | null,
  foilType: string | null | undefined,
): string {
  const v = (variant ?? '').trim();
  if (v) return v;
  const f = (foilType ?? '').trim();
  if (f) return f;
  return 'Base';
}

check('no data payload (legacy server) keeps picker hidden', () => {
  const next = reduceStageEvent(null, {
    type: 'stage',
    stage: 'detecting_parallel',
    status: 'completed',
  });
  assert.equal(next, null);
});

check('detecting_parallel:in_progress does NOT mount the picker yet', () => {
  const next = reduceStageEvent(null, {
    type: 'stage',
    stage: 'detecting_parallel',
    status: 'in_progress',
    data: { variant: 'Pink Refractor', foilType: null, confidence: 0.9 },
  });
  assert.equal(next, null);
});

check('other stages (analyzing_card, getting_price) do NOT touch picker state', () => {
  const seeded: InlineParallelData = {
    variant: 'Gold',
    foilType: null,
    confidence: 0.9,
  };
  const next = reduceStageEvent(seeded, {
    type: 'stage',
    stage: 'analyzing_card',
    status: 'completed',
    data: { variant: 'Gold', foilType: null, confidence: 1 } as any,
  });
  assert.deepEqual(next, seeded);
});

check('detecting_parallel:completed with variant mounts picker', () => {
  const next = reduceStageEvent(null, {
    type: 'stage',
    stage: 'detecting_parallel',
    status: 'completed',
    data: { variant: 'Pink Refractor', foilType: null, confidence: 0.9 },
  });
  assert.deepEqual(next, {
    variant: 'Pink Refractor',
    foilType: null,
    confidence: 0.9,
  });
  assert.equal(displayLabel(next!.variant, next!.foilType), 'Pink Refractor');
});

check('detecting_parallel:completed with empty variant renders Base', () => {
  const next = reduceStageEvent(null, {
    type: 'stage',
    stage: 'detecting_parallel',
    status: 'completed',
    data: { variant: '', foilType: '', confidence: null },
  });
  assert.deepEqual(next, { variant: null, foilType: null, confidence: null });
  assert.equal(displayLabel(next!.variant, next!.foilType), 'Base');
});

check('detecting_parallel:completed with foilType only falls through to foilType', () => {
  const next = reduceStageEvent(null, {
    type: 'stage',
    stage: 'detecting_parallel',
    status: 'completed',
    data: { variant: null, foilType: 'Refractor', confidence: 0.7 },
  });
  assert.equal(displayLabel(next!.variant, next!.foilType), 'Refractor');
});

check('a later stage with a corrected variant updates picker in place', () => {
  // First event mounts with the analyzer's first guess.
  let state = reduceStageEvent(null, {
    type: 'stage',
    stage: 'detecting_parallel',
    status: 'completed',
    data: { variant: 'Refractor', foilType: 'Refractor', confidence: 0.6 },
  });
  assert.equal(state!.variant, 'Refractor');
  // Imagine search-verify later corrects to "Pink Refractor". The
  // server emits a fresh detecting_parallel:completed (rare, but the
  // contract supports it). State updates without remount.
  state = reduceStageEvent(state, {
    type: 'stage',
    stage: 'detecting_parallel',
    status: 'completed',
    data: { variant: 'Pink Refractor', foilType: null, confidence: 0.95 },
  });
  assert.equal(state!.variant, 'Pink Refractor');
  assert.equal(state!.foilType, null);
});

check('non-stage events (result, error) leave picker untouched', () => {
  const seeded: InlineParallelData = {
    variant: 'Gold',
    foilType: null,
    confidence: 0.9,
  };
  assert.deepEqual(
    reduceStageEvent(seeded, { type: 'result', stage: undefined as any }),
    seeded,
  );
  assert.deepEqual(
    reduceStageEvent(seeded, { type: 'error' } as any),
    seeded,
  );
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll inline-parallel-picker tests passed.');
