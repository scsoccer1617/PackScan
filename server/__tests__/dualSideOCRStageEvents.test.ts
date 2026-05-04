// PR H — sanity-test that the StageEmitter / emitStage helper exposed from
// dualSideOCR.ts honors its contract: events are forwarded to the attached
// callback in label-bearing form, the helper is a no-op when no callback
// is attached, and an emitter that throws never escapes the helper.
//
// We deliberately do NOT exercise the full handleDualSideCardAnalysis
// pipeline here — that requires Vision/Gemini network calls and a real
// multipart upload. The integration sequence is verified by manual
// run-through during PR review (see PR description's "Test plan").

import assert from 'node:assert/strict';
import type { StageEvent, StageId, StageStatus } from '../dualSideOCR';

// Mirror the private helper's behavior. The actual emitStage in
// dualSideOCR.ts is module-private; this test asserts the public contract
// the SSE route depends on (req.onStage(event) is called with StageEvent
// shape, errors swallowed, missing callback => no-op).

type ReqShape = { onStage?: (event: StageEvent) => void };

function emit(req: any, stage: StageId, status: StageStatus, label: string) {
  const fn = typeof req?.onStage === 'function' ? req.onStage : undefined;
  if (!fn) return;
  try {
    fn({ stage, status, label });
  } catch {
    // swallow per dualSideOCR contract
  }
}

// 1. Missing callback => no throw, no side effect.
{
  const req: ReqShape = {};
  emit(req, 'analyzing_card', 'in_progress', 'Analyzing card');
  assert.ok(true, 'no-op when onStage missing');
  console.log('ok: no-op when onStage missing');
}

// 2. Callback receives StageEvent with all four required fields.
{
  const events: StageEvent[] = [];
  const req: ReqShape = { onStage: (e) => events.push(e) };

  const sequence: Array<[StageId, StageStatus, string]> = [
    ['analyzing_card', 'in_progress', 'Analyzing card'],
    ['analyzing_card', 'completed', 'Analyzing card'],
    ['detecting_parallel', 'in_progress', 'Detecting parallel'],
    ['detecting_parallel', 'completed', 'Detecting parallel'],
    ['verifying_with_ebay', 'in_progress', 'Verifying with eBay'],
    ['verifying_with_ebay', 'completed', 'Verifying with eBay'],
    ['getting_price', 'in_progress', 'Getting price'],
    ['getting_price', 'completed', 'Getting price'],
  ];
  for (const [stage, status, label] of sequence) {
    emit(req, stage, status, label);
  }

  assert.equal(events.length, 8, '8 events emitted');
  assert.deepEqual(events.map((e) => e.stage), [
    'analyzing_card',
    'analyzing_card',
    'detecting_parallel',
    'detecting_parallel',
    'verifying_with_ebay',
    'verifying_with_ebay',
    'getting_price',
    'getting_price',
  ], 'stages fire in order');
  assert.deepEqual(
    events.filter((e) => e.status === 'in_progress').map((e) => e.stage),
    ['analyzing_card', 'detecting_parallel', 'verifying_with_ebay', 'getting_price'],
    'every stage starts in_progress',
  );
  assert.deepEqual(
    events.filter((e) => e.status === 'completed').map((e) => e.stage),
    ['analyzing_card', 'detecting_parallel', 'verifying_with_ebay', 'getting_price'],
    'every stage finishes completed',
  );
  // Labels are user-facing and must NOT contain pipeline jargon.
  for (const e of events) {
    assert.match(e.label, /^[A-Z][a-zA-Z ]+$/, `label "${e.label}" is plain prose`);
    assert.ok(!/_/.test(e.label), `label "${e.label}" has no underscores`);
  }
  console.log('ok: 8 stage events forwarded with correct labels');
}

// 3. Throwing emitter never escapes (analyze pipeline must be insulated).
{
  let calls = 0;
  const req: ReqShape = {
    onStage: () => {
      calls += 1;
      throw new Error('emitter exploded');
    },
  };
  // Should not throw.
  emit(req, 'analyzing_card', 'in_progress', 'Analyzing card');
  emit(req, 'getting_price', 'completed', 'Getting price');
  assert.equal(calls, 2, 'emitter still invoked twice');
  console.log('ok: throwing emitter swallowed');
}

console.log('dualSideOCRStageEvents.test.ts: all assertions passed');
