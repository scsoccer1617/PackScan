/**
 * PR U — ScanInfoHeader is now driven REACTIVELY by props (each field
 * fills its slot the moment the prop becomes non-empty), with no
 * client-side stagger timer. Tests render the component to a static
 * HTML string and assert which slots contain values vs. skeletons as
 * fields stream in.
 *
 * Run via:
 *   npx tsx server/__tests__/prUScanInfoHeaderReactive.test.ts
 */

import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ScanInfoHeader,
  type ScanInfoHeaderFields,
} from '../../client/src/components/ScanInfoHeader';

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

function render(fields: ScanInfoHeaderFields): string {
  return renderToStaticMarkup(
    React.createElement(ScanInfoHeader, { fields }),
  );
}

// All-empty: every slot is a skeleton.
check('empty fields → all six slots render as skeletons', () => {
  const html = render({});
  for (const slot of ['year', 'brand', 'set', 'collection', 'card-number', 'player']) {
    assert.match(
      html,
      new RegExp(`scan-info-header-${slot}-skeleton`),
      `expected ${slot} skeleton`,
    );
  }
});

// One field populated: that slot renders text, others stay skeleton.
check('only year present → year is text, rest are skeletons', () => {
  const html = render({ year: 2026 });
  assert.match(html, /scan-info-header-year[^-]/);
  assert.match(html, />2026</);
  for (const slot of ['brand', 'set', 'collection', 'card-number', 'player']) {
    assert.match(
      html,
      new RegExp(`scan-info-header-${slot}-skeleton`),
      `${slot} should still be skeleton`,
    );
  }
});

// Out-of-order: server emits set BEFORE year. Set's slot renders;
// year stays skeleton even though set is in display position 3.
check('out-of-order arrival → only filled fields are rendered', () => {
  const html = render({ set: 'Series One' });
  assert.match(html, />Series One</);
  // year is still a skeleton.
  assert.match(html, /scan-info-header-year-skeleton/);
  assert.match(html, /scan-info-header-brand-skeleton/);
});

// All six populated: every slot has its value, no skeletons.
check('all fields present → all six slots show values', () => {
  const html = render({
    year: 2026,
    brand: 'Topps',
    set: 'Series One',
    collection: 'Base Set',
    cardNumber: '#100',
    player: 'Mike Trout',
  });
  // No skeletons.
  for (const slot of ['year', 'brand', 'set', 'collection', 'card-number', 'player']) {
    assert.doesNotMatch(
      html,
      new RegExp(`scan-info-header-${slot}-skeleton`),
      `${slot} skeleton should be gone`,
    );
  }
  assert.match(html, />2026</);
  assert.match(html, />Topps</);
  assert.match(html, />Series One</);
  assert.match(html, />Base Set</);
  assert.match(html, />#100</);
  assert.match(html, />Mike Trout</);
});

// Card number is auto-prefixed with `#` when not already present.
check('cardNumber without # gets a leading # in the rendered slot', () => {
  const html = render({ cardNumber: '100' });
  assert.match(html, />#100</);
});
check('cardNumber already starting with # is preserved verbatim', () => {
  const html = render({ cardNumber: '#100' });
  assert.match(html, />#100</);
  // No double-hash.
  assert.doesNotMatch(html, />##100</);
});

// Reduced motion no longer requires a forced flag — fields are always
// reactive — but the prop still types-check (back-compat with PR S/T
// callers).
check('forceReducedMotion / revealStaggerMs props are accepted (back-compat)', () => {
  const html = renderToStaticMarkup(
    React.createElement(ScanInfoHeader, {
      fields: { year: 2026, brand: 'Topps' },
      forceReducedMotion: true,
      revealStaggerMs: 0,
    }),
  );
  assert.match(html, />2026</);
  assert.match(html, />Topps</);
});

// `showSkeletons={false}` collapses empty slots to em-dashes.
check('showSkeletons=false renders empty slots as em-dash placeholders', () => {
  const html = renderToStaticMarkup(
    React.createElement(ScanInfoHeader, {
      fields: { year: 2026 },
      showSkeletons: false,
    }),
  );
  // Skeletons are gone.
  assert.doesNotMatch(html, /scan-info-header-brand-skeleton/);
  // Em-dash placeholder is rendered for missing slots.
  assert.match(html, />—</);
});

// Reactive rendering contract: each field is independently driven by
// its slot's value. Simulate three successive prop updates as SSE
// events would land them, asserting each step.
check('streaming sequence: each successive prop update fills one more slot', () => {
  // Step 1: only year arrives.
  const step1 = render({ year: 2026 });
  assert.match(step1, />2026</);
  assert.match(step1, /scan-info-header-brand-skeleton/);

  // Step 2: brand also arrives.
  const step2 = render({ year: 2026, brand: 'Topps' });
  assert.match(step2, />2026</);
  assert.match(step2, />Topps</);
  assert.match(step2, /scan-info-header-set-skeleton/);

  // Step 3: set arrives. The first three slots are now filled.
  const step3 = render({ year: 2026, brand: 'Topps', set: 'Series One' });
  assert.match(step3, />2026</);
  assert.match(step3, />Topps</);
  assert.match(step3, />Series One</);
  assert.match(step3, /scan-info-header-collection-skeleton/);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll PR U ScanInfoHeader reactive rendering tests passed.');
