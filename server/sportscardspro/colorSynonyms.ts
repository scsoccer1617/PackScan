/**
 * Color & parallel normalization for PackScan ↔ SCP matching.
 *
 * Two jobs:
 *
 * 1. Map the many surface forms a color/parallel can take into a single
 *    canonical label. Holo OCR may report "hot pink", SCP's product-name
 *    may say "[Pink]" or "[Pink Refractor]" or "[Pink Wave]" — they
 *    should all collapse to the same bucket for scoring and picker UI.
 *
 * 2. Power the parallel-picker color filter. When the scanner detects
 *    a pink card, we only want to surface SCP parallels that contain a
 *    pink-family word, not the 40 other parallels (Gold, Yellow, Gold
 *    Crackle Foil, Sandglitter, Superfractor, …).
 *
 * Design notes:
 *
 * - The canonical bucket is always a single Title-Cased word ("Pink",
 *   "Gold", "Base"). Downstream UI displays the bucket verbatim, so
 *   keep them human-friendly.
 * - Match.ts uses this module for `parallel` weight scoring. The parallel
 *   picker UI uses it to filter the SCP candidate list by the scanner's
 *   detected color.
 * - Keep the synonym list conservative. False merges ("Sapphire" into
 *   "Blue") hurt us more than a miss — blue-family parallels are
 *   often priced very differently from Sapphire-specific ones. When
 *   in doubt, keep a parallel as its own distinct bucket.
 * - "Base" is the sentinel for "no parallel" (a plain/base card). Holo
 *   sometimes returns that string literally.
 */

// Canonical labels we bucket into. Add new ones here and in CANONICAL_FORMS
// together.
export type CanonicalParallel =
  | "Base"
  | "Pink"
  | "Red"
  | "Orange"
  | "Yellow"
  | "Green"
  | "Blue"
  | "Purple"
  | "Black"
  | "White"
  | "Silver"
  | "Gold"
  | "Bronze"
  | "Rainbow"
  | "Refractor"
  | "Prizm"
  | "Holo"
  | "Sapphire"
  | "Emerald"
  | "Ruby"
  | "Onyx"
  | "Superfractor"
  | "Autograph"
  | "Patch"
  | "Printing Plate"
  | "Image Variation"
  | "SP"
  | "SSP"
  | "Negative";

/**
 * Each canonical parallel → ordered list of lowercase substring synonyms.
 * Order matters: we test synonyms in the order they appear, and the first
 * match wins. List more-specific first so "hot pink" is caught before the
 * bare "pink" fallback.
 *
 * Matching is case-insensitive substring — so "gold" matches "Gold Wave"
 * AND "Gold Border" AND "Rose Gold" (a known false positive; see below).
 * We resolve ambiguity with the ORDER of the canonical list in
 * normalizeParallel — more distinctive colors are tested first.
 */
const SYNONYMS: Record<CanonicalParallel, string[]> = {
  Base: ["base", "common", "no parallel"],

  // Pink family — check magenta/fuchsia/hot pink before plain "pink".
  Pink: ["hot pink", "magenta", "fuchsia", "rose pink", "pink"],

  // Red family — keep Ruby out, it's its own tier.
  Red: ["blood red", "fire red", "red wave", "red ice", "red"],

  Orange: ["orange lava", "orange wave", "orange ice", "orange"],

  Yellow: ["lemon", "canary", "yellow wave", "yellow"],

  Green: ["jade", "mint", "kelly green", "neon green", "forest green", "green wave", "green"],

  // Blue family — keep Sapphire out.
  Blue: ["cyan", "aqua", "teal", "navy", "blue wave", "blue ice", "blue"],

  Purple: ["violet", "lavender", "amethyst", "purple wave", "purple"],

  // Black — includes Onyx-adjacent language but Onyx itself is its own bucket.
  Black: ["jet black", "midnight", "black wave", "black"],

  White: ["snow", "ivory", "white sparkle", "white"],

  Silver: ["silver crackle", "silver wave", "silver"],

  // Gold — be careful, "gold" substring matches "Rose Gold". We accept
  // that rather than enumerate every compound because Rose Gold prices
  // line up with Gold-tier more often than Pink-tier in practice.
  Gold: ["gold rainbow", "gold crackle", "gold wave", "golden", "gold"],

  Bronze: ["bronze"],

  Rainbow: ["rainbow foil", "rainbow"],

  // Refractor is brand-specific (Topps Chrome). Bowman "Chrome" variants
  // also collapse here because they price similarly.
  Refractor: ["refractor", "chrome refractor"],

  Prizm: ["prizm silver", "silver prizm", "prizm"],

  Holo: ["holo", "hologram", "holographic"],

  Sapphire: ["sapphire"],
  Emerald: ["emerald"],
  Ruby: ["ruby"],
  Onyx: ["onyx"],

  Superfractor: ["superfractor", "super fractor", "super refractor"],

  Autograph: ["autograph", "auto", "signature"],
  Patch: ["patch", "jersey", "memorabilia", "relic"],

  "Printing Plate": ["printing plate", "print plate", "plate"],

  "Image Variation": ["image variation", "image var", "photo variation", "ssp image"],

  // SP / SSP tend to be true catch-all "short print" tags rather than
  // visible colors. We still normalize them so the picker filter works.
  SP: ["short print", " sp "],
  SSP: ["super short print", " ssp ", "ssp"],

  Negative: ["negative refractor", "negative"],
};

// Canonical labels, tested in order of specificity. First match wins.
// Put the less-ambiguous labels first so a compound parallel like
// "Gold Refractor" normalizes to "Refractor" (the more distinctive tier),
// while a plain "Gold" still resolves to "Gold".
//
// Core colours (Pink, Red, Blue, …) are tested BEFORE "Holo" because
// SCP uses "Holo" as a foil-finish modifier rather than a distinct
// bucket. "Holo Pink Foil" is a pink card first; if we bucket it as
// Holo the parallel picker's Pink filter silently drops it — which
// caused the Petersen US49 regression where only [Pink Diamante Foil]
// showed up instead of both pink options.
const CANONICAL_ORDER: CanonicalParallel[] = [
  // Brand-specific tiers that should beat generic colors.
  "Superfractor",
  "Printing Plate",
  "Image Variation",
  "Autograph",
  "Patch",
  "Negative",
  "Refractor",
  "Prizm",
  // Premium stones that happen to be colored.
  "Sapphire",
  "Emerald",
  "Ruby",
  "Onyx",
  // Short-print tags.
  "SSP",
  "SP",
  // Metallics.
  "Rainbow",
  "Gold",
  "Silver",
  "Bronze",
  // Core color wheel — MUST come before Holo so "Holo Pink Foil"
  // buckets as Pink, not as Holo.
  "Pink",
  "Red",
  "Orange",
  "Yellow",
  "Green",
  "Blue",
  "Purple",
  "Black",
  "White",
  // Finish-only modifier — only wins when no color is present in the label.
  "Holo",
  // Sentinel.
  "Base",
];

/**
 * Normalize any parallel/color string to a canonical bucket, or null if
 * unrecognized. Accepts:
 *   - "pink refractor"   -> "Refractor"   (Refractor beats Pink in order)
 *   - "hot pink"          -> "Pink"
 *   - "gold /50"          -> "Gold"
 *   - "[Pink Wave]"       -> "Pink"
 *   - "Sandglitter"       -> null         (unknown; leave to consumer)
 *   - ""                  -> null
 *   - "base"              -> "Base"
 *
 * The returned bucket is the human-readable canonical form, suitable
 * for display in the parallel picker.
 */
export function normalizeParallel(raw: string | null | undefined): CanonicalParallel | null {
  if (!raw) return null;
  const lower = ` ${raw.toLowerCase().replace(/[\[\]]/g, " ").replace(/\s+/g, " ").trim()} `;
  if (lower.trim() === "") return null;

  for (const canon of CANONICAL_ORDER) {
    for (const syn of SYNONYMS[canon]) {
      // Use bare substring for multi-word / rare synonyms. For the short
      // color words (≤6 chars) require a word boundary on at least one
      // side to avoid "red" matching "sacred" or "shredded".
      if (syn.length <= 6 && !syn.includes(" ")) {
        const re = new RegExp(`(^|[^a-z])${escapeRegex(syn)}([^a-z]|$)`, "i");
        if (re.test(raw)) return canon;
      } else {
        if (lower.includes(syn.toLowerCase())) return canon;
      }
    }
  }
  return null;
}

/**
 * Does `candidateParallel` belong to the same bucket as `scanParallel`?
 * Both inputs are normalized first. Null-safe:
 *   - null vs null        -> true (both base)
 *   - null vs "Pink"      -> false
 *   - "Pink" vs "Magenta" -> true (both normalize to Pink)
 */
export function parallelsMatch(
  scanParallel: string | null | undefined,
  candidateParallel: string | null | undefined,
): boolean {
  const a = normalizeParallel(scanParallel);
  const b = normalizeParallel(candidateParallel);
  // Treat "nothing detected" and "Base" as equivalent.
  const aBase = a === null || a === "Base";
  const bBase = b === null || b === "Base";
  if (aBase && bBase) return true;
  if (aBase !== bBase) return false;
  return a === b;
}

/**
 * True if `bucket` is broadly one of the "core color wheel" buckets, as
 * opposed to a brand tier ("Refractor") or premium gem ("Sapphire").
 * The parallel picker uses this to decide whether a color filter is
 * useful: if Holo detected "Refractor" there's no color to filter by.
 */
export function isColorBucket(bucket: CanonicalParallel | null): boolean {
  if (!bucket) return false;
  return [
    "Pink","Red","Orange","Yellow","Green","Blue",
    "Purple","Black","White","Silver","Gold","Bronze","Rainbow",
  ].includes(bucket);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
