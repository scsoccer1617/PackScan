/**
 * VLM prompt + post-processor for the grading-label strip.
 *
 * Lives separate from `vlmPrompts.ts` so the existing card prompts are not
 * disturbed (PR-protected). Used only by the GRADED-mode scan path: when the
 * user captures a slabbed card the client crops the top ~18% of the
 * viewfinder (the slab label) and uploads it as a separate image. The server
 * runs Gemini once over THIS prompt against the cropped label and once over
 * the existing card prompt against the cropped card body.
 *
 * Companies supported per the user decision: PSA, BGS (incl. "Beckett"),
 * SGC, CGC. Other graders return null + low confidence so the scan still
 * surfaces with a clear "unknown grader" hint instead of failing silently.
 */

export const VLM_GRADING_LABEL_PROMPT_VERSION = '2026-05-02.1';

export const VLM_GRADING_LABEL_PROMPT = `You are reading the LABEL strip from a graded trading-card slab. The image is just the printed paper / plastic insert above the card body — it shows the grading company logo, the assigned grade, the certification number, and the card identity (year, set, player, card number, parallel) repeated for cross-validation.

Extract these fields and return ONLY valid JSON (no prose, no markdown fences):

{
  "gradingCompany": "PSA" | "BGS" | "SGC" | "CGC" | null,
  "numericalGrade": <number e.g. 10, 9.5, 8> | null,
  "gradeQualifier": <string, derived from gradingCompany + numericalGrade — see table below> | null,
  "certificationNumber": <alphanumeric serial printed on the label> | null,
  "year": <4-digit integer> | null,
  "set": <set name as printed on the label, e.g. "Topps Series One"> | null,
  "player": <full player name in Title Case> | null,
  "cardNumber": <string e.g. "193", "TOG-20"> | null,
  "parallel": <parallel/finish name printed on the label, or null> | null,
  "imageQuality": "good" | "blurry" | "dark" | "obstructed",
  "confidence": {
    "gradingCompany": <0.0-1.0>,
    "numericalGrade": <0.0-1.0>,
    "certificationNumber": <0.0-1.0>
  }
}

GRADING COMPANY RULES:
- Read the company logo / wordmark on the label. Map verbatim:
    "PSA" / "Professional Sports Authenticator" -> "PSA"
    "Beckett" / "Beckett Grading Services" / "BGS" -> "BGS"
    "SGC" / "Sportscard Guaranty" -> "SGC"
    "CGC" / "Certified Guaranty Company" / "CGC Cards" -> "CGC"
- If the slab is from a grader OTHER than these four (e.g. HGA, GMA, AGS,
  ISA), return gradingCompany=null with low confidence. Do NOT invent a
  company. The downstream pipeline still surfaces the scan as "raw" in that
  case rather than mis-classifying.

NUMERICAL GRADE RULES:
- Read the prominent grade number on the label. PSA grades are integers 1-10
  with optional half-step "GEM-MT 10" / "MINT 9" / "NM-MT 8" labels.
- BGS uses 0.5 increments through 10 ("BGS 9.5", "BGS 10 PRISTINE").
- SGC: 1-10 with 0.5 increments ("SGC 9.5").
- CGC: 1-10 with 0.5 increments ("CGC 9.5").
- Some grades carry qualifiers ("PSA 10 OC" — off-center; "PSA 8 MK" — mark).
  Capture only the NUMERIC portion in numericalGrade. The qualifier letters
  are NOT parsed — they live with the grade in the printed label and we
  preserve the user-facing "Grade qualifier" via gradeQualifier instead.

GRADE QUALIFIER (derived label, not a per-card qualifier):
Map (gradingCompany, numericalGrade) to the printed condition phrase the
grader uses. Use this lookup verbatim:
  PSA 10 -> "Gem Mint"
  PSA 9  -> "Mint"
  PSA 8  -> "NM-MT"
  PSA 7  -> "NM"
  PSA 6  -> "EX-MT"
  PSA 5  -> "EX"
  PSA 4  -> "VG-EX"
  PSA 3  -> "VG"
  PSA 2  -> "Good"
  PSA 1  -> "Poor"
  BGS 10 -> "Pristine"
  BGS 9.5 -> "Gem Mint"
  BGS 9  -> "Mint"
  BGS 8.5 -> "NM-MT+"
  BGS 8  -> "NM-MT"
  SGC 10 -> "Gem Mint"
  SGC 9.5 -> "Mint+"
  SGC 9  -> "Mint"
  SGC 8.5 -> "NM-MT+"
  SGC 8  -> "NM-MT"
  CGC 10 -> "Pristine"
  CGC 9.5 -> "Mint+"
  CGC 9  -> "Mint"
For any other (company, grade) pair return gradeQualifier=null.

CERTIFICATION NUMBER RULES:
- The cert number is the long alphanumeric serial printed somewhere on the
  label (often near the bottom or in a small barcode-adjacent block).
  PSA: 8-9 digits. BGS: 10-11 digits. SGC: 8 digits. CGC: 7-9 digits.
- Return it verbatim as printed (do not strip leading zeros).
- Return null if you cannot read it confidently.

CARD IDENTITY (year / set / player / cardNumber / parallel):
- Read these from the label whenever they're printed (PSA labels print all
  five; BGS / SGC / CGC labels print most of them). These are used as
  cross-validation against what the card-body Gemini call extracts —
  agreement raises confidence, disagreement defers to the slab label
  because the grader's data entry is more authoritative.
- player: Title Case ("LeBron James"), not all-caps from how the slab prints
  the name.
- cardNumber: verbatim string ("193", "TOG-20"), keep any prefix ("CC-22").

IMAGE QUALITY:
- "good": label clearly readable.
- "blurry": text edges fuzzy, motion blur evident.
- "dark": exposure too low to read confidently.
- "obstructed": part of the label hidden by reflection / fingers / glare.

If a field is genuinely unreadable, return null. Never guess.
Return ONLY valid JSON. No prose, no markdown fences.`;

// Per-grader/grade label printed by the company. Used by the post-processor
// when the model returns a numeric grade but no qualifier (cheaper than
// asking the model to derive it twice — keep the lookup deterministic).
const QUALIFIER_TABLE: Record<string, Record<string, string>> = {
  PSA: {
    '10': 'Gem Mint', '9': 'Mint', '8': 'NM-MT', '7': 'NM', '6': 'EX-MT',
    '5': 'EX', '4': 'VG-EX', '3': 'VG', '2': 'Good', '1': 'Poor',
  },
  BGS: {
    '10': 'Pristine', '9.5': 'Gem Mint', '9': 'Mint', '8.5': 'NM-MT+', '8': 'NM-MT',
  },
  SGC: {
    '10': 'Gem Mint', '9.5': 'Mint+', '9': 'Mint', '8.5': 'NM-MT+', '8': 'NM-MT',
  },
  CGC: {
    '10': 'Pristine', '9.5': 'Mint+', '9': 'Mint',
  },
};

export interface GradingLabelResult {
  gradingCompany: 'PSA' | 'BGS' | 'SGC' | 'CGC' | null;
  numericalGrade: number | null;
  gradeQualifier: string | null;
  certificationNumber: string | null;
  year: number | null;
  set: string | null;
  player: string | null;
  cardNumber: string | null;
  parallel: string | null;
  imageQuality: 'good' | 'blurry' | 'dark' | 'obstructed' | null;
  confidence: {
    gradingCompany?: number;
    numericalGrade?: number;
    certificationNumber?: number;
  };
}

/**
 * Look up the printed condition phrase for a (company, grade) pair. Returns
 * null when the combination isn't in the table — caller should leave
 * gradeQualifier null in that case rather than emit a misleading label.
 */
export function deriveGradeQualifier(
  company: string | null | undefined,
  grade: number | null | undefined,
): string | null {
  if (!company || grade == null) return null;
  const c = company.toUpperCase();
  const table = QUALIFIER_TABLE[c];
  if (!table) return null;
  // Try exact step ("9.5"), then integer fallback ("10").
  const key = Number.isInteger(grade) ? String(grade) : String(grade);
  if (table[key]) return table[key];
  if (Number.isInteger(grade) && table[String(grade)]) return table[String(grade)];
  return null;
}

/**
 * Coerce / normalize a Gemini response for the grading-label prompt. Maps
 * "Beckett" / "Beckett Grading Services" -> "BGS" so callers can rely on the
 * 4-company enum. Backfills gradeQualifier from the lookup table when the
 * model omitted it. Returns the cleaned shape.
 */
export function normalizeGradingLabel(raw: any): GradingLabelResult {
  const r = raw && typeof raw === 'object' ? raw : {};
  let company = (r.gradingCompany ?? '').toString().trim();
  if (/^beckett/i.test(company)) company = 'BGS';
  const upper = company.toUpperCase();
  const gradingCompany: GradingLabelResult['gradingCompany'] =
    upper === 'PSA' || upper === 'BGS' || upper === 'SGC' || upper === 'CGC'
      ? (upper as any)
      : null;

  const gradeRaw = r.numericalGrade;
  const numericalGrade = (() => {
    if (gradeRaw == null || gradeRaw === '') return null;
    const n = typeof gradeRaw === 'number' ? gradeRaw : Number(gradeRaw);
    return Number.isFinite(n) ? n : null;
  })();

  const qualifierFromModel = (r.gradeQualifier ?? '').toString().trim();
  const gradeQualifier = qualifierFromModel.length > 0
    ? qualifierFromModel
    : deriveGradeQualifier(gradingCompany, numericalGrade);

  const cert = (r.certificationNumber ?? '').toString().trim();

  return {
    gradingCompany,
    numericalGrade,
    gradeQualifier: gradeQualifier || null,
    certificationNumber: cert || null,
    year: (() => {
      const y = r.year;
      if (y == null || y === '') return null;
      const n = typeof y === 'number' ? y : Number(y);
      return Number.isFinite(n) ? n : null;
    })(),
    set: r.set ? String(r.set).trim() || null : null,
    player: r.player ? String(r.player).trim() || null : null,
    cardNumber: r.cardNumber ? String(r.cardNumber).trim() || null : null,
    parallel: r.parallel ? String(r.parallel).trim() || null : null,
    imageQuality: (() => {
      const q = (r.imageQuality ?? '').toString().toLowerCase();
      if (q === 'good' || q === 'blurry' || q === 'dark' || q === 'obstructed') {
        return q as GradingLabelResult['imageQuality'];
      }
      return null;
    })(),
    confidence: {
      gradingCompany: typeof r.confidence?.gradingCompany === 'number'
        ? r.confidence.gradingCompany : undefined,
      numericalGrade: typeof r.confidence?.numericalGrade === 'number'
        ? r.confidence.numericalGrade : undefined,
      certificationNumber: typeof r.confidence?.certificationNumber === 'number'
        ? r.confidence.certificationNumber : undefined,
    },
  };
}

/**
 * Build the human-readable grade keyword used in eBay picker queries and
 * outbound search URLs (e.g. "PSA 10", "BGS 9.5"). Returns null when either
 * side of the pair is missing. Format matches what graded slab listings
 * print verbatim in their titles.
 */
export function formatGradeKeyword(
  company: string | null | undefined,
  grade: number | null | undefined,
): string | null {
  if (!company || grade == null) return null;
  // Drop trailing ".0" on integer grades — slab titles read "PSA 10", never
  // "PSA 10.0". Half-grades stay as "9.5".
  const gradeStr = Number.isInteger(grade) ? String(grade) : String(grade);
  return `${company.toUpperCase()} ${gradeStr}`;
}
