/**
 * Parallel discovery from SportsCardsPro.
 *
 * Existing behavior (pre-PR #38b): when Holo detected a color parallel,
 * the client showed the scanner's local `parallels` DB. If the local
 * keyword filter returned zero hits, the client fell back to showing
 * ALL parallels in the DB — which for a modern Topps set is hundreds
 * of options, most of them in the wrong color.
 *
 * New behavior: before we fall back to the local DB, we ask SCP what
 * parallels actually exist for this card. SCP's search endpoint returns
 * one row per parallel-variant of a card — e.g. Michael Petersen US49
 * has 51 rows (Gold Rainbow Foil, Pink, Yellow, Sandglitter, …). We
 * parse the [Bracketed] parallel off each row, de-dupe, and optionally
 * filter by a canonical color bucket so the picker shows only the
 * parallels that could plausibly match what Holo saw.
 *
 * This keeps the local DB as a true emergency fallback (SCP down, no
 * matches, or dev without a token) rather than the happy path.
 */

import { searchProducts } from "./client";
import {
  buildSearchQuery,
  extractCardNumber,
  extractParallel,
  type ScanQueryInput,
} from "./match";
import {
  normalizeParallel,
  parallelsMatch,
  isColorBucket,
  type CanonicalParallel,
} from "./colorSynonyms";

/**
 * Synthetic label for the no-bracket base entry SCP returns for a card.
 * On many modern Topps inserts (Ohtani ASG-1, Mayer U90-9) the base IS
 * the rainbow/multi-colour parallel that a dealer owns — so the picker
 * must offer it as a first-class option rather than leaving it implicit.
 * The label is displayed verbatim to the dealer.
 */
export const BASE_RAINBOW_LABEL = "Base / Rainbow Foil";

export interface DiscoveredParallel {
  /** Exact string from SCP's [brackets], e.g. "Pink Wave", "Gold Crackle Foil".
   *  For the synthetic base entry this is `BASE_RAINBOW_LABEL`. */
  label: string;
  /** Canonical bucket per colorSynonyms, or null if un-bucketable. */
  canonical: CanonicalParallel | null;
  /** SCP product id of one candidate that has this parallel (most-specific
   *  match). Useful if the client wants to immediately pull pricing. */
  productId: string;
  /** SCP's full console-name of that candidate, for UI disambiguation
   *  when two different SCP products share a parallel label. */
  consoleName: string;
}

export interface DiscoverOptions {
  /**
   * If provided, return only parallels whose canonical bucket matches
   * this value. Pass the scanner's normalized detected color (e.g. "Pink").
   * Non-color buckets (Refractor, Autograph) are accepted and will
   * still filter strictly.
   *
   * If the filter is a color bucket and NO candidates remain after
   * filtering, we return the unfiltered list with a warning \u2014 this
   * avoids the original bug where a 0-hit color filter left the UI
   * completely empty.
   */
  colorFilter?: string | null;
  /** Hard cap on returned entries. SCP usually returns \u2264100 products per
   *  search, and after dedupe we rarely see more than ~50 unique parallels. */
  limit?: number;
}

export interface DiscoverResult {
  parallels: DiscoveredParallel[];
  /** True when the color filter emptied the list and we fell back to
   *  returning everything. Surfaces in the UI as a soft "no exact color
   *  match found, showing all parallels" hint. */
  filterFellBack: boolean;
  /** The search query we sent to SCP \u2014 echoed so the client can show
   *  "Couldn't find parallels for <query>" copy on empty results. */
  query: string;
}

/**
 * Discover the distinct parallel list for a card.
 *
 * Strategy:
 *   1. Build the same search query we use for scoring (minus parallel).
 *   2. Pull SCP candidates \u2014 this is cache-hit the second time we scan
 *      the same card thanks to the 24h durable cache on searchProducts.
 *   3. For each candidate, pull the [bracketed] parallel; skip rows with
 *      none (those are the base variant and don't belong in the picker).
 *   4. De-dupe by (canonical bucket || raw label), keeping the first
 *      product id we saw for each.
 *   5. Optionally filter by color; if the filter empties the list,
 *      return unfiltered with filterFellBack=true.
 *
 * NEVER throws \u2014 returns an empty list on any failure. The client is
 * expected to fall through to the local DB on empty.
 */
export async function discoverParallels(
  scan: ScanQueryInput,
  opts: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const query = buildSearchQuery(scan);
  if (!query) {
    return { parallels: [], filterFellBack: false, query: "" };
  }

  let candidates;
  try {
    candidates = await searchProducts(query);
  } catch {
    // Silent: the orchestrator in index.ts already handles error logging
    // for scan-critical paths. The parallel picker is purely additive.
    return { parallels: [], filterFellBack: false, query };
  }

  // Narrow candidates to ones that actually match the scanned card number
  // (if provided). Without this, a search for Mayer U90-9 can pick up
  // Mayer #MS1-1 or #200 base rows and incorrectly offer their
  // parallels. When no card number is provided we keep everything —
  // downstream match scoring still protects us.
  const wantCardNumber = scan.cardNumber?.trim() || null;
  const cardNumberMatches = (productName: string): boolean => {
    if (!wantCardNumber) return true;
    const got = extractCardNumber(productName);
    if (!got) return false;
    return got.toLowerCase() === wantCardNumber.toLowerCase();
  };

  const seen = new Map<string, DiscoveredParallel>();
  let baseEntry: DiscoveredParallel | null = null;
  for (const c of candidates) {
    if (!cardNumberMatches(c["product-name"])) continue;
    const parallel = extractParallel(c["product-name"]);
    if (!parallel) {
      // No-bracket row = the base listing. For Topps flagship/inserts
      // the base IS often the visually-foily card a dealer has
      // (Ohtani ASG-1, Mayer U90-9 are both "base = Rainbow Foil"),
      // so we surface it in the picker rather than dropping it.
      // Keep the first one we see for this card number.
      if (!baseEntry) {
        baseEntry = {
          label: BASE_RAINBOW_LABEL,
          canonical: "Rainbow",
          productId: c.id,
          consoleName: c["console-name"],
        };
      }
      continue;
    }
    const canonical = normalizeParallel(parallel);
    // De-dupe by the raw label (normalized whitespace/case only). We used
    // to key on canonical bucket, but that collapses genuinely distinct
    // parallels in the same colour family — e.g. [Holo Pink Foil] and
    // [Pink Diamante Foil] on 2025 Topps Update are different physical
    // cards at different prices ($1.40 vs $2.87) and both must survive
    // a Pink colour filter. Exact-label dedupe still collapses SCP
    // duplicates (same label returned twice) without losing variants.
    const key = parallel.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.set(key, {
      label: parallel,
      canonical,
      productId: c.id,
      consoleName: c["console-name"],
    });
  }

  let parallels = Array.from(seen.values());

  // Optional color-bucket filter.
  //
  // The filter's job is to NARROW, not to silently delete plausible
  // options. On modern Topps sets a dealer scanning "blue" might really
  // have any of:
  //   - a bracketed blue parallel ([Holo Blue Foil], [Blue Rainbow Foil])
  //   - the base card, which on inserts is often the Rainbow Foil
  //   - a [Rainbow Foil] row (rainbow reflects blue depending on angle)
  //   - a themed/unbucketed parallel that can look blue
  //     ([Sandglitter], [Holiday], [Tinsel], [Ghost], [Clear], …)
  //
  // So when a colour filter is active we keep four classes:
  //   1. Exact colour-bucket matches (Pink filter -> Pink family)
  //   2. Rainbow-family entries + the synthetic base (always)
  //   3. Silver- and Gold-family entries (always) — chrome/foilboard
  //      parallels reflect whatever ambient colour is hitting them, so a
  //      Silver Prizm photographed with a blue tint is frequently mis-
  //      detected as Aqua/Blue. Keep them next to the colour matches so
  //      the dealer can pick the right one.
  //   4. Un-bucketable entries (canonical === null) — themed parallels
  //      like Sandglitter that have no colour identity of their own
  //
  // Non-colour filters (Refractor, Autograph) stay strict.
  let filterFellBack = false;
  if (opts.colorFilter) {
    const wantBucket = normalizeParallel(opts.colorFilter);
    if (wantBucket) {
      const colourMatches = parallels.filter((p) =>
        parallelsMatch(opts.colorFilter, p.label),
      );
      if (isColorBucket(wantBucket)) {
        const keep = parallels.filter((p) => {
          if (parallelsMatch(opts.colorFilter, p.label)) return true;
          // Always keep the Rainbow family when any colour is detected.
          if (p.canonical === "Rainbow") return true;
          // Always keep Silver and Gold — chrome neutrals that reflect
          // ambient colour and are frequently the true parallel when the
          // visual detector picks up a faint colour tint.
          if (p.canonical === "Silver") return true;
          if (p.canonical === "Gold") return true;
          // Always keep themed/un-bucketable parallels.
          if (p.canonical === null) return true;
          return false;
        });
        if (keep.length === 0) {
          // Truly nothing plausible — soft fallback to the full list.
          filterFellBack = true;
        } else {
          parallels = keep;
          filterFellBack = colourMatches.length === 0;
        }
      } else {
        // Non-colour filter (Refractor, Autograph, …) respects strictness.
        parallels = colourMatches;
      }
    }
  }

  // Always append the synthetic Base / Rainbow Foil entry so the dealer
  // can pick it when the base IS the visually-foily card (Ohtani ASG-1,
  // Mayer U90-9). When no colour filter is active this makes the base a
  // first-class option instead of a hidden default.
  if (baseEntry) {
    const baseKey = BASE_RAINBOW_LABEL.toLowerCase();
    if (!parallels.some((p) => p.label.toLowerCase() === baseKey)) {
      parallels.push(baseEntry);
    }
  }

  // Sort: canonical buckets first (alphabetical), then un-bucketable by label.
  // Base / Rainbow Foil goes to the top of the bucketed group via its
  // "Rainbow" canonical — it's the most common dealer pick.
  parallels.sort((a, b) => {
    if (!!a.canonical !== !!b.canonical) return a.canonical ? -1 : 1;
    const av = a.canonical ?? a.label;
    const bv = b.canonical ?? b.label;
    return av.localeCompare(bv);
  });

  const limit = opts.limit ?? 100;
  if (parallels.length > limit) parallels = parallels.slice(0, limit);

  return { parallels, filterFellBack, query };
}
