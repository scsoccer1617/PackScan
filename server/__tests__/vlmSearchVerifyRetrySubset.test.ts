import assert from 'node:assert/strict';
import { isMaterialSetChange } from '../vlmSearchVerifyApply';

const cases: Array<[string | null | undefined, string | null | undefined, boolean, string]> = [
  ['Upper Deck', 'Upper Deck Minor League', true, 'tokens added (minor league)'],
  ['Upper Deck Minor League', 'Upper Deck', true, 'tokens removed (minor league)'],
  ['Series One', 'Series 1', false, 'stylistic — should not be material'],
  ['Topps Chrome', 'Topps Chrome', false, 'identical'],
  [null, 'Upper Deck Minor League', true, 'added Set when none'],
  ['Upper Deck', null, false, 'no correction'],
  ['Upper Deck', '', false, 'empty correction'],
  ['Topps', 'Bowman', true, 'disjoint'],
  ['  Upper Deck  ', 'Upper Deck Minor League', true, 'whitespace tolerance'],
];

for (const [o, c, expected, label] of cases) {
  const got = isMaterialSetChange(o, c);
  assert.equal(got, expected, `isMaterialSetChange(${JSON.stringify(o)}, ${JSON.stringify(c)}) — ${label}`);
  console.log(`ok: ${label}`);
}
console.log('ALL OK');
