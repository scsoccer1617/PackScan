/**
 * PR Q — extends the PR P auto-scroll guard tests with the
 * delta-threshold + programmatic-window behavior introduced to fix
 * the iOS Safari regression where stage-3/4 chips never came into
 * view after stage 2 completed.
 *
 * Behavior under test (mirrors client/src/pages/Scan.tsx):
 *   - Scrolls smaller than SCROLL_DELTA_PX (10) are treated as
 *     synthetic noise (iOS rubber-band, address-bar collapse) and
 *     do NOT flip the guard.
 *   - Scrolls >= SCROLL_DELTA_PX outside the programmatic window DO
 *     flip the guard (real user scroll).
 *   - Programmatic-scroll window is widened to 800ms (was 600ms in
 *     PR P) and the baseline scrollY is snapshot at window-open so
 *     deltas after the smooth-scroll animation settles are measured
 *     from the chip's settled position, not the original page top.
 *
 * Run via:
 *   npx tsx server/__tests__/autoScrollGuardPrQ.test.ts
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

// Mirror of Scan.tsx's PR Q user-scroll detector. We model just the
// scroll-event branch here — wheel/touch/keyboard branches are
// covered exhaustively by autoScrollGuard.test.ts.
const SCROLL_DELTA_PX = 10;

interface GuardState {
  userScrolledManually: boolean;
  programmaticScrolling: boolean;
  lastScrollY: number;
  scrollY: number;
}

function makeGuard(): GuardState {
  return {
    userScrolledManually: false,
    programmaticScrolling: false,
    lastScrollY: 0,
    scrollY: 0,
  };
}

function beforeAutoScroll(state: GuardState): void {
  state.programmaticScrolling = true;
  state.lastScrollY = state.scrollY;
}

function settleProgrammaticWindow(state: GuardState): void {
  state.programmaticScrolling = false;
}

function dispatchScroll(state: GuardState, newY: number): void {
  state.scrollY = newY;
  if (state.programmaticScrolling) {
    state.lastScrollY = state.scrollY;
    return;
  }
  const delta = Math.abs(state.scrollY - state.lastScrollY);
  state.lastScrollY = state.scrollY;
  if (delta < SCROLL_DELTA_PX) return;
  state.userScrolledManually = true;
}

check('synthetic small scroll (3px) does NOT flip the guard', () => {
  const s = makeGuard();
  dispatchScroll(s, 3);
  assert.equal(s.userScrolledManually, false);
});

check('a series of small scrolls (1-9px each) does NOT flip the guard', () => {
  const s = makeGuard();
  for (const y of [1, 4, 8, 5, 2, 9]) {
    dispatchScroll(s, y);
  }
  assert.equal(s.userScrolledManually, false);
});

check('a single >=10px scroll flips the guard', () => {
  const s = makeGuard();
  dispatchScroll(s, 14);
  assert.equal(s.userScrolledManually, true);
});

check('programmatic scrolls during window do not flip the guard', () => {
  const s = makeGuard();
  beforeAutoScroll(s);
  dispatchScroll(s, 200); // smooth-scroll animation lands chip at y=200
  dispatchScroll(s, 220); // small overshoot
  assert.equal(s.userScrolledManually, false);
  // After the window settles, the lastScrollY baseline is the chip's
  // settled position. A real scroll from there flips the guard.
  settleProgrammaticWindow(s);
  dispatchScroll(s, 350); // user scrolled +130 from settled baseline
  assert.equal(s.userScrolledManually, true);
});

check('user scroll smaller than threshold AFTER programmatic window does not flip', () => {
  const s = makeGuard();
  beforeAutoScroll(s);
  dispatchScroll(s, 200);
  settleProgrammaticWindow(s);
  // 5px nudge — still under threshold
  dispatchScroll(s, 205);
  assert.equal(s.userScrolledManually, false);
});

check('back-to-back programmatic scrolls (multiple chips) keep guard false', () => {
  const s = makeGuard();
  // Chip 1 mounts
  beforeAutoScroll(s);
  dispatchScroll(s, 100);
  settleProgrammaticWindow(s);
  // Chip 2 mounts shortly after
  beforeAutoScroll(s);
  dispatchScroll(s, 220);
  settleProgrammaticWindow(s);
  // Chip 3 mounts
  beforeAutoScroll(s);
  dispatchScroll(s, 340);
  settleProgrammaticWindow(s);
  assert.equal(s.userScrolledManually, false);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll PR Q auto-scroll guard tests passed.');
