/**
 * PR P — unit tests for the auto-scroll guard logic in
 * client/src/pages/Scan.tsx. Mirrors the inline closures the page uses
 * so we can exercise the "wheel/touch/keyboard event flips
 * userScrolledManually true and stays false otherwise" contract
 * without spinning up a DOM.
 *
 * Run via:
 *
 *   npx tsx server/__tests__/autoScrollGuard.test.ts
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

// Mirror of Scan.tsx's user-scroll detector. Returns the resulting
// state of `userScrolledManually` after applying an event sequence.
interface GuardState {
  userScrolledManually: boolean;
  programmaticScrolling: boolean;
}

function makeGuard(): GuardState {
  return { userScrolledManually: false, programmaticScrolling: false };
}

function dispatchWheel(state: GuardState): void {
  // Wheel events ignore the programmaticScrolling flag — they're
  // always user-initiated by definition.
  state.userScrolledManually = true;
}

function dispatchTouchMove(state: GuardState): void {
  state.userScrolledManually = true;
}

function dispatchKey(state: GuardState, key: string): void {
  const SCROLL_KEYS = new Set([
    'PageDown',
    'PageUp',
    'ArrowDown',
    'ArrowUp',
    'Home',
    'End',
    ' ',
    'Spacebar',
  ]);
  if (SCROLL_KEYS.has(key)) state.userScrolledManually = true;
}

function dispatchScroll(state: GuardState): void {
  if (state.programmaticScrolling) return;
  state.userScrolledManually = true;
}

function beforeAutoScroll(state: GuardState): void {
  state.programmaticScrolling = true;
}

function afterAutoScrollSettle(state: GuardState): void {
  state.programmaticScrolling = false;
}

check('cold start: guard is false', () => {
  const s = makeGuard();
  assert.equal(s.userScrolledManually, false);
});

check('wheel event flips guard true', () => {
  const s = makeGuard();
  dispatchWheel(s);
  assert.equal(s.userScrolledManually, true);
});

check('touchmove flips guard true', () => {
  const s = makeGuard();
  dispatchTouchMove(s);
  assert.equal(s.userScrolledManually, true);
});

check('PageDown / Space / Arrow keys flip guard true', () => {
  for (const key of ['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', ' ']) {
    const s = makeGuard();
    dispatchKey(s, key);
    assert.equal(s.userScrolledManually, true, `key ${key}`);
  }
});

check('non-scroll key does not flip guard', () => {
  const s = makeGuard();
  dispatchKey(s, 'a');
  dispatchKey(s, 'Enter');
  assert.equal(s.userScrolledManually, false);
});

check('programmatic scroll does NOT flip guard while flag is up', () => {
  const s = makeGuard();
  beforeAutoScroll(s);
  // Simulate the smooth-scroll animation firing scroll events.
  dispatchScroll(s);
  dispatchScroll(s);
  assert.equal(s.userScrolledManually, false);
  // After the timer settles, subsequent scroll events without an
  // owner are user-initiated and DO flip the guard.
  afterAutoScrollSettle(s);
  dispatchScroll(s);
  assert.equal(s.userScrolledManually, true);
});

check('once flipped true, autoScrollEnabled (=!guard) stays false for the scan', () => {
  const s = makeGuard();
  dispatchWheel(s);
  // Subsequent chip mounts read the flag — they should NOT auto-scroll.
  const autoScrollEnabled = !s.userScrolledManually;
  assert.equal(autoScrollEnabled, false);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll auto-scroll guard tests passed.');
