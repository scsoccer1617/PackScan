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

/**
 * Reorder a list of Drive files so that duplex-scanner pages from the
 * same physical scan job stay contiguous, and odd-count groups don't
 * spill across the boundary into the next job's pages.
 *
 * Background: the Epson duplex scanner saves a stack of pages to one
 * Drive folder using `Epson_<MMDDYYYY><HHMMSS>(N).<ext>`, where every
 * file from one scan run shares the same `<MMDDYYYY><HHMMSS>` prefix
 * and `(N)` increments per page within that run. When a user runs
 * multiple scan jobs into the same inbox folder before pressing Sync,
 * the inbox listing returns all files sorted by `createdTime asc`,
 * which interleaves the second job's `(1), (2), …` between the first
 * job's pages whenever Drive's createdTime resolution drops them in a
 * mixed order. The downstream pairing rule pairs `(2k, 2k+1)` over the
 * GLOBAL list, so cross-job interleaving produces front+front and
 * back+back pairs.
 *
 * Fix: parse the Epson filename, group by prefix, sort within group by
 * sequence number, and concatenate groups in createdTime order. To
 * prevent an odd-count group from sucking the first page of the next
 * group into its pair, we pad odd groups with a `null` slot so the
 * caller's downstream `pages[]` array picks up a `unpaired_trailing_page`
 * instead of crossing the boundary.
 *
 * Files whose names don't match the Epson pattern fall through
 * unchanged in their original order — they're paired by the existing
 * createdTime-asc rule, preserving behaviour for non-Epson scanners.
 *
 * Returned array may contain `null` entries (one per odd-group
 * trailing slot). Callers MUST handle nulls by emitting an orphan
 * pair for that index (no download, no probe).
 */
export interface DuplexFile {
  id: string;
  name: string;
  createdTime: string;
}

export const EPSON_NAME_RE = /^(.+?)\((\d+)\)\.(jpe?g|png)$/i;

export function groupFilesByDuplexBatch<F extends DuplexFile>(files: F[]): (F | null)[] {
  if (files.length === 0) return [];

  type Group = {
    prefix: string;
    items: { file: F; seq: number }[];
    /** earliest createdTime across the group's files; used to order groups. */
    earliestCreatedTime: string;
  };
  const groups = new Map<string, Group>();
  const unmatched: F[] = [];

  for (const f of files) {
    const m = EPSON_NAME_RE.exec(f.name);
    if (!m) {
      unmatched.push(f);
      continue;
    }
    const prefix = m[1];
    const seq = parseInt(m[2], 10);
    if (!Number.isFinite(seq)) {
      unmatched.push(f);
      continue;
    }
    let g = groups.get(prefix);
    if (!g) {
      g = { prefix, items: [], earliestCreatedTime: f.createdTime };
      groups.set(prefix, g);
    }
    g.items.push({ file: f, seq });
    if (f.createdTime < g.earliestCreatedTime) g.earliestCreatedTime = f.createdTime;
  }

  // No Epson-style filenames at all → preserve original order so non-Epson
  // scanners (Brother, single-side iPhone capture, etc.) keep their
  // existing pairing behaviour.
  if (groups.size === 0) return files.slice();

  const ordered = Array.from(groups.values()).sort((a, b) => {
    if (a.earliestCreatedTime !== b.earliestCreatedTime) {
      return a.earliestCreatedTime < b.earliestCreatedTime ? -1 : 1;
    }
    return a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0;
  });

  const out: (F | null)[] = [];
  for (const g of ordered) {
    g.items.sort((a, b) => a.seq - b.seq);
    for (const it of g.items) out.push(it.file);
    // Pad odd-count groups with a null slot so the next group starts on
    // an even boundary and can't be sucked into a cross-batch pair.
    if (g.items.length % 2 === 1) out.push(null);
  }
  // Append any non-Epson stragglers at the tail in their input order.
  for (const f of unmatched) out.push(f);
  return out;
}

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
 * Default rule (Brother iPrint&Scan): odd-indexed page (1, 3, 5, …) is the
 * back of its pair; the following even-indexed page is the front.
 *
 * Epson exception: when BOTH pages of the pair carry Epson-style filenames
 * (`<prefix>(N).<ext>`), the user's Epson convention is the opposite —
 * odd=front, even=back — so the position default is inverted to
 * `(left=front, right=back)`. The classifier-override branches below are
 * symmetric against whichever default applied, so the same verdict
 * combinations produce correct outcomes either way.
 *
 * Corrections applied (independent of which default):
 *
 *   1. If the classifier confidently disagrees with the position default
 *      (i.e. it says front is actually on the side we labelled back, and
 *      vice versa), swap with a `swapped_by_classifier` warning.
 *   2. If both pages classify as the same side, keep the position
 *      assignment and flag `classifier_same_side_*` for review.
 *   3. If at least one side is ambiguous, keep the position assignment
 *      and flag `classifier_unknown` — the Gemini `frontImageIndex`
 *      recovery path in `processor.ts` may still flip it.
 *
 * An odd number of pages leaves the final page paired with null and
 * flagged 'unpaired_trailing_page' — the processor will send it to
 * review as back-only so the dealer can complete it.
 */
export function pairPages<FileT extends { name?: string }>(
  pages: ScanPage<FileT>[],
): PairedScan<FileT>[] {
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

    // Detect Epson-style naming on BOTH pages. When both match, the user's
    // scanner produces (1)=front, (2)=back — invert the position default.
    // Mixed naming (one Epson, one not) falls back to the Brother default
    // because we can't safely assume Epson convention applies.
    const bothEpson =
      typeof left.file.name === 'string' &&
      typeof right.file.name === 'string' &&
      EPSON_NAME_RE.test(left.file.name) &&
      EPSON_NAME_RE.test(right.file.name);

    const warnings: string[] = [];
    // Position-based default: Brother → (left=back, right=front);
    // Epson → (left=front, right=back).
    let back: ScanPage<FileT> = bothEpson ? right : left;
    let front: ScanPage<FileT> = bothEpson ? left : right;

    const leftVerdict = left.classification.verdict;
    const rightVerdict = right.classification.verdict;

    // Classifier verdict that DISAGREES with the position default → swap.
    //   Brother default: (left=back, right=front). Disagreement looks like
    //     leftVerdict='front' && rightVerdict='back'.
    //   Epson default:   (left=front, right=back). Disagreement looks like
    //     leftVerdict='back' && rightVerdict='front'.
    const positionDisagreesBrother =
      !bothEpson && leftVerdict === 'front' && rightVerdict === 'back';
    const positionDisagreesEpson =
      bothEpson && leftVerdict === 'back' && rightVerdict === 'front';
    const positionAgreesBrother =
      !bothEpson && leftVerdict === 'back' && rightVerdict === 'front';
    const positionAgreesEpson =
      bothEpson && leftVerdict === 'front' && rightVerdict === 'back';

    if (positionDisagreesBrother || positionDisagreesEpson) {
      // Swap: classifier says the pair is reversed relative to the
      // position default. Flip back/front inside the pair.
      const oldBack = back;
      back = front;
      front = oldBack;
      warnings.push('swapped_by_classifier');
    } else if (positionAgreesBrother || positionAgreesEpson) {
      // Happy path — position default and classifier agree. No warning.
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
