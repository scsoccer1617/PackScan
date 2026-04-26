import sharp from 'sharp';

/**
 * Region-aware foil evidence extractor.
 *
 * Why this exists:
 *   Google Vision's `imagePropertiesAnnotation.dominantColors` returns the top
 *   colors across the WHOLE image. For a hand-held card photo with bright
 *   reflections, fingers, and a dark background, the card's actual border
 *   colour can drop below the global thresholds and the foil detector
 *   wrongly concludes "no foil".
 *
 *   This module decodes the image with sharp and analyses 5 regions
 *   independently:
 *     - 4 border strips (top, bottom, left, right) — these carry the card's
 *       true border colour because reflections concentrate in the middle
 *       and fingers usually only obscure one edge at a time.
 *     - 1 center region — used to detect the multi-hue "rainbow" specular
 *       signature that foil cards produce under any household light.
 *
 *   Two independent signals are produced:
 *     - `borderTint`: the dominant colour shared across at least 2 of the
 *       4 border strips, with coverage and avg saturation. Skin-toned and
 *       near-white/near-black pixels are excluded so fingers and paper
 *       borders don't dilute the signal.
 *     - `centerRainbow`: a 0..1 score reflecting how many distinct vivid
 *       hues co-exist in the center. Foil reflections produce ≥3 vivid
 *       hues simultaneously (the rainbow streak); plain matte cards do
 *       not.
 *
 * Performance: image is resized to a small working size (max 400px wide)
 * and sampled with a stride, so total cost is well under 50ms even for
 * full-resolution camera shots.
 */

export type HueBucket =
  | 'red' | 'orange' | 'yellow' | 'green' | 'aqua' | 'blue' | 'purple' | 'pink';

export interface BorderTint {
  hue: HueBucket;
  /** Average saturation (0..255) of pixels matching this hue across the agreeing border strips. */
  avgSaturation: number;
  /** Fraction of analyzed (non-skin/non-extreme) pixels in agreeing border strips that match this hue. 0..1 */
  coverage: number;
  /** Number of border strips (out of 4) whose dominant tinted hue is this one. */
  agreeingStripCount: number;
  /** Per-strip coverage of this hue, indexed top/bottom/left/right. */
  perStripCoverage: { top: number; bottom: number; left: number; right: number };
}

export interface RegionalFoilEvidence {
  borderTint: BorderTint | null;
  /** 0..1 score for how rainbow-like the center is (multi-hue coexistence). */
  centerRainbowScore: number;
  /** Distinct vivid hues found in the center region. */
  centerHueCount: number;
  /** Diagnostic indicator strings ready to push into the foil detector log stream. */
  indicators: string[];
}

/** Approximate RGB → hue bucket. Returns null for low-saturation / skin / extreme-brightness pixels. */
function rgbToHueBucket(r: number, g: number, b: number): HueBucket | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max - min;
  const brightness = (r + g + b) / 3;

  // Drop very dark / very bright pixels (shadow or specular blowout)
  if (brightness < 35 || brightness > 240) return null;
  // Drop low-saturation pixels (white paper, grey, etc.)
  if (sat < 35) return null;

  // Skin-tone exclusion: fingers and palms are common in hand-held card photos.
  // Skin: R > G > B, with R-G between ~10 and ~80, G-B between ~10 and ~70,
  // and R in roughly 90..240. This is intentionally generous — we'd rather
  // drop a few pinkish pixels from the image than count a finger as red foil.
  if (r > g && g >= b && r - g >= 10 && r - g <= 80 && g - b >= 10 && g - b <= 70 && r >= 90 && r <= 240) {
    return null;
  }

  // Standard 6-hue wheel + pink, with green/aqua split because Topps Holiday
  // / parallel sets use vivid greens that we want to distinguish from teal.
  if (r >= g && r >= b) {
    if (g >= b) {
      // Red → Yellow region. Order matters: yellow (high green) → orange (some
      // green, clearly above blue) → red (very little green). Previously the red
      // fall-through caught RGB(205,77,22) (Donruss "Orange Holo Laser" border)
      // because the orange branch required r-g < 40, which is too tight — real
      // orange spans a much wider red→green gap than that.
      if (g > 0.7 * r) return 'yellow';
      if (g >= 0.35 * r && g - b > 25) return 'orange';
      return 'red';
    }
    // Red → Magenta/Pink
    if (b > 0.6 * r && r > 150) return 'pink';
    return 'pink';
  }
  if (g >= r && g >= b) {
    if (b > 0.7 * g && b > r + 20) return 'aqua';
    return 'green';
  }
  // b is max
  if (r > 0.55 * b && r > g) return 'purple';
  if (g > 0.55 * b) return 'aqua';
  return 'blue';
}

interface RegionStats {
  totalCounted: number; // pixels that survived skin/extreme filtering
  hueCounts: Record<HueBucket, number>;
  hueSatSum: Record<HueBucket, number>;
}

function emptyStats(): RegionStats {
  return {
    totalCounted: 0,
    hueCounts: { red: 0, orange: 0, yellow: 0, green: 0, aqua: 0, blue: 0, purple: 0, pink: 0 },
    hueSatSum: { red: 0, orange: 0, yellow: 0, green: 0, aqua: 0, blue: 0, purple: 0, pink: 0 },
  };
}

function analyzeRegion(
  data: Buffer,
  width: number,
  channels: number,
  x0: number, y0: number, x1: number, y1: number,
  stride: number,
): RegionStats {
  const stats = emptyStats();
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const bucket = rgbToHueBucket(r, g, b);
      if (!bucket) continue;
      stats.totalCounted++;
      stats.hueCounts[bucket]++;
      stats.hueSatSum[bucket] += Math.max(r, g, b) - Math.min(r, g, b);
    }
  }
  return stats;
}

function dominantHue(stats: RegionStats): { hue: HueBucket; coverage: number; avgSat: number } | null {
  if (stats.totalCounted === 0) return null;
  let bestHue: HueBucket | null = null;
  let bestCount = 0;
  for (const hue of Object.keys(stats.hueCounts) as HueBucket[]) {
    const count = stats.hueCounts[hue];
    if (count > bestCount) {
      bestCount = count;
      bestHue = hue;
    }
  }
  if (!bestHue || bestCount === 0) return null;
  const coverage = bestCount / stats.totalCounted;
  const avgSat = stats.hueSatSum[bestHue] / bestCount;
  return { hue: bestHue, coverage, avgSat };
}

/** Compute centerRainbow score: 0..1 based on how many distinct vivid hues
 *  exceed a small coverage floor AND how far apart they sit on the colour
 *  wheel. A real holographic/foil surface scatters light across the wheel
 *  (e.g. red+green+blue, or cyan+magenta+yellow). A photograph of a player
 *  in an orange jersey on a red wall produces 3 hues — but they're all
 *  adjacent (red+orange+yellow), which is NOT a rainbow.
 *
 *  We measure spread as the max circular distance between any two
 *  qualifying hue buckets (8 buckets around the wheel, so max distance=4).
 *  Adjacent-only clusters (spread ≤ 2) are downgraded to a base-card
 *  signal regardless of hue count. */
function rainbowScore(centerStats: RegionStats): { score: number; hueCount: number; perHue: Partial<Record<HueBucket, number>> } {
  if (centerStats.totalCounted === 0) return { score: 0, hueCount: 0, perHue: {} };
  const HUE_FLOOR = 0.03; // 3% of analyzed center pixels
  const perHue: Partial<Record<HueBucket, number>> = {};
  let hits = 0;
  // Bucket order matches the HueBucket enum and represents adjacency around
  // the colour wheel. Used below to compute circular hue spread.
  const HUE_ORDER: HueBucket[] = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'pink'];
  const hitIndices: number[] = [];
  for (const hue of Object.keys(centerStats.hueCounts) as HueBucket[]) {
    const cov = centerStats.hueCounts[hue] / centerStats.totalCounted;
    if (cov >= HUE_FLOOR) {
      perHue[hue] = cov;
      hits++;
      hitIndices.push(HUE_ORDER.indexOf(hue));
    }
  }

  // Compute max circular distance between any two qualifying hue indices.
  // Wheel size = 8, so max possible circular distance = 4.
  let maxSpread = 0;
  for (let i = 0; i < hitIndices.length; i++) {
    for (let j = i + 1; j < hitIndices.length; j++) {
      const a = hitIndices[i], b = hitIndices[j];
      const linear = Math.abs(a - b);
      const circular = Math.min(linear, HUE_ORDER.length - linear);
      if (circular > maxSpread) maxSpread = circular;
    }
  }

  // Adjacent-only clusters (a single warm or cool palette) are not foil
  // evidence, no matter how many adjacent buckets they fill.
  if (hits >= 2 && maxSpread <= 2) {
    return { score: 0, hueCount: hits, perHue };
  }

  // Dominance check: a true foil rainbow distributes its area across
  // several hues. If one hue accounts for the overwhelming majority of
  // the qualifying coverage and the rest are slivers, this is a single
  // dominant colour with noise — typically the player photo (e.g. a
  // red uniform plus tiny pockets of other hues) rather than a foil
  // rainbow. Reject when the top hue's share of the qualifying
  // coverage exceeds 60%.
  let totalQualifyingCov = 0;
  let topCov = 0;
  for (const cov of Object.values(perHue)) {
    if (cov === undefined) continue;
    totalQualifyingCov += cov;
    if (cov > topCov) topCov = cov;
  }
  if (totalQualifyingCov > 0 && topCov / totalQualifyingCov > 0.6) {
    return { score: 0, hueCount: hits, perHue };
  }

  // Map hits → score: 0 hues=0, 1=0, 2=0.35, 3=0.7, 4+=1.0
  const score = hits <= 1 ? 0 : hits === 2 ? 0.35 : hits === 3 ? 0.7 : 1.0;
  return { score, hueCount: hits, perHue };
}

export async function analyzeRegionalFoilEvidence(buffer: Buffer): Promise<RegionalFoilEvidence> {
  const indicators: string[] = [];
  try {
    // Resize to a small working image. 400px wide is plenty for color analysis
    // and keeps total pixel count under ~250k even for tall portrait shots.
    const { data, info } = await sharp(buffer)
      .rotate() // honor EXIF (no-op if already normalized upstream)
      .resize({ width: 400, withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const W = info.width;
    const H = info.height;
    const channels = info.channels;
    const stride = 2; // sample every other pixel for speed

    // Region geometry. Borders are intentionally THIN (12% / 10%) so they
    // capture the actual card edge colour rather than the inner artwork.
    const topY0 = 0, topY1 = Math.floor(H * 0.12);
    const botY0 = Math.floor(H * 0.88), botY1 = H;
    const leftX0 = 0, leftX1 = Math.floor(W * 0.10);
    const rightX0 = Math.floor(W * 0.90), rightX1 = W;
    // Center: middle 50%×50%.
    const cX0 = Math.floor(W * 0.25), cX1 = Math.floor(W * 0.75);
    const cY0 = Math.floor(H * 0.25), cY1 = Math.floor(H * 0.75);

    const top    = analyzeRegion(data, W, channels, 0, topY0, W, topY1, stride);
    const bottom = analyzeRegion(data, W, channels, 0, botY0, W, botY1, stride);
    const left   = analyzeRegion(data, W, channels, leftX0, 0, leftX1, H, stride);
    const right  = analyzeRegion(data, W, channels, rightX0, 0, rightX1, H, stride);
    const center = analyzeRegion(data, W, channels, cX0, cY0, cX1, cY1, stride);

    const dom = {
      top: dominantHue(top),
      bottom: dominantHue(bottom),
      left: dominantHue(left),
      right: dominantHue(right),
    };
    indicators.push(
      `[Region] top=${dom.top?.hue ?? 'none'}(${((dom.top?.coverage ?? 0) * 100).toFixed(1)}%, sat=${(dom.top?.avgSat ?? 0).toFixed(0)}) ` +
      `bottom=${dom.bottom?.hue ?? 'none'}(${((dom.bottom?.coverage ?? 0) * 100).toFixed(1)}%, sat=${(dom.bottom?.avgSat ?? 0).toFixed(0)}) ` +
      `left=${dom.left?.hue ?? 'none'}(${((dom.left?.coverage ?? 0) * 100).toFixed(1)}%, sat=${(dom.left?.avgSat ?? 0).toFixed(0)}) ` +
      `right=${dom.right?.hue ?? 'none'}(${((dom.right?.coverage ?? 0) * 100).toFixed(1)}%, sat=${(dom.right?.avgSat ?? 0).toFixed(0)})`
    );

    // Tally agreement across border strips. Each strip casts ONE vote for
    // its dominant hue (only if that hue has ≥4% coverage WITHIN that strip
    // — this prevents a strip whose dominant hue is barely present from
    // counting toward agreement).
    const STRIP_MIN_COVERAGE = 0.04;
    const stripVotes: { strip: 'top' | 'bottom' | 'left' | 'right'; hue: HueBucket; cov: number; sat: number }[] = [];
    for (const [strip, d] of Object.entries(dom) as ['top' | 'bottom' | 'left' | 'right', typeof dom.top][]) {
      if (d && d.coverage >= STRIP_MIN_COVERAGE) {
        stripVotes.push({ strip, hue: d.hue, cov: d.coverage, sat: d.avgSat });
      }
    }
    const hueAgreement = new Map<HueBucket, typeof stripVotes>();
    for (const v of stripVotes) {
      if (!hueAgreement.has(v.hue)) hueAgreement.set(v.hue, []);
      hueAgreement.get(v.hue)!.push(v);
    }

    let borderTint: BorderTint | null = null;
    let bestVoteCount = 0;
    for (const [hue, votes] of hueAgreement) {
      if (votes.length >= 2 && votes.length > bestVoteCount) {
        bestVoteCount = votes.length;
        const perStripCoverage = { top: 0, bottom: 0, left: 0, right: 0 };
        for (const v of votes) perStripCoverage[v.strip] = v.cov;
        const avgCoverage = votes.reduce((s, v) => s + v.cov, 0) / votes.length;
        const avgSat = votes.reduce((s, v) => s + v.sat, 0) / votes.length;
        borderTint = {
          hue,
          avgSaturation: avgSat,
          coverage: avgCoverage,
          agreeingStripCount: votes.length,
          perStripCoverage,
        };
      }
    }

    const rainbow = rainbowScore(center);
    indicators.push(
      `[Region] center hueCount=${rainbow.hueCount}, rainbowScore=${rainbow.score.toFixed(2)}, perHue=${JSON.stringify(
        Object.fromEntries(Object.entries(rainbow.perHue).map(([k, v]) => [k, +(v! * 100).toFixed(1)]))
      )}`
    );

    if (borderTint) {
      indicators.push(
        `[Region] borderTint=${borderTint.hue} (${borderTint.agreeingStripCount}/4 strips agree, avgCoverage=${(borderTint.coverage * 100).toFixed(1)}%, avgSat=${borderTint.avgSaturation.toFixed(0)})`
      );
    } else {
      indicators.push(`[Region] borderTint=none (no hue reached ≥2 border strips)`);
    }

    return {
      borderTint,
      centerRainbowScore: rainbow.score,
      centerHueCount: rainbow.hueCount,
      indicators,
    };
  } catch (err: any) {
    return {
      borderTint: null,
      centerRainbowScore: 0,
      centerHueCount: 0,
      indicators: [`[Region] analysis failed: ${err?.message}`],
    };
  }
}

/** Map our hue buckets to the color names used by visualFoilDetector.classifyDominantColor. */
export function hueBucketToColorName(hue: HueBucket): string {
  switch (hue) {
    case 'red': return 'Red';
    case 'orange': return 'Orange';
    case 'yellow': return 'Gold';
    case 'green': return 'Green';
    case 'aqua': return 'Aqua';
    case 'blue': return 'Blue';
    case 'purple': return 'Purple';
    case 'pink': return 'Pink';
  }
}
