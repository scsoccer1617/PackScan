import { ImageAnnotatorClient } from '@google-cloud/vision';
import { analyzeRegionalFoilEvidence, hueBucketToColorName, type RegionalFoilEvidence } from './regionalFoilAnalyzer';

interface FoilDetectionResult {
  isFoil: boolean;
  foilType: string | null;
  confidence: number;
  indicators: string[];
}

function formatPrivateKey(rawKey: string): string {
  let cleanKey = rawKey.replace(/\\n/g, '\n');
  cleanKey = cleanKey.replace(/^["']|["']$/g, '');
  if (!cleanKey.startsWith('-----BEGIN')) {
    cleanKey = `-----BEGIN PRIVATE KEY-----\n${cleanKey}\n-----END PRIVATE KEY-----`;
  }
  const lines = cleanKey.split('\n');
  return lines.map(line => line.trim()).filter(line => line.length > 0).join('\n');
}

function classifyDominantColor(r: number, g: number, b: number): string | null {
  const maxChannel = Math.max(r, g, b);
  const minChannel = Math.min(r, g, b);
  const saturation = maxChannel - minChannel;
  const brightness = (r + g + b) / 3;
  
  if (brightness > 160 && saturation < 30 && r > 150 && g > 150 && b > 150) return 'Silver';
  
  if (saturation < 20) return null;
  
  if ((b > r + 20 && b > g) || (g > r + 10 && b > r + 10 && Math.abs(g - b) < 30)) {
    if (g > r + 10 && Math.abs(g - b) < 35 && b > 70) return 'Aqua';
    if (b > r + 20 && b > g + 5 && b > 80) return 'Blue';
  }
  if (g > r + 20 && g > b + 20 && g > 80) return 'Green';
  if (r > g + 35 && r > b + 35 && r > 100) return 'Red';
  if (r > 150 && g > 100 && g < 200 && b < 80) return 'Gold';
  if (r > 80 && g < 80 && b > r - 30 && b > 80) return 'Purple';
  if (r > 180 && g > 80 && g < 180 && b < 80) return 'Orange';
  if (r > 180 && g < 150 && b > 130) return 'Pink';
  
  return null;
}

type TextureType = 'Crackle' | 'Shimmer' | 'Ice' | null;

function detectTextureFromLabels(labels: Array<{ description?: string | null; score?: number | null }>): { texture: TextureType; textureConfidence: number; labelIndicators: string[] } {
  const labelIndicators: string[] = [];
  const scores: Record<string, number> = { Crackle: 0, Shimmer: 0, Ice: 0 };
  
  const crackleLabels = ['glitter', 'sparkle', 'speckle', 'confetti', 'dotted', 'spotted', 'sprinkle', 'particle', 'sequin'];
  const shimmerLabels = ['shimmer', 'sheen', 'luster', 'lustre', 'gleam', 'glow'];
  const iceLabels = ['ice', 'frost', 'frozen', 'crystal', 'crystalline'];
  
  for (const label of labels) {
    const desc = label.description?.toLowerCase() || '';
    const score = label.score || 0;
    
    for (const keyword of crackleLabels) {
      if (desc.includes(keyword) && score > 0.3) {
        scores.Crackle += score;
        labelIndicators.push(`Crackle texture label: "${desc}" (${score.toFixed(2)})`);
      }
    }
    for (const keyword of shimmerLabels) {
      if (desc.includes(keyword) && score > 0.3) {
        scores.Shimmer += score;
        labelIndicators.push(`Shimmer texture label: "${desc}" (${score.toFixed(2)})`);
      }
    }
    for (const keyword of iceLabels) {
      if (desc.includes(keyword) && score > 0.3) {
        scores.Ice += score;
        labelIndicators.push(`Ice texture label: "${desc}" (${score.toFixed(2)})`);
      }
    }
  }
  
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best[1] > 0) {
    return { texture: best[0] as TextureType, textureConfidence: best[1], labelIndicators };
  }
  
  return { texture: null, textureConfidence: 0, labelIndicators };
}

interface ColorEntry {
  r: number;
  g: number;
  b: number;
  brightness: number;
  saturation: number;
  pixelFraction: number;
  colorName: string | null;
}

function detectTextureFromColors(colors: ColorEntry[]): { texture: TextureType; textureConfidence: number; textureIndicators: string[] } {
  const textureIndicators: string[] = [];
  
  const brightSaturatedSmall = colors.filter(c => 
    c.brightness > 80 && c.saturation > 20 && c.pixelFraction < 0.04 && c.pixelFraction > 0.005
  );
  
  const smallCoverage = brightSaturatedSmall.reduce((sum, c) => sum + c.pixelFraction, 0);
  
  const brightVariedColors = colors.filter(c => 
    c.brightness > 60 && c.saturation > 15 && c.pixelFraction > 0.005
  );
  
  const uniqueHues = new Set<string>();
  for (const c of brightVariedColors) {
    const hue = c.r > c.g && c.r > c.b ? 'R' : 
                c.g > c.r && c.g > c.b ? 'G' : 
                c.b > c.r && c.b > c.g ? 'B' :
                c.r > c.b ? 'RG' : c.g > c.b ? 'GB' : 'RB';
    uniqueHues.add(hue);
  }
  
  const smoothLargeRegions = colors.filter(c => 
    c.brightness > 100 && c.saturation > 20 && c.pixelFraction > 0.08
  );
  
  const colorSpread = brightSaturatedSmall.length;
  const hueVariety = uniqueHues.size;
  
  textureIndicators.push(`Texture analysis: ${colorSpread} small bright regions (${(smallCoverage * 100).toFixed(1)}% coverage), ${hueVariety} hue groups, ${smoothLargeRegions.length} large uniform regions`);
  
  if (colorSpread >= 3 && hueVariety >= 3 && smallCoverage > 0.05 && smoothLargeRegions.length === 0) {
    const conf = Math.min(0.8, (colorSpread / 5) * 0.4 + (hueVariety / 4) * 0.4);
    textureIndicators.push(`Strong crackle pattern: ${colorSpread} scattered regions, ${hueVariety} hues, ${(smallCoverage * 100).toFixed(1)}% small-region coverage`);
    return { texture: 'Crackle', textureConfidence: conf, textureIndicators };
  }
  
  if (colorSpread >= 2 && hueVariety >= 2 && smallCoverage > 0.03) {
    const conf = Math.min(0.5, (colorSpread / 4) * 0.3 + (hueVariety / 3) * 0.2);
    textureIndicators.push(`Possible crackle pattern: ${colorSpread} scattered regions, ${hueVariety} hues, ${(smallCoverage * 100).toFixed(1)}% coverage`);
    return { texture: 'Crackle', textureConfidence: conf, textureIndicators };
  }
  
  if (smoothLargeRegions.length >= 1 && colorSpread < 2) {
    textureIndicators.push(`Smooth foil pattern: ${smoothLargeRegions.length} large uniform regions`);
    return { texture: 'Shimmer', textureConfidence: 0.4, textureIndicators };
  }
  
  return { texture: null, textureConfidence: 0, textureIndicators };
}

function parseVisionColors(rawColors: any[]): ColorEntry[] {
  const parsed: ColorEntry[] = [];
  for (const colorInfo of rawColors) {
    const color = colorInfo.color;
    if (!color) continue;
    const r = color.red || 0;
    const g = color.green || 0;
    const b = color.blue || 0;
    const pixelFraction = colorInfo.pixelFraction || 0;
    const brightness = (r + g + b) / 3;
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
    const colorName = classifyDominantColor(r, g, b);
    parsed.push({ r, g, b, brightness, saturation, pixelFraction, colorName });
  }
  return parsed;
}

export async function detectFoilFromImage(
  base64Image: string,
  options?: { isNumbered?: boolean; imageBuffer?: Buffer }
): Promise<FoilDetectionResult> {
  console.log('=== VISUAL FOIL DETECTION STARTING (FULL IMAGE ANALYSIS) ===');

  // Run region-aware analysis in parallel with the Vision API call. This
  // gives us two independent evidence streams: the global Vision colour
  // histogram (good when the photo is clean) and per-region pixel sampling
  // (good when fingers/reflections suppress the global signal).
  let regional: RegionalFoilEvidence | null = null;
  const regionalPromise = options?.imageBuffer
    ? analyzeRegionalFoilEvidence(options.imageBuffer).catch(err => {
        console.log('[Region] regional analysis failed:', err?.message);
        return null;
      })
    : Promise.resolve(null);
  
  try {
    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY;
    
    if (!clientEmail || !privateKey) {
      return {
        isFoil: false,
        foilType: null,
        confidence: 0,
        indicators: ['Missing Google Cloud credentials for visual analysis']
      };
    }
    
    const formattedKey = formatPrivateKey(privateKey);
    
    const client = new ImageAnnotatorClient({
      credentials: {
        client_email: clientEmail,
        private_key: formattedKey,
      },
    });

    const request = {
      image: { content: base64Image },
      features: [
        { type: 'LABEL_DETECTION' as const, maxResults: 30 },
        { type: 'IMAGE_PROPERTIES' as const }
      ],
    };

    let apiResult;
    try {
      [apiResult] = await client.annotateImage(request);
    } catch (visionError: any) {
      console.log('Vision API error:', visionError.message);
      return { isFoil: false, foilType: null, confidence: 0, indicators: ['Visual analysis failed due to image format/decoder error'] };
    }

    const indicators: string[] = [];
    let isFoil = false;
    let foilType: string | null = null;
    let confidence = 0;
    let hasStrongFoilIndicators = false;
    let hasReflectiveLabels = false;
    let hasWhiteBorderReflection = false;

    const labels = apiResult.labelAnnotations || [];
    console.log('Image labels:', labels.map((l: any) => `${l.description} (${l.score?.toFixed(2)})`));
    
    for (const label of labels) {
      const description = label.description?.toLowerCase() || '';
      const score = label.score || 0;
      
      if (description.includes('rainbow') || description.includes('prismatic') || description.includes('iridescent')) {
        indicators.push(`Strong prismatic effect detected (${score.toFixed(2)})`);
        confidence += score * 0.7;
        isFoil = true;
        hasStrongFoilIndicators = true;
        foilType = 'Rainbow Foil';
      }
      
      if ((description.includes('chrome') || description.includes('metallic')) && score > 0.6) {
        indicators.push(`Chrome/metallic surface detected (${score.toFixed(2)})`);
        confidence += score * 0.6;
        isFoil = true;
        hasStrongFoilIndicators = true;
        if (!foilType) foilType = 'Chrome';
      }
      
      if (description.includes('silver') && score > 0.5) {
        indicators.push(`Silver surface detected (${score.toFixed(2)})`);
        confidence += score * 0.5;
        isFoil = true;
        foilType = 'Silver Foil';
      }
      
      if (description.includes('gold') || description.includes('golden')) {
        indicators.push(`Gold surface detected (${score.toFixed(2)})`);
        confidence += score * 0.5;
        isFoil = true;
        foilType = 'Gold Foil';
      }
      
      if ((description.includes('reflect') || description.includes('shiny') || description.includes('gloss')) && score > 0.7) {
        indicators.push(`Reflective surface detected (${score.toFixed(2)})`);
        confidence += score * 0.3;
        hasReflectiveLabels = true;
      }
      
      if ((description.includes('metallic') || description.includes('chrome') || description.includes('foil') || 
           description.includes('hologram') || description.includes('holographic') || description.includes('mirror') ||
           description.includes('aluminum') || description.includes('steel') || description.includes('metal')) && score > 0.3) {
        hasReflectiveLabels = true;
      }
    }

    const { texture: labelTexture, textureConfidence: labelTextureConf, labelIndicators } = detectTextureFromLabels(labels);
    indicators.push(...labelIndicators);

    const imageProps = apiResult.imagePropertiesAnnotation;
    if (imageProps?.dominantColors?.colors) {
      const parsedColors = parseVisionColors(imageProps.dominantColors.colors);
      let detectedColorTint: string | null = null;
      let tintedColorCount = 0;
      const detectedTints: { name: string; coverage: number; saturation: number }[] = [];
      let hasMetallicColors = false;
      let totalColorVariance = 0;
      
      for (const c of parsedColors) {
        console.log(`  Color: RGB(${c.r},${c.g},${c.b}) brightness=${c.brightness.toFixed(0)} saturation=${c.saturation} coverage=${(c.pixelFraction * 100).toFixed(1)}% name=${c.colorName || 'none'}`);
        
        if (c.brightness > 220 && c.saturation < 20 && c.pixelFraction > 0.2) {
          hasWhiteBorderReflection = true;
          indicators.push(`White border detected: RGB(${c.r},${c.g},${c.b}) - ${(c.pixelFraction * 100).toFixed(1)}%`);
        }
        
        // Metallic: standard threshold OR very-high-saturation foil-like colors at lower coverage
        // Use >= to avoid excluding borderline values that round to display thresholds
        const isHighSatFoilColor = c.saturation > 150 && c.pixelFraction >= 0.005 && c.brightness > 60;
        if ((c.brightness > 60 && c.saturation > 25 && c.pixelFraction >= 0.015) || isHighSatFoilColor) {
          hasMetallicColors = true;
          totalColorVariance += c.saturation * c.pixelFraction;
          indicators.push(`Metallic color: RGB(${c.r},${c.g},${c.b}) - saturation: ${c.saturation}, coverage: ${(c.pixelFraction * 100).toFixed(1)}%`);
        }
        
        // Tinted: standard threshold OR very-high-saturation foil-like colors at lower coverage
        // Use >= to avoid excluding borderline values that round to display thresholds
        const isFoilLikeColor = c.saturation > 150 && c.pixelFraction >= 0.005;
        if ((c.saturation > 20 && c.pixelFraction >= 0.015 || isFoilLikeColor) && Math.max(c.r, c.g, c.b) > 70) {
          if (c.colorName) {
            tintedColorCount++;
            detectedTints.push({ name: c.colorName, coverage: c.pixelFraction, saturation: c.saturation });
            if (!detectedColorTint) {
              detectedColorTint = c.colorName;
            }
            indicators.push(`${c.colorName} tint: RGB(${c.r},${c.g},${c.b}) - ${(c.pixelFraction * 100).toFixed(1)}%`);
          }
        }
      }
      
      const hasSimilarTints = detectedTints.length >= 2 && 
        detectedTints.some(t => t.name === detectedColorTint && t !== detectedTints[0]);
      const totalTintCoverage = detectedTints.reduce((sum, t) => sum + t.coverage, 0);
      
      // Coverage of ONLY the dominant tint color (not all tints combined).
      // A genuine foil border parallel will have its specific color covering ≥10% of the card.
      // A sports card photo with a blue jersey will have blue in scattered small regions (<10%).
      const sameTintCoverage = detectedTints
        .filter(t => t.name === detectedColorTint)
        .reduce((sum, t) => sum + t.coverage, 0);
      
      indicators.push(`Color summary: ${tintedColorCount} tinted regions, similar=${hasSimilarTints}, tint coverage=${(totalTintCoverage * 100).toFixed(1)}%, same-color coverage=${(sameTintCoverage * 100).toFixed(1)}%`);

      const sameTintItems = detectedTints.filter(t => t.name === detectedColorTint);
      const similarTintCount = sameTintItems.length;
      const hasStrongSimilarTints = similarTintCount >= 3;
      // Average saturation of the dominant same-color tint regions.
      // Foil border colors are vivid/pure (avg sat >100); natural photo colors (jerseys, backgrounds) are muted (~60-85).
      const sameTintAvgSaturation = sameTintItems.length > 0
        ? sameTintItems.reduce((sum, t) => sum + t.saturation, 0) / sameTintItems.length
        : 0;
      indicators.push(`Same-color avg saturation: ${sameTintAvgSaturation.toFixed(0)} (${sameTintItems.length} regions)`);

      // ── Await regional evidence and merge it in ──────────────────────────
      // The regional analyzer samples the 4 border strips and the center
      // independently. Border agreement on a hue is much stronger evidence
      // of a coloured-border parallel than a global histogram peak (which
      // gets diluted by fingers, reflections, and the player photo). Center
      // rainbow score acts as a stand-in for a "Reflective/Holographic"
      // Vision label when Vision didn't return one.
      regional = await regionalPromise;
      let hasBorderTintEvidence = false;
      let hasCenterRainbowEvidence = false;
      let regionalColorName: string | null = null;
      if (regional) {
        indicators.push(...regional.indicators);
        if (regional.borderTint) {
          // Require ≥2 agreeing strips AND meaningful average coverage.
          // 2 strips at ≥4% each is the entry bar; saturation >60 keeps
          // dull skin/wood-grain backgrounds out.
          if (regional.borderTint.agreeingStripCount >= 2 &&
              regional.borderTint.coverage >= 0.04 &&
              regional.borderTint.avgSaturation >= 60) {
            hasBorderTintEvidence = true;
            regionalColorName = hueBucketToColorName(regional.borderTint.hue);
            indicators.push(`[Region] borderTint qualifies as foil evidence → ${regionalColorName}`);
          }
        }
        if (regional.centerRainbowScore >= 0.7 || regional.centerHueCount >= 3) {
          hasCenterRainbowEvidence = true;
          indicators.push(`[Region] center rainbow qualifies as reflective evidence (score=${regional.centerRainbowScore.toFixed(2)}, hues=${regional.centerHueCount})`);
        }
      }
      // Treat strong center rainbow the same as a Vision "Reflective" label
      // for downstream gating.
      if (hasCenterRainbowEvidence) hasReflectiveLabels = true;

      // Relaxed thresholds — the original numbers required ≥10% same-color
      // global coverage which fails on cards with fingers/reflections. We
      // now accept 6% global coverage when EITHER border-strip agreement OR
      // center rainbow backs it up. Without regional support the original
      // (stricter) bar still applies, so plain matte cards don't suddenly
      // become foil.
      const baseHighCoverage = 0.10;
      const baseVividCoverage = 0.05;
      const regionalRelaxedCoverage = (hasBorderTintEvidence || hasCenterRainbowEvidence) ? 0.06 : baseHighCoverage;
      const hasHighCoverageEvidence = hasStrongSimilarTints && sameTintCoverage > regionalRelaxedCoverage;

      // Vivid printed colors (a red team-color panel, a blue jersey, a
      // yellow team logo) look identical to vivid foil colors when judged
      // by saturation alone. The ONLY thing that distinguishes them is
      // reflectiveness — foil shimmers across multiple hues, prints don't.
      // So vivid-color evidence on its own is not enough: it must be
      // backed up by at least one independent reflective signal:
      //   • Vision API foil/reflective/holographic labels, OR
      //   • Regional border-strip agreement with high saturation, OR
      //   • Center rainbow score (multiple hues in middle of card), OR
      //   • Numbered-card context (parallels are usually serial-numbered).
      // Without any of these, "high saturation" is just bold ink, not foil.
      const hasReflectiveSupport = hasStrongFoilIndicators || hasReflectiveLabels ||
                                    hasBorderTintEvidence || hasCenterRainbowEvidence;
      const hasVividColorEvidence  = hasStrongSimilarTints && sameTintCoverage > baseVividCoverage &&
                                     sameTintAvgSaturation > 100 && hasReflectiveSupport;
      // Border agreement alone is enough when its hue lines up with the
      // global tint OR when the center is unambiguously rainbow.
      const hasBorderConfirmedColor = hasBorderTintEvidence && (
        regionalColorName === detectedColorTint || hasCenterRainbowEvidence
      );
      const hasStrongColorEvidence = hasHighCoverageEvidence || hasVividColorEvidence || hasBorderConfirmedColor;
      indicators.push(`Reflective support: labels=${hasStrongFoilIndicators || hasReflectiveLabels}, borderTint=${hasBorderTintEvidence}, centerRainbow=${hasCenterRainbowEvidence} → ${hasReflectiveSupport ? 'YES' : 'NO (vivid color alone insufficient)'}`);
      const hasModestSimilarTints = similarTintCount >= 2 && totalTintCoverage > 0.20;

      indicators.push(`Label support: strongFoil=${hasStrongFoilIndicators}, reflective=${hasReflectiveLabels} (centerRainbow=${hasCenterRainbowEvidence})`);

      const hasVeryStrongColorEvidence = similarTintCount >= 5 && totalTintCoverage > 0.40;
      const hasLabelSupport = hasStrongFoilIndicators || hasReflectiveLabels;
      const isNumbered = options?.isNumbered || false;
      const hasNumberedCardEvidence = isNumbered && similarTintCount >= 2 && totalTintCoverage > 0.08;

      indicators.push(`Numbered card context: isNumbered=${isNumbered}, numberedEvidence=${hasNumberedCardEvidence}`);

      // If the global tint and the border tint disagree, prefer the border
      // tint — it's the more reliable signal for parallel borders.
      if (hasBorderTintEvidence && regionalColorName && detectedColorTint && regionalColorName !== detectedColorTint) {
        indicators.push(`[Region] overriding global tint "${detectedColorTint}" with border tint "${regionalColorName}"`);
        detectedColorTint = regionalColorName;
      } else if (hasBorderTintEvidence && regionalColorName && !detectedColorTint) {
        // Global histogram missed the color entirely (fingers/reflections);
        // adopt the regional tint as the working color.
        indicators.push(`[Region] adopting border tint "${regionalColorName}" — global tint was empty`);
        detectedColorTint = regionalColorName;
      }

      if ((hasMetallicColors || hasBorderTintEvidence) && detectedColorTint && (hasLabelSupport || hasVeryStrongColorEvidence || hasNumberedCardEvidence || hasStrongColorEvidence) && (hasStrongSimilarTints || hasModestSimilarTints || totalTintCoverage > 0.25 || hasNumberedCardEvidence || hasStrongColorEvidence)) {
        isFoil = true;
        confidence += Math.min(0.6, totalColorVariance * 2 + totalTintCoverage);
        
        const { texture: colorTexture, textureConfidence: colorTextureConf, textureIndicators } = detectTextureFromColors(parsedColors);
        indicators.push(...textureIndicators);
        
        const bestTexture = labelTexture && labelTextureConf > (colorTextureConf || 0) ? labelTexture : colorTexture;
        const bestTextureConf = labelTexture && labelTextureConf > (colorTextureConf || 0) ? labelTextureConf : colorTextureConf;
        
        if (bestTexture && bestTextureConf >= 0.3) {
          foilType = `${detectedColorTint} ${bestTexture} Foil`;
        } else if (!foilType) {
          foilType = `${detectedColorTint} Foil`;
        }
        indicators.push(`Color-based detection: color=${detectedColorTint}, texture=${bestTexture || 'standard'} (conf: ${(bestTextureConf || 0).toFixed(2)})`);
      }
      
      if (hasWhiteBorderReflection && !hasMetallicColors && !hasStrongFoilIndicators) {
        console.log('REJECTING foil detection - likely white border reflection');
        isFoil = false;
        foilType = null;
        confidence = 0;
        indicators.push('REJECTED: Likely false positive from white border reflection');
      }

      // Solid-color parallels (Sapphire, Blue, Red, Green, Gold, etc.) ALWAYS have
      // borders tinted with their parallel color. If the card shows a prominent
      // white border, the detected color tint is almost certainly coming from the
      // player photo/background — not the card's border treatment. Reject the
      // color-parallel classification even when chrome/metallic labels are present
      // (Chrome BASE cards have chrome surfaces + white borders and are NOT Sapphire).
      //
      // Allowed exceptions (parallels that legitimately keep white borders):
      //   - Rainbow Foil / Prismatic (no single solid color)
      //   - Plain "Chrome" (the base chrome surface itself)
      //   - Silver Foil (neutral, not a color parallel)
      if (hasWhiteBorderReflection && foilType) {
        const ft = foilType.toLowerCase();
        const isNeutralOrPrismatic =
          ft === 'chrome' ||
          ft === 'silver foil' ||
          ft.includes('rainbow') ||
          ft.includes('prismatic') ||
          ft.includes('iridescent');
        if (!isNeutralOrPrismatic) {
          const rejected = foilType;
          console.log(`REJECTING color parallel "${rejected}" - card has white borders (solid-color parallels have colored borders)`);
          isFoil = false;
          foilType = null;
          confidence = 0;
          indicators.push(`REJECTED "${rejected}": white border dominant — color tint is from photo, not a colored-border parallel`);
        }
      }
    }

    const hasColorBasedFoil = isFoil && foilType && foilType !== 'Foil';
    
    if (isFoil && !hasStrongFoilIndicators && !hasColorBasedFoil) {
      console.log('REJECTING foil detection - no strong indicators or color-based detection');
      isFoil = false;
      foilType = null;
      confidence = 0;
      indicators.push('REJECTED: No strong foil indicators or color-based detection');
    }
    
    confidence = Math.min(confidence, 1.0);
    
    if (isFoil && !foilType && (hasStrongFoilIndicators || hasColorBasedFoil)) {
      foilType = 'Foil';
    } else if (isFoil && !foilType) {
      isFoil = false;
      confidence = 0;
      indicators.push('REJECTED: No strong foil indicators or color-based detection found');
    }

    console.log('=== VISUAL FOIL DETECTION RESULT ===');
    console.log(`Is Foil: ${isFoil}`);
    console.log(`Foil Type: ${foilType}`);
    console.log(`Confidence: ${confidence.toFixed(2)}`);
    console.log(`Strong indicators present: ${hasStrongFoilIndicators}`);
    console.log(`Indicators: ${indicators.join('; ')}`);
    console.log('=== END VISUAL FOIL DETECTION ===');

    return { isFoil, foilType, confidence, indicators };

  } catch (error) {
    console.error('Error in visual foil detection:', error);
    console.error('Error details:', error instanceof Error ? error.message : error);
    return {
      isFoil: false,
      foilType: null,
      confidence: 0,
      indicators: [`Error in visual analysis: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}
