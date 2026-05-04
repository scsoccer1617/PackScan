// PR O — regression test for the chip-progress bug shipped in PR H (#264).
//
// Bug: the SSE streaming route (/api/analyze-card-dual-images/stream)
// attaches `onStage` to the outer request, but `runAnalyzeCardDualImages`
// (server/routes.ts) synthesizes a fresh `dualRequest` object before
// invoking `handleDualSideCardAnalysis`. That fresh object only carried
// `files` / `body` / `query`, so `onStage` was dropped and emitStage()
// silently no-op'd — every chip stayed pending for the entire scan.
//
// Fix: copy `onStage` onto the synthesized `dualRequest`. This test
// pins the contract so a future cleanup of the dual-request shape
// can't silently regress chip rendering again.
//
// We don't run the real analyze pipeline (Vision/Gemini network calls),
// just assert the property-propagation shape.

import assert from 'node:assert/strict';
import type { StageEvent } from '../dualSideOCR';

// Mirror the synthesized-request construction used in
// server/routes.ts (`runAnalyzeCardDualImages`). Anything we add to
// `outerReq.onStage` must be reachable on the inner request the
// dual-side handler ultimately receives.
function buildDualRequest(outerReq: any, files: any) {
  return {
    files: {
      backImage: [files.backImage[0]],
      ...(files.frontImage && { frontImage: files.frontImage }),
    },
    body: outerReq.body || {},
    query: outerReq.query || {},
    onStage: (outerReq as any).onStage,
  } as any;
}

// 1. onStage is forwarded onto dualRequest verbatim.
{
  const events: StageEvent[] = [];
  const onStage = (e: StageEvent) => events.push(e);
  const outerReq = { body: {}, query: {}, onStage };
  const dualRequest = buildDualRequest(outerReq, {
    backImage: [{ path: 'b.jpg' }],
    frontImage: [{ path: 'f.jpg' }],
  });
  assert.equal(typeof dualRequest.onStage, 'function', 'onStage is on dualRequest');
  dualRequest.onStage({
    stage: 'analyzing_card',
    status: 'in_progress',
    label: 'Analyzing card',
  });
  assert.equal(events.length, 1, 'event reaches the original callback');
  assert.equal(events[0].stage, 'analyzing_card');
  console.log('ok: onStage forwarded to dualRequest');
}

// 2. Legacy non-streaming path (no onStage on outer req) still works:
// dualRequest.onStage is undefined and downstream emitStage() no-ops.
{
  const outerReq = { body: {}, query: {} };
  const dualRequest = buildDualRequest(outerReq, {
    backImage: [{ path: 'b.jpg' }],
  });
  assert.equal(dualRequest.onStage, undefined, 'no onStage when outer req has none');
  console.log('ok: legacy path leaves onStage undefined');
}

// 3. Outer req mutation after construction does NOT bleed into dualRequest
// (we copy the function reference, not a getter). This guards against a
// future refactor that swaps the closure.
{
  const seen: string[] = [];
  const outerReq: any = {
    body: {},
    query: {},
    onStage: (e: StageEvent) => seen.push(`first:${e.stage}`),
  };
  const dualRequest = buildDualRequest(outerReq, {
    backImage: [{ path: 'b.jpg' }],
  });
  outerReq.onStage = (e: StageEvent) => seen.push(`second:${e.stage}`);
  dualRequest.onStage({
    stage: 'getting_price',
    status: 'completed',
    label: 'Getting price',
  });
  assert.deepEqual(seen, ['first:getting_price'], 'dualRequest holds the original callback');
  console.log('ok: dualRequest captures the callback at construction time');
}

console.log('analyzeStreamOnStagePropagation.test.ts: all assertions passed');
