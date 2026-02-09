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

/**
 * Detect foil characteristics using visual analysis of the card image
 * This analyzes the actual visual properties like reflectivity, color patterns, etc.
 */
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
        { type: 'LABEL_DETECTION' as const, maxResults: 20 },
        { type: 'IMAGE_PROPERTIES' as const }
      ],
    };

    let result;
    try {
      [result] = await client.annotateImage(request);
    } catch (visionError: any) {
      // Handle decoder errors and other Google Vision API issues
      console.log('Google Vision API error:', visionError.message || visionError);
      
      if (visionError.message?.includes('DECODER') || visionError.message?.includes('unsupported')) {
        console.log('Image decoder error - likely image format issue, falling back to basic detection');
        // Return conservative result when visual analysis fails
        return {
          isFoil: false,
          foilType: null,
          confidence: 0,
          indicators: ['Visual analysis failed due to image format/decoder error']
        };
      }
      
      throw visionError; // Re-throw if it's not a decoder error
    }
    
    let isFoil = false;
    let foilType: string | null = null;
    let confidence = 0;
    const indicators: string[] = [];
    let hasStrongFoilIndicators = false;
    let hasWhiteBorderReflection = false;

    // Analyze labels for foil-related characteristics
    const labels = result.labelAnnotations || [];
    console.log('Image labels found:', labels.map(l => `${l.description} (${l.score})`));
    
    for (const label of labels) {
      const description = label.description?.toLowerCase() || '';
      const score = label.score || 0;
      
      // Strong foil indicators (high confidence)
      if (description.includes('rainbow') || description.includes('prismatic') || description.includes('iridescent')) {
        indicators.push(`Strong prismatic effect detected (${score.toFixed(2)})`);
        confidence += score * 0.7;
        isFoil = true;
        hasStrongFoilIndicators = true;
        foilType = 'Rainbow Foil';
      }
      
      // Chrome/metal detection with higher threshold
      if ((description.includes('chrome') || description.includes('metallic')) && score > 0.6) {
        indicators.push(`Chrome/metallic surface detected (${score.toFixed(2)})`);
        confidence += score * 0.6;
        isFoil = true;
        hasStrongFoilIndicators = true;
        if (!foilType) foilType = 'Chrome';
      }
      
      // Color-specific metallic detection
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
      
      // Weaker indicators - only count if score is high
      if ((description.includes('reflect') || description.includes('shiny') || description.includes('gloss')) && score > 0.7) {
        indicators.push(`Reflective surface detected (${score.toFixed(2)})`);
        confidence += score * 0.3;
        // Don't set isFoil = true here, let other indicators decide
      }
      
      // Exclude common false positives
      if (description.includes('paper') || description.includes('text') || description.includes('white')) {
        indicators.push(`Non-foil material detected: ${description} (${score.toFixed(2)})`);
        // Reduce confidence if we detect paper/text materials
        confidence -= score * 0.2;
      }
    }

    // Analyze color properties for foil characteristics
    const imageProps = result.imagePropertiesAnnotation;
    if (imageProps?.dominantColors?.colors) {
      console.log('Analyzing color properties for foil detection...');
      
      const colors = imageProps.dominantColors.colors;
      let hasMetallicColors = false;
      let detectedColorTint: string | null = null;
      let totalColorVariance = 0;
      let tintedColorCount = 0;
      const detectedTints: { name: string; coverage: number }[] = [];
      
      for (const colorInfo of colors) {
        const color = colorInfo.color;
        if (!color) continue;
        
        const r = color.red || 0;
        const g = color.green || 0;
        const b = color.blue || 0;
        const pixelFraction = colorInfo.pixelFraction || 0;
        
        const brightness = (r + g + b) / 3;
        const saturation = Math.max(r, g, b) - Math.min(r, g, b);
        const maxChannel = Math.max(r, g, b);
        
        console.log(`Color: RGB(${r},${g},${b}) brightness=${brightness.toFixed(0)} saturation=${saturation} coverage=${(pixelFraction * 100).toFixed(1)}%`);
        
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
          const colorName = classifyDominantColor(r, g, b);
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
      
      const hasSimilarTintedRegions = detectedTints.length >= 2 && 
        detectedTints.some(t => t.name === detectedColorTint && t !== detectedTints[0]);
      const totalTintCoverage = detectedTints.reduce((sum, t) => sum + t.coverage, 0);
      
      console.log(`Tinted color regions: ${tintedColorCount}, similar tints: ${hasSimilarTintedRegions}, total tint coverage: ${(totalTintCoverage * 100).toFixed(1)}%`);
      
      if (hasWhiteBorderReflection && !hasMetallicColors) {
        indicators.push('Rejected: Likely white border reflection without metallic characteristics');
        console.log('Rejected foil detection - appears to be white border reflection');
      } else if (hasMetallicColors && detectedColorTint && (hasSimilarTintedRegions || totalTintCoverage > 0.08)) {
        confidence += 0.4;
        isFoil = true;
        
        if (!foilType) {
          foilType = `${detectedColorTint} Foil`;
          indicators.push(`${detectedColorTint} foil type assigned based on color analysis (${tintedColorCount} tinted regions)`);
        }
        
        indicators.push(`Color variance score: ${totalColorVariance.toFixed(2)}, tint coverage: ${(totalTintCoverage * 100).toFixed(1)}%`);
      } else if (hasMetallicColors) {
        indicators.push(`Insufficient foil evidence: variance=${totalColorVariance.toFixed(2)}, tinted regions=${tintedColorCount}, coverage=${(totalTintCoverage * 100).toFixed(1)}%`);
      }
    }

    const hasColorBasedFoil = isFoil && foilType && foilType !== 'Foil';
    
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
    
    // Cap confidence at 1.0
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