import { ImageAnnotatorClient } from '@google-cloud/vision';
import sharp from 'sharp';

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

interface CroppedRegions {
  borderBase64: string;
  centerBase64: string;
  dimensions: { width: number; height: number };
}

async function cropCardRegions(base64Image: string): Promise<CroppedRegions> {
  const imageBuffer = Buffer.from(base64Image, 'base64');
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 800;
  const height = metadata.height || 1200;
  
  if (width < 100 || height < 100) {
    throw new Error(`Image too small for regional analysis: ${width}x${height}`);
  }
  
  const borderPct = 0.12;
  const borderLeft = Math.round(width * borderPct);
  const borderTop = Math.round(height * borderPct);
  const borderRight = Math.round(width * borderPct);
  const borderBottom = Math.round(height * borderPct);
  
  const innerW = width - borderLeft - borderRight;
  const innerH = height - borderTop - borderBottom;
  
  const topStrip = await sharp(imageBuffer).extract({ left: 0, top: 0, width, height: borderTop }).toBuffer();
  const bottomStrip = await sharp(imageBuffer).extract({ left: 0, top: height - borderBottom, width, height: borderBottom }).toBuffer();
  const leftStrip = await sharp(imageBuffer).extract({ left: 0, top: borderTop, width: borderLeft, height: innerH }).toBuffer();
  const rightStrip = await sharp(imageBuffer).extract({ left: width - borderRight, top: borderTop, width: borderRight, height: innerH }).toBuffer();
  
  const borderComposite = await sharp({
    create: {
      width: width,
      height: height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 }
    }
  }).composite([
    { input: topStrip, top: 0, left: 0 },
    { input: bottomStrip, top: height - borderBottom, left: 0 },
    { input: leftStrip, top: borderTop, left: 0 },
    { input: rightStrip, top: borderTop, left: width - borderRight },
  ]).jpeg().toBuffer();
  
  const centerX = Math.round(width * 0.2);
  const centerY = Math.round(height * 0.2);
  const centerW = Math.round(width * 0.6);
  const centerH = Math.round(height * 0.6);
  
  const centerCrop = await sharp(imageBuffer).extract({ 
    left: centerX, top: centerY, width: centerW, height: centerH 
  }).jpeg().toBuffer();
  
  console.log(`Cropped regions: border composite ${borderComposite.length} bytes, center ${centerCrop.length} bytes (from ${width}x${height} image)`);
  
  return {
    borderBase64: borderComposite.toString('base64'),
    centerBase64: centerCrop.toString('base64'),
    dimensions: { width, height }
  };
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

function analyzeBorderColors(colors: ColorEntry[]): {
  isFoil: boolean;
  foilColor: string | null;
  confidence: number;
  hasWhiteBorder: boolean;
  indicators: string[];
} {
  const indicators: string[] = [];
  let hasMetallicColors = false;
  let detectedColorTint: string | null = null;
  let totalColorVariance = 0;
  let tintedColorCount = 0;
  const detectedTints: { name: string; coverage: number }[] = [];
  let hasWhiteBorder = false;
  
  for (const c of colors) {
    console.log(`  Border color: RGB(${c.r},${c.g},${c.b}) brightness=${c.brightness.toFixed(0)} saturation=${c.saturation} coverage=${(c.pixelFraction * 100).toFixed(1)}% name=${c.colorName || 'none'}`);
    
    if (c.brightness > 220 && c.saturation < 20 && c.pixelFraction > 0.15) {
      hasWhiteBorder = true;
      indicators.push(`White border detected: RGB(${c.r},${c.g},${c.b}) - ${(c.pixelFraction * 100).toFixed(1)}%`);
    }
    
    if (c.brightness > 60 && c.saturation > 25 && c.pixelFraction > 0.02) {
      hasMetallicColors = true;
      totalColorVariance += c.saturation * c.pixelFraction;
      indicators.push(`Border metallic color: RGB(${c.r},${c.g},${c.b}) - saturation: ${c.saturation}, coverage: ${(c.pixelFraction * 100).toFixed(1)}%`);
    }
    
    if (c.saturation > 20 && c.pixelFraction > 0.02 && Math.max(c.r, c.g, c.b) > 70) {
      if (c.colorName) {
        tintedColorCount++;
        detectedTints.push({ name: c.colorName, coverage: c.pixelFraction });
        if (!detectedColorTint) {
          detectedColorTint = c.colorName;
        }
        indicators.push(`Border ${c.colorName} tint: RGB(${c.r},${c.g},${c.b}) - ${(c.pixelFraction * 100).toFixed(1)}%`);
      }
    }
  }
  
  const hasSimilarTints = detectedTints.length >= 2 && 
    detectedTints.some(t => t.name === detectedColorTint && t !== detectedTints[0]);
  const totalTintCoverage = detectedTints.reduce((sum, t) => sum + t.coverage, 0);
  
  indicators.push(`Border summary: ${tintedColorCount} tinted regions, similar=${hasSimilarTints}, tint coverage=${(totalTintCoverage * 100).toFixed(1)}%`);
  
  const isFoil = hasMetallicColors && detectedColorTint !== null && (hasSimilarTints || totalTintCoverage > 0.06);
  const confidence = isFoil ? Math.min(0.6, totalColorVariance * 2 + totalTintCoverage) : 0;
  
  return { isFoil, foilColor: detectedColorTint, confidence, hasWhiteBorder, indicators };
}

function analyzeCenterTexture(colors: ColorEntry[], labels: any[]): {
  texture: TextureType;
  textureConfidence: number;
  indicators: string[];
} {
  const indicators: string[] = [];
  
  for (const c of colors) {
    console.log(`  Center color: RGB(${c.r},${c.g},${c.b}) brightness=${c.brightness.toFixed(0)} saturation=${c.saturation} coverage=${(c.pixelFraction * 100).toFixed(1)}% name=${c.colorName || 'none'}`);
  }
  
  const { texture: labelTexture, textureConfidence: labelConf, labelIndicators } = detectTextureFromLabels(labels);
  indicators.push(...labelIndicators.map(i => `Center ${i}`));
  
  const { texture: colorTexture, textureConfidence: colorConf, textureIndicators } = detectTextureFromColors(colors);
  indicators.push(...textureIndicators.map(i => `Center ${i}`));
  
  if (labelTexture && labelConf > colorConf) {
    return { texture: labelTexture, textureConfidence: labelConf, indicators };
  }
  if (colorTexture) {
    return { texture: colorTexture, textureConfidence: colorConf, indicators };
  }
  if (labelTexture) {
    return { texture: labelTexture, textureConfidence: labelConf, indicators };
  }
  
  return { texture: null, textureConfidence: 0, indicators };
}

export async function detectFoilFromImage(base64Image: string): Promise<FoilDetectionResult> {
  console.log('=== VISUAL FOIL DETECTION STARTING (REGIONAL ANALYSIS) ===');
  
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

    let regions: CroppedRegions;
    try {
      regions = await cropCardRegions(base64Image);
    } catch (cropError: any) {
      console.log('Image cropping failed, falling back to full-image analysis:', cropError.message);
      return await detectFoilFromFullImage(base64Image, client);
    }

    console.log('=== BORDER REGION ANALYSIS (foil color detection) ===');
    const borderRequest = {
      image: { content: regions.borderBase64 },
      features: [{ type: 'IMAGE_PROPERTIES' as const }],
    };
    
    console.log('=== CENTER REGION ANALYSIS (texture/crackle detection) ===');
    const centerRequest = {
      image: { content: regions.centerBase64 },
      features: [
        { type: 'LABEL_DETECTION' as const, maxResults: 30 },
        { type: 'IMAGE_PROPERTIES' as const }
      ],
    };

    const fullImageRequest = {
      image: { content: base64Image },
      features: [{ type: 'LABEL_DETECTION' as const, maxResults: 30 }],
    };

    let borderResult, centerResult, fullLabelsResult;
    try {
      [borderResult, centerResult, fullLabelsResult] = await Promise.all([
        client.annotateImage(borderRequest),
        client.annotateImage(centerRequest),
        client.annotateImage(fullImageRequest),
      ]);
      borderResult = borderResult[0] || borderResult;
      centerResult = centerResult[0] || centerResult;
      fullLabelsResult = fullLabelsResult[0] || fullLabelsResult;
    } catch (visionError: any) {
      console.log('Vision API error on regional analysis:', visionError.message);
      if (visionError.message?.includes('DECODER') || visionError.message?.includes('unsupported')) {
        return { isFoil: false, foilType: null, confidence: 0, indicators: ['Visual analysis failed due to image format/decoder error'] };
      }
      throw visionError;
    }

    const indicators: string[] = [];
    let isFoil = false;
    let foilType: string | null = null;
    let confidence = 0;
    let hasStrongFoilIndicators = false;

    const fullLabels = fullLabelsResult.labelAnnotations || [];
    console.log('Full image labels:', fullLabels.map((l: any) => `${l.description} (${l.score?.toFixed(2)})`));
    
    for (const label of fullLabels) {
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
      }
    }

    const borderColors = borderResult.imagePropertiesAnnotation?.dominantColors?.colors || [];
    const parsedBorderColors = parseVisionColors(borderColors);
    const borderAnalysis = analyzeBorderColors(parsedBorderColors);
    indicators.push(...borderAnalysis.indicators);

    const centerColors = centerResult.imagePropertiesAnnotation?.dominantColors?.colors || [];
    const parsedCenterColors = parseVisionColors(centerColors);
    const centerLabels = centerResult.labelAnnotations || [];
    console.log('Center image labels:', centerLabels.map((l: any) => `${l.description} (${l.score?.toFixed(2)})`));
    const centerAnalysis = analyzeCenterTexture(parsedCenterColors, centerLabels);
    indicators.push(...centerAnalysis.indicators);

    if (borderAnalysis.isFoil && !foilType) {
      isFoil = true;
      confidence += borderAnalysis.confidence;
      
      if (centerAnalysis.texture && centerAnalysis.textureConfidence >= 0.3) {
        foilType = `${borderAnalysis.foilColor} ${centerAnalysis.texture} Foil`;
      } else {
        foilType = `${borderAnalysis.foilColor} Foil`;
      }
      indicators.push(`Regional detection: border color=${borderAnalysis.foilColor}, center texture=${centerAnalysis.texture || 'standard'} (conf: ${centerAnalysis.textureConfidence.toFixed(2)})`);
    }

    if (isFoil && foilType && centerAnalysis.texture && centerAnalysis.textureConfidence >= 0.3 &&
        !foilType.includes('Crackle') && !foilType.includes('Shimmer') && !foilType.includes('Ice')) {
      const colorPart = foilType.replace(/\s*Foil\s*$/i, '').trim();
      if (colorPart && colorPart !== 'Rainbow' && colorPart !== 'Chrome' && colorPart !== 'Silver' && colorPart !== 'Gold') {
        foilType = `${colorPart} ${centerAnalysis.texture} Foil`;
        indicators.push(`Texture refinement from center analysis: "${foilType}" (confidence: ${centerAnalysis.textureConfidence.toFixed(2)})`);
      }
    }

    const hasColorBasedFoil = isFoil && foilType && foilType !== 'Foil';
    
    if (isFoil && !hasStrongFoilIndicators && !hasColorBasedFoil) {
      console.log('REJECTING foil detection - no strong indicators or color-based detection');
      isFoil = false;
      foilType = null;
      confidence = 0;
      indicators.push('REJECTED: No strong foil indicators or color-based detection');
    } else if (isFoil && borderAnalysis.hasWhiteBorder && !borderAnalysis.isFoil && confidence < 0.7) {
      console.log('REJECTING foil detection - likely white border reflection');
      isFoil = false;
      foilType = null;
      confidence = 0;
      indicators.push('REJECTED: Likely false positive from white border reflection');
    }
    
    confidence = Math.min(confidence, 1.0);
    
    if (isFoil && !foilType && (hasStrongFoilIndicators || hasColorBasedFoil)) {
      foilType = 'Foil';
    } else if (isFoil && !foilType) {
      isFoil = false;
      confidence = 0;
      indicators.push('REJECTED: No strong foil indicators or color-based detection found');
    }

    console.log('=== VISUAL FOIL DETECTION RESULT (REGIONAL) ===');
    console.log(`Is Foil: ${isFoil}`);
    console.log(`Foil Type: ${foilType}`);
    console.log(`Border color: ${borderAnalysis.foilColor || 'none'}`);
    console.log(`Center texture: ${centerAnalysis.texture || 'none'} (confidence: ${centerAnalysis.textureConfidence.toFixed(2)})`);
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

async function detectFoilFromFullImage(base64Image: string, client: ImageAnnotatorClient): Promise<FoilDetectionResult> {
  console.log('Running fallback full-image foil detection...');
  
  const request = {
    image: { content: base64Image },
    features: [
      { type: 'LABEL_DETECTION' as const, maxResults: 30 },
      { type: 'IMAGE_PROPERTIES' as const }
    ],
  };

  let result;
  try {
    [result] = await client.annotateImage(request);
  } catch (visionError: any) {
    return { isFoil: false, foilType: null, confidence: 0, indicators: ['Fallback analysis failed'] };
  }
  
  let isFoil = false;
  let foilType: string | null = null;
  let confidence = 0;
  const indicators: string[] = ['Using full-image fallback analysis'];
  let hasStrongFoilIndicators = false;
  let hasWhiteBorderReflection = false;

  const labels = result.labelAnnotations || [];
  
  for (const label of labels) {
    const description = label.description?.toLowerCase() || '';
    const score = label.score || 0;
    
    if (description.includes('rainbow') || description.includes('prismatic') || description.includes('iridescent')) {
      confidence += score * 0.7;
      isFoil = true;
      hasStrongFoilIndicators = true;
      foilType = 'Rainbow Foil';
    }
    if ((description.includes('chrome') || description.includes('metallic')) && score > 0.6) {
      confidence += score * 0.6;
      isFoil = true;
      hasStrongFoilIndicators = true;
      if (!foilType) foilType = 'Chrome';
    }
  }

  const imageProps = result.imagePropertiesAnnotation;
  if (imageProps?.dominantColors?.colors) {
    const parsedColors = parseVisionColors(imageProps.dominantColors.colors);
    let detectedColorTint: string | null = null;
    let tintedColorCount = 0;
    const detectedTints: { name: string; coverage: number }[] = [];
    let hasMetallicColors = false;
    let totalColorVariance = 0;
    
    for (const c of parsedColors) {
      if (c.brightness > 220 && c.saturation < 20 && c.pixelFraction > 0.2) {
        hasWhiteBorderReflection = true;
      }
      if (c.brightness > 60 && c.saturation > 30 && c.pixelFraction > 0.03) {
        hasMetallicColors = true;
        totalColorVariance += c.saturation * c.pixelFraction;
      }
      if (c.saturation > 25 && c.pixelFraction > 0.03 && Math.max(c.r, c.g, c.b) > 70 && c.colorName) {
        tintedColorCount++;
        detectedTints.push({ name: c.colorName, coverage: c.pixelFraction });
        if (!detectedColorTint) detectedColorTint = c.colorName;
      }
    }
    
    const hasSimilarTints = detectedTints.length >= 2;
    const totalTintCoverage = detectedTints.reduce((sum, t) => sum + t.coverage, 0);
    
    if (hasMetallicColors && detectedColorTint && (hasSimilarTints || totalTintCoverage > 0.08)) {
      confidence += 0.4;
      isFoil = true;
      if (!foilType) foilType = `${detectedColorTint} Foil`;
    }
    
    if (hasWhiteBorderReflection && !hasMetallicColors) {
      isFoil = false;
      foilType = null;
      confidence = 0;
    }
  }
  
  confidence = Math.min(confidence, 1.0);
  if (isFoil && !foilType) {
    if (hasStrongFoilIndicators) foilType = 'Foil';
    else { isFoil = false; confidence = 0; }
  }

  return { isFoil, foilType, confidence, indicators };
}
