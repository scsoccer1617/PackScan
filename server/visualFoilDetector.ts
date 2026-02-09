import { ImageAnnotatorClient } from '@google-cloud/vision';

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
  
  if (colorSpread >= 3 && hueVariety >= 2 && smallCoverage > 0.04) {
    const conf = Math.min(0.5, (colorSpread / 5) * 0.3 + (hueVariety / 4) * 0.2);
    textureIndicators.push(`Possible crackle pattern: ${colorSpread} scattered regions, ${hueVariety} hues, ${(smallCoverage * 100).toFixed(1)}% coverage`);
    return { texture: 'Crackle', textureConfidence: conf, textureIndicators };
  }
  
  if (smoothLargeRegions.length >= 1 && colorSpread < 2) {
    textureIndicators.push(`Smooth foil pattern: ${smoothLargeRegions.length} large uniform regions`);
    return { texture: 'Shimmer', textureConfidence: 0.4, textureIndicators };
  }
  
  return { texture: null, textureConfidence: 0, textureIndicators };
}

export async function detectFoilFromImage(base64Image: string): Promise<FoilDetectionResult> {
  console.log('=== VISUAL FOIL DETECTION STARTING ===');
  
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
      image: {
        content: base64Image,
      },
      features: [
        { type: 'LABEL_DETECTION' as const, maxResults: 30 },
        { type: 'IMAGE_PROPERTIES' as const }
      ],
    };

    let result;
    try {
      [result] = await client.annotateImage(request);
    } catch (visionError: any) {
      console.log('Google Vision API error:', visionError.message || visionError);
      
      if (visionError.message?.includes('DECODER') || visionError.message?.includes('unsupported')) {
        console.log('Image decoder error - likely image format issue, falling back to basic detection');
        return {
          isFoil: false,
          foilType: null,
          confidence: 0,
          indicators: ['Visual analysis failed due to image format/decoder error']
        };
      }
      
      throw visionError;
    }
    
    let isFoil = false;
    let foilType: string | null = null;
    let confidence = 0;
    const indicators: string[] = [];
    let hasStrongFoilIndicators = false;
    let hasWhiteBorderReflection = false;

    const labels = result.labelAnnotations || [];
    console.log('Image labels found:', labels.map(l => `${l.description} (${l.score})`));
    
    const { texture: labelTexture, textureConfidence: labelTextureConf, labelIndicators } = detectTextureFromLabels(labels);
    indicators.push(...labelIndicators);
    let textureConfidence = labelTextureConf;
    if (labelTexture) {
      console.log(`Label-based texture detected: ${labelTexture} (confidence: ${labelTextureConf.toFixed(2)})`);
    }
    
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
      }
      
      if (description.includes('paper') || description.includes('text') || description.includes('white')) {
        indicators.push(`Non-foil material detected: ${description} (${score.toFixed(2)})`);
        confidence -= score * 0.2;
      }
    }

    const imageProps = result.imagePropertiesAnnotation;
    let detectedTexture: TextureType = labelTexture;
    
    if (imageProps?.dominantColors?.colors) {
      console.log('Analyzing color properties for foil detection...');
      
      const rawColors = imageProps.dominantColors.colors;
      let hasMetallicColors = false;
      let detectedColorTint: string | null = null;
      let totalColorVariance = 0;
      let tintedColorCount = 0;
      const detectedTints: { name: string; coverage: number }[] = [];
      
      const parsedColors: ColorEntry[] = [];
      
      for (const colorInfo of rawColors) {
        const color = colorInfo.color;
        if (!color) continue;
        
        const r = color.red || 0;
        const g = color.green || 0;
        const b = color.blue || 0;
        const pixelFraction = colorInfo.pixelFraction || 0;
        
        const brightness = (r + g + b) / 3;
        const saturation = Math.max(r, g, b) - Math.min(r, g, b);
        const maxChannel = Math.max(r, g, b);
        const colorName = classifyDominantColor(r, g, b);
        
        parsedColors.push({ r, g, b, brightness, saturation, pixelFraction, colorName });
        
        console.log(`Color: RGB(${r},${g},${b}) brightness=${brightness.toFixed(0)} saturation=${saturation} coverage=${(pixelFraction * 100).toFixed(1)}% name=${colorName || 'none'}`);
        
        if (brightness > 220 && saturation < 20 && pixelFraction > 0.2) {
          hasWhiteBorderReflection = true;
          indicators.push(`White border reflection detected: RGB(${r},${g},${b}) - ${(pixelFraction * 100).toFixed(1)}%`);
        }
        
        if (brightness > 60 && saturation > 30 && pixelFraction > 0.03) {
          hasMetallicColors = true;
          totalColorVariance += saturation * pixelFraction;
          indicators.push(`Metallic color detected: RGB(${r},${g},${b}) - saturation: ${saturation}, coverage: ${(pixelFraction * 100).toFixed(1)}%`);
        }
        
        if (saturation > 25 && pixelFraction > 0.03 && maxChannel > 70) {
          if (colorName) {
            tintedColorCount++;
            detectedTints.push({ name: colorName, coverage: pixelFraction });
            if (!detectedColorTint) {
              detectedColorTint = colorName;
            }
            indicators.push(`${colorName} tint detected: RGB(${r},${g},${b}) - ${(pixelFraction * 100).toFixed(1)}%`);
          }
        }
      }
      
      if (!detectedTexture) {
        const { texture: colorTexture, textureConfidence: colorTextureConf, textureIndicators } = detectTextureFromColors(parsedColors);
        indicators.push(...textureIndicators);
        if (colorTexture) {
          detectedTexture = colorTexture;
          textureConfidence = Math.max(textureConfidence, colorTextureConf);
          console.log(`Color-based texture detected: ${colorTexture} (confidence: ${colorTextureConf.toFixed(2)})`);
        }
      }
      
      const hasSimilarTintedRegions = detectedTints.length >= 2 && 
        detectedTints.some(t => t.name === detectedColorTint && t !== detectedTints[0]);
      const totalTintCoverage = detectedTints.reduce((sum, t) => sum + t.coverage, 0);
      
      console.log(`Tinted color regions: ${tintedColorCount}, similar tints: ${hasSimilarTintedRegions}, total tint coverage: ${(totalTintCoverage * 100).toFixed(1)}%`);
      console.log(`Detected texture: ${detectedTexture || 'none'}`);
      
      if (hasWhiteBorderReflection && !hasMetallicColors) {
        indicators.push('Rejected: Likely white border reflection without metallic characteristics');
        console.log('Rejected foil detection - appears to be white border reflection');
      } else if (hasMetallicColors && detectedColorTint && (hasSimilarTintedRegions || totalTintCoverage > 0.08)) {
        confidence += 0.4;
        isFoil = true;
        
        if (!foilType) {
          if (detectedTexture && textureConfidence >= 0.3) {
            foilType = `${detectedColorTint} ${detectedTexture} Foil`;
          } else {
            foilType = `${detectedColorTint} Foil`;
          }
          indicators.push(`Foil type assigned: ${foilType} (${tintedColorCount} tinted regions, texture: ${detectedTexture || 'standard'}, texture confidence: ${textureConfidence.toFixed(2)})`);
        }
        
        indicators.push(`Color variance score: ${totalColorVariance.toFixed(2)}, tint coverage: ${(totalTintCoverage * 100).toFixed(1)}%`);
      } else if (hasMetallicColors) {
        indicators.push(`Insufficient foil evidence: variance=${totalColorVariance.toFixed(2)}, tinted regions=${tintedColorCount}, coverage=${(totalTintCoverage * 100).toFixed(1)}%`);
      }
    }

    const hasColorBasedFoil = isFoil && foilType && foilType !== 'Foil';
    
    const MIN_TEXTURE_CONFIDENCE = 0.3;
    if (isFoil && foilType && detectedTexture && textureConfidence >= MIN_TEXTURE_CONFIDENCE &&
        !foilType.includes('Crackle') && !foilType.includes('Shimmer') && !foilType.includes('Ice')) {
      const colorPart = foilType.replace(/\s*Foil\s*$/i, '').trim();
      if (colorPart && colorPart !== 'Rainbow' && colorPart !== 'Chrome' && colorPart !== 'Silver' && colorPart !== 'Gold') {
        foilType = `${colorPart} ${detectedTexture} Foil`;
        indicators.push(`Texture refinement: updated to "${foilType}" (texture confidence: ${textureConfidence.toFixed(2)})`);
      }
    }
    
    if (isFoil && !hasStrongFoilIndicators && !hasColorBasedFoil) {
      console.log('REJECTING foil detection - no strong foil indicators or color-based detection found');
      isFoil = false;
      foilType = null;
      confidence = 0;
      indicators.push('REJECTED: No strong foil indicators (prismatic/chrome/metallic) or color-based detection');
    } else if (isFoil && hasWhiteBorderReflection && confidence < 0.7) {
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
      console.log('No strong foil indicators or color detection, rejecting');
      isFoil = false;
      confidence = 0;
      indicators.push('REJECTED: No strong foil indicators or color-based detection found');
    }

    console.log('=== VISUAL FOIL DETECTION RESULT ===');
    console.log(`Is Foil: ${isFoil}`);
    console.log(`Foil Type: ${foilType}`);
    console.log(`Texture: ${detectedTexture || 'none'}`);
    console.log(`Confidence: ${confidence.toFixed(2)}`);
    console.log(`Strong indicators present: ${hasStrongFoilIndicators}`);
    console.log(`White border reflection detected: ${hasWhiteBorderReflection}`);
    console.log(`Indicators: ${indicators.join('; ')}`);
    console.log('=== END VISUAL FOIL DETECTION ===');

    return {
      isFoil,
      foilType,
      confidence,
      indicators
    };

  } catch (error) {
    console.error('Error in visual foil detection:', error);
    console.error('Error details:', error instanceof Error ? error.message : error);
    console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    return {
      isFoil: false,
      foilType: null,
      confidence: 0,
      indicators: [`Error in visual analysis: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}
