// Classifies a card image as back vs front from its OCR text.
//
// The Brother duplex scanner emits pages in a fixed alternation (back, front,
// back, front, ...) but the pairing module cannot trust that alone — a
// mis-fed sheet, a single-sided card in the stack, or a page skew that
// flipped the flatbed preview can all desync the sequence. Having an
// independent per-page classifier lets the pairing module detect and flag
// mismatches before we waste a Vision call on a false pair.
//
// Signals (in order of strength):
//   • Stat-header density   — backs have "G AB R H 2B 3B HR RBI AVG" style
//     rows. Fronts never do. A line with ≥ 4 single-letter-or-abbreviated
//     stat tokens is near-certain back evidence across sports.
//   • Bio-prefix lines      — "BORN", "HOME", "HT", "WT", "BATS", "THROWS",
//     "HEIGHT", "WEIGHT", "DRAFTED", "SIGNED", "ACQ" — reused verbatim from
//     the dynamic card analyzer's `bioPrefixPattern` (server/dynamicCardAnalyzer.ts:521).
//   • Copyright / legal text — "©", "(C)", "&copy;", "COPYRIGHT", "LLC",
//     "INC.", "MLBPA", "NFLPA", "NBA PROPERTIES", etc. Fronts very rarely
//     carry any of these; backs almost always do.
//   • Low-text front guard  — fronts are imagery + a short wordmark; most
//     fronts OCR fewer than ~15 words total. We use this as a tiebreaker
//     when no positive back signal fires: very low OCR word count leans
//     front.
//
// The classifier returns a discrete verdict plus a 0–1 confidence so the
// pairing module can decide whether to flag a pair as "position says back,
// classifier says front — review needed".

const BIO_PREFIX_PATTERN = /^(BORN|HOME|ACQ|SIGNED|DRAFTED|HT|WT|HEIGHT|WEIGHT|BATS|THROWS|POS|POSITION|COLLEGE|EXPERIENCE|BIRTHPLACE)[\s:]/i;

const COPYRIGHT_MARKERS = [
  /©/,
  /\(c\)/i,
  /&copy;/i,
  /copyright/i,
  /\bMLBPA\b/,
  /\bNFLPA\b/,
  /\bNBAPA\b/,
  /\bNBA\s+Properties\b/i,
  /\bNHLPA\b/,
  /\bLLC\b/,
  /\bINC\.?\b/,
  /\bCORP\b/,
  /\bLTD\b/,
  /\bTOPPS\s+COMPANY\b/i,
];

// Vintage subset / leaderboard back wordmarks. Cards in these subsets carry
// none of the usual back signals — no per-line stat header (the layout is a
// leaderboard or feature box, not a year-by-year stat grid), no bio prefix,
// and the legal strip often reads "TOPPS CHEWING GUM" rather than the
// "TOPPS COMPANY" string the copyright markers expect. The 1986 Topps NL
// Leaders Valenzuela back ("604 1986 NL LEADERS VICTORIES …") was the
// motivating example — without this signal it scored 0 and classified as
// `unknown`, which let position-default route the leaderboard side as the
// front. Each pattern is anchored to a SINGLE LINE so flowing prose
// elsewhere on the card cannot trigger a false positive (the audit
// specifically called out the "MANAGER" word, which is also a fielding
// position abbreviation that shows up in stat-row prose).
const SUBSET_BACK_MARKERS: { name: string; rx: RegExp }[] = [
  { name: 'LEADERS', rx: /^.*\bLEADERS\b.*$/im },
  { name: 'RECORD BREAKERS', rx: /^.*\bRECORD\s+BREAKERS?\b.*$/im },
  { name: 'ALL-STAR', rx: /^.*\bALL[-\s]?STAR\b.*$/im },
  { name: 'FUTURE STARS', rx: /^.*\bFUTURE\s+STARS?\b.*$/im },
  { name: 'TEAM LEADERS', rx: /^.*\bTEAM\s+LEADERS\b.*$/im },
  // Manager: only when it appears as a banner-style heading with little else
  // on the line (≤6 tokens). Avoids false positives on stat-row prose like
  // "MANAGERIAL RECORD" paragraphs or "former manager" mentions.
  { name: 'MANAGER', rx: /^\s*(?:[A-Z0-9.''\-]+\s+){0,5}MANAGER(?:\s+[A-Z0-9.''\-]+){0,5}\s*$/m },
  { name: 'TURN BACK THE CLOCK', rx: /^.*\bTURN\s+BACK\s+THE\s+CLOCK\b.*$/im },
  { name: 'IN ACTION', rx: /^.*\bIN\s+ACTION\b.*$/im },
  { name: 'BIG LEAGUE BROTHERS', rx: /^.*\bBIG\s+LEAGUE\s+BROTHERS\b.*$/im },
  { name: 'WORLD SERIES', rx: /^.*\bWORLD\s+SERIES\b.*$/im },
];

// Common per-sport stat abbreviations that appear together in a header row.
// We don't require a specific sport — any mix is a back-side indicator.
const STAT_HEADER_TOKENS = new Set<string>([
  // Baseball
  'G', 'AB', 'R', 'H', '2B', '3B', 'HR', 'RBI', 'SB', 'BB', 'SO', 'AVG', 'OBP', 'SLG', 'OPS', 'IP', 'ER', 'ERA', 'WHIP', 'W', 'L', 'SV',
  // Football
  'ATT', 'YDS', 'TD', 'INT', 'CMP', 'REC', 'FUM', 'TKL', 'SACK', 'SACKS',
  // Basketball
  'PTS', 'AST', 'REB', 'STL', 'BLK', 'FG', 'FG%', '3P', '3P%', 'FT', 'FT%', 'MIN',
  // Hockey
  'GP', 'A', 'PIM', 'PPG', 'SHG', 'GWG', 'SOG',
  // Common shared
  'YEAR', 'TEAM',
]);

export type SideVerdict = 'back' | 'front' | 'unknown';

export interface SideClassification {
  verdict: SideVerdict;
  /** 0..1 — how confident the classifier is. Below ~0.55 is "unknown". */
  confidence: number;
  /** Which signals fired, in display order. Useful for diagnostics + review UI. */
  signals: string[];
  /** Derived counts kept for downstream tuning / logging. */
  debug: {
    bioPrefixLines: number;
    copyrightHits: number;
    statHeaderTokens: number;
    subsetMarkerHits: number;
    totalWords: number;
  };
}

/**
 * Count stat-header tokens in the OCR text. We look line by line and count
 * how many whitespace-separated tokens on that line match the STAT_HEADER_TOKENS
 * set. If any single line has ≥ 4 matches, that's a near-certain stat header
 * row. We also return the global max across lines so the caller can reason
 * about confidence.
 */
function countStatHeaderTokens(text: string): number {
  const lines = text.split(/\r?\n/);
  let best = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    // Too-long lines are paragraphs, not stat headers. Cap to avoid false
    // positives in bio prose like "All-Star" / "rookie of the year" lists.
    if (tokens.length > 20) continue;
    let hits = 0;
    for (const tok of tokens) {
      // Strip trailing punctuation that OCR likes to glue onto headers.
      const clean = tok.replace(/[^A-Za-z0-9%]/g, '').toUpperCase();
      if (STAT_HEADER_TOKENS.has(clean)) hits++;
    }
    if (hits > best) best = hits;
  }
  return best;
}

function countBioPrefixLines(text: string): number {
  const lines = text.split(/\r?\n/);
  let count = 0;
  for (const raw of lines) {
    if (BIO_PREFIX_PATTERN.test(raw.trim())) count++;
  }
  return count;
}

function countCopyrightHits(text: string): number {
  let count = 0;
  for (const rx of COPYRIGHT_MARKERS) {
    if (rx.test(text)) count++;
  }
  return count;
}

/**
 * Find subset/leaderboard back wordmarks. Returns the list of marker names
 * that matched, in the order they appear in SUBSET_BACK_MARKERS. Each marker
 * regex is line-anchored (multiline `^…$`) so flowing prose mentioning one
 * of these words elsewhere on the card cannot trigger a false positive.
 */
function findSubsetBackMarkers(text: string): string[] {
  const hits: string[] = [];
  for (const { name, rx } of SUBSET_BACK_MARKERS) {
    if (rx.test(text)) hits.push(name);
  }
  return hits;
}

/**
 * Classify a single card image's OCR text as back vs front.
 *
 * The scoring is deliberately simple and additive so the weights can be
 * tuned in one place. Each signal contributes to a 0..1 "back score"; a
 * low total with non-trivial OCR text implies front. An empty OCR text
 * is returned as 'unknown' — fronts with no visible wordmark (rare) and
 * unreadable scans share the same signature so we don't guess.
 */
export function classifyCardSide(ocrText: string): SideClassification {
  const text = (ocrText || '').trim();
  const signals: string[] = [];

  if (!text) {
    return {
      verdict: 'unknown',
      confidence: 0,
      signals: [],
      debug: { bioPrefixLines: 0, copyrightHits: 0, statHeaderTokens: 0, subsetMarkerHits: 0, totalWords: 0 },
    };
  }

  const bioPrefixLines = countBioPrefixLines(text);
  const copyrightHits = countCopyrightHits(text);
  const statHeaderTokens = countStatHeaderTokens(text);
  const subsetMarkers = findSubsetBackMarkers(text);
  const totalWords = text.split(/\s+/).filter(Boolean).length;

  // Back-score is a soft sum in [0, 1]. Each signal caps its own contribution
  // so one very noisy page (say, 10 bio prefix lines) doesn't peg the score.
  let backScore = 0;

  if (statHeaderTokens >= 4) {
    backScore += 0.55;
    signals.push(`stat_header(${statHeaderTokens})`);
  } else if (statHeaderTokens >= 2) {
    backScore += 0.25;
    signals.push(`stat_hint(${statHeaderTokens})`);
  }

  if (bioPrefixLines >= 2) {
    backScore += 0.35;
    signals.push(`bio_prefix(${bioPrefixLines})`);
  } else if (bioPrefixLines === 1) {
    backScore += 0.15;
    signals.push('bio_prefix(1)');
  }

  if (copyrightHits >= 2) {
    backScore += 0.25;
    signals.push(`copyright(${copyrightHits})`);
  } else if (copyrightHits === 1) {
    backScore += 0.12;
    signals.push('copyright(1)');
  }

  // Vintage subset/leaderboard wordmark — a single banner-style hit on its
  // own line is enough to lift backScore past the 0.35 floor when no other
  // signal is firing (a Future Stars or Turn Back The Clock back may carry
  // nothing else recognizable to the classifier). Weighted to clear the
  // floor on its own; multiple hits stack but cap to avoid pegging the
  // score from one OCR pass that detected the same banner twice.
  if (subsetMarkers.length > 0) {
    const contribution = subsetMarkers.length >= 2 ? 0.45 : 0.35;
    backScore += contribution;
    signals.push(`subset_back("${subsetMarkers[0]}")`);
  }

  // Long text lean — backs are dense with prose + stats. A page with > 60
  // OCR words and no strong signal is still likely a back (faded stat row).
  if (totalWords >= 60 && backScore < 0.3) {
    backScore += 0.15;
    signals.push(`dense_text(${totalWords})`);
  }

  // Front-side positive tiebreaker: very short text + no back signals.
  // Fronts usually OCR a player name, team, and maybe a foil wordmark — call
  // it under 15 words total. We only apply this when backScore is tiny so
  // we don't overrule a real stat header.
  let frontScore = 0;
  if (totalWords < 15 && backScore < 0.2) {
    frontScore = 0.55;
    signals.push(`sparse_text(${totalWords})`);
  }

  const backCapped = Math.min(backScore, 0.95);
  const verdict: SideVerdict = backCapped > frontScore && backCapped >= 0.35
    ? 'back'
    : frontScore > 0.3 && frontScore > backCapped
      ? 'front'
      : 'unknown';

  const confidence = verdict === 'back'
    ? backCapped
    : verdict === 'front'
      ? frontScore
      : Math.max(backCapped, frontScore);

  return {
    verdict,
    confidence: Number(confidence.toFixed(2)),
    signals,
    debug: { bioPrefixLines, copyrightHits, statHeaderTokens, subsetMarkerHits: subsetMarkers.length, totalWords },
  };
}
