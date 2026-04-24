// Pair Brother duplex-scanner pages into (back, front) tuples.
//
// The Brother iPrint&Scan flow we've seen produces pages in strict alternation
// (back, front, back, front, …). The first sheet of a batch lands as page 1
// (back) and page 2 (front), so the default pairing rule is `(pageN, pageN+1)`
// for odd N. We verify that assumption with the side classifier and flag any
// pair whose classifier disagrees with its position so the review queue can
// surface it.
//
// This module is a pure function over a list of pages + their side
// classifications. It does not talk to Drive or the DB. The processor
// passes the paired output downstream.

import type { SideClassification } from './sideClassifier';

export interface ScanPage<FileT> {
  /** 1-based page index in scan order (createdTime asc). */
  position: number;
  file: FileT;
  /** OCR text from the chosen orientation (or pre-rotation if probe skipped). */
  ocrText: string;
  classification: SideClassification;
}

export interface PairedScan<FileT> {
  /** 1-based pair index. pair.position = ceil(leftPage.position / 2). */
  position: number;
  back: ScanPage<FileT> | null;
  front: ScanPage<FileT> | null;
  /**
   * Pairing diagnostic. Populated when the classifier disagrees with the
   * position-based assignment, or when pairing produced an odd-man-out.
   * Empty array means "position and classifier agree".
   */
  warnings: string[];
}

/**
 * Pair pages using the position-based rule with classifier verification.
 *
 * Default rule: odd-indexed page (1, 3, 5, …) is the back of its pair;
 * the following even-indexed page is the front. We re-check each pair
 * against the classifier and apply two corrections:
 *
 *   1. If the classifier says both pages are the same side (e.g. both
 *      look like backs), keep the position assignment but add a
 *      'classifier_disagrees' warning so review surfaces it.
 *   2. If positions N and N+1 were assigned (back, front) but the
 *      classifier is confident the order is actually (front, back), swap
 *      them inside the pair (front/back labels don't affect Drive file
 *      selection order downstream — just which side goes into which slot
 *      of the dual analyzer).
 *
 * An odd number of pages leaves the final page paired with null and
 * flagged 'unpaired_trailing_page' — the processor will send it to
 * review as back-only so the dealer can complete it.
 */
export function pairPages<FileT>(pages: ScanPage<FileT>[]): PairedScan<FileT>[] {
  const pairs: PairedScan<FileT>[] = [];
  for (let i = 0; i < pages.length; i += 2) {
    const left = pages[i];
    const right = i + 1 < pages.length ? pages[i + 1] : null;
    const pairPos = Math.floor(i / 2) + 1;

    if (!right) {
      pairs.push({
        position: pairPos,
        back: left,
        front: null,
        warnings: ['unpaired_trailing_page'],
      });
      continue;
    }

    const warnings: string[] = [];
    let back: ScanPage<FileT> = left;
    let front: ScanPage<FileT> = right;

    const leftVerdict = left.classification.verdict;
    const rightVerdict = right.classification.verdict;

    // Case A: classifier says the pair is reversed (front on the left,
    // back on the right). Swap to honour the classifier — the Brother
    // scanner occasionally feeds a sheet in the opposite direction when
    // the first card in the stack is backwards.
    if (leftVerdict === 'front' && rightVerdict === 'back') {
      back = right;
      front = left;
      warnings.push('swapped_by_classifier');
    } else if (leftVerdict === 'back' && rightVerdict === 'front') {
      // Happy path — position and classifier agree. No warning.
    } else if (leftVerdict === rightVerdict && leftVerdict !== 'unknown') {
      // Both pages look like the same side. Two consecutive backs /
      // fronts usually means either a one-sided card in the stack or
      // a feed jam. Keep position assignment but flag for review.
      warnings.push(`classifier_same_side_${leftVerdict}`);
    } else if (leftVerdict === 'unknown' || rightVerdict === 'unknown') {
      // At least one side is ambiguous; trust position but note it.
      warnings.push('classifier_unknown');
    }

    pairs.push({ position: pairPos, back, front, warnings });
  }
  return pairs;
}
