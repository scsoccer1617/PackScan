/**
 * PR W — ScanInfoHeader player-first reorder + "Card Info" heading.
 *
 * Stage-1 stream order is determined by Gemini's JSON emit order
 * (Player typically arrives last). The header now pins Player to slot
 * 1 so the user always sees the most identifying field first
 * regardless of which order the others fill in. Display order:
 *   Player · Year · Brand · Set · Collection · #
 *
 * Run via: npx tsx server/__tests__/prWScanInfoHeaderPlayerFirst.test.ts
 */

import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ScanInfoHeader,
  SCAN_INFO_HEADER_FIELD_ORDER,
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

check('field order constant has player at slot 1', () => {
  assert.equal(SCAN_INFO_HEADER_FIELD_ORDER[0], 'player');
  assert.deepEqual(
    [...SCAN_INFO_HEADER_FIELD_ORDER],
    ['player', 'year', 'brand', 'set', 'collection', 'cardNumber'],
  );
});

check('rendered DOM places player slot before year/brand/set/collection/cardNumber', () => {
  const html = renderToStaticMarkup(
    React.createElement(ScanInfoHeader, {
      fields: {
        year: 2026,
        brand: 'Topps',
        set: 'Series One',
        collection: 'Gold',
        cardNumber: '#100',
        player: 'Mike Trout',
      },
    }),
  );
  const indices = {
    player: html.indexOf('scan-info-header-player'),
    year: html.indexOf('scan-info-header-year'),
    brand: html.indexOf('scan-info-header-brand'),
    set: html.indexOf('scan-info-header-set'),
    collection: html.indexOf('scan-info-header-collection'),
    cardNumber: html.indexOf('scan-info-header-card-number'),
  };
  // Every slot must appear in the DOM.
  for (const [k, v] of Object.entries(indices)) {
    assert.ok(v >= 0, `${k} slot not found in rendered output`);
  }
  // Player must precede every other slot.
  assert.ok(indices.player < indices.year, 'player should precede year');
  assert.ok(indices.player < indices.brand, 'player should precede brand');
  assert.ok(indices.player < indices.set, 'player should precede set');
  assert.ok(indices.player < indices.collection, 'player should precede collection');
  assert.ok(
    indices.player < indices.cardNumber,
    'player should precede cardNumber',
  );
});

check('heading reads "Card Info" (replaces pre-PR-W "Identifying card")', () => {
  const html = renderToStaticMarkup(
    React.createElement(ScanInfoHeader, { fields: {} }),
  );
  assert.match(html, />Card Info</);
  assert.doesNotMatch(html, />Identifying card</);
});

check('player arrives last in stream — slot 1 still updates from skeleton to value', () => {
  // Stage-1 stream order is unpredictable; even if year/brand/set land
  // before player, the player slot is the FIRST in DOM order. Skeleton
  // until the prop fills, then the slot transitions.
  const before = renderToStaticMarkup(
    React.createElement(ScanInfoHeader, {
      fields: { year: 2026, brand: 'Topps', set: 'Series One', collection: 'Gold', cardNumber: '#100' },
    }),
  );
  assert.match(before, /scan-info-header-player-skeleton/);
  // Player slot is still position 1 in the DOM even when empty.
  const playerIdx = before.indexOf('scan-info-header-player');
  const yearIdx = before.indexOf('scan-info-header-year');
  assert.ok(playerIdx < yearIdx, 'player slot stays in position 1 even as skeleton');

  const after = renderToStaticMarkup(
    React.createElement(ScanInfoHeader, {
      fields: {
        year: 2026,
        brand: 'Topps',
        set: 'Series One',
        collection: 'Gold',
        cardNumber: '#100',
        player: 'Mike Trout',
      },
    }),
  );
  assert.doesNotMatch(after, /scan-info-header-player-skeleton/);
  assert.match(after, />Mike Trout</);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll PR W ScanInfoHeader player-first tests passed.');
