import vision from '@google-cloud/vision';

interface FoilDetectionResult {
  isFoil: boolean;
  foilType: string | null;
  confidence: number;
  indicators: string[];
}

/**
 * Detect foil characteristics using visual analysis of the card image
 * This analyzes the actual visual properties like reflectivity, color patterns, etc.
 */
export async function detectFoilFromImage(base64Image: string): Promise<FoilDetectionResult> {
  console.log('=== VISUAL FOIL DETECTION STARTING ===');
  
  try {
    const client = new vision.ImageAnnotatorClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
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

    const [result] = await client.annotateImage(request);
    
    let isFoil = false;
    let foilType: string | null = null;
    let confidence = 0;
    const indicators: string[] = [];

    // Analyze labels for foil-related characteristics
    const labels = result.labelAnnotations || [];
    console.log('Image labels found:', labels.map(l => `${l.description} (${l.score})`));
    
    let hasStrongFoilIndicators = false;
    
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
      let hasGreenTint = false;
      let hasWhiteBorderReflection = false;
      let totalColorVariance = 0;
      
      for (const colorInfo of colors) {
        const color = colorInfo.color;
        if (!color) continue;
        
        const r = color.red || 0;
        const g = color.green || 0;
        const b = color.blue || 0;
        const pixelFraction = colorInfo.pixelFraction || 0;
        
        const brightness = (r + g + b) / 3;
        const saturation = Math.max(r, g, b) - Math.min(r, g, b);
        
        // Check for white border reflection (high brightness, low saturation, significant coverage)
        if (brightness > 220 && saturation < 20 && pixelFraction > 0.2) {
          hasWhiteBorderReflection = true;
          indicators.push(`White border reflection detected: RGB(${r},${g},${b}) - ${(pixelFraction * 100).toFixed(1)}%`);
        }
        
        // True metallic surfaces have more color variety and prismatic effects
        // They should have moderate to high saturation, not just brightness
        if (brightness > 160 && saturation > 50 && pixelFraction > 0.08) {
          hasMetallicColors = true;
          totalColorVariance += saturation * pixelFraction;
          indicators.push(`Metallic color detected: RGB(${r},${g},${b}) - saturation: ${saturation}, coverage: ${(pixelFraction * 100).toFixed(1)}%`);
        }
        
        // Check for green-tinted metallic (common in foil cards)
        // Require higher saturation to avoid false positives from white balance issues
        if (g > r + 20 && g > b + 20 && g > 120 && saturation > 40 && pixelFraction > 0.12) {
          hasGreenTint = true;
          indicators.push(`Green metallic tint detected: ${(pixelFraction * 100).toFixed(1)}%, saturation: ${saturation}`);
        }
      }
      
      // Reject foil detection if it's likely just white border reflection
      if (hasWhiteBorderReflection && !hasMetallicColors) {
        indicators.push('Rejected: Likely white border reflection without metallic characteristics');
        console.log('Rejected foil detection - appears to be white border reflection');
      } else if (hasMetallicColors && totalColorVariance > 3.0) {
        // Only consider it foil if there's sufficient color variance indicating prismatic effects
        confidence += 0.4;
        isFoil = true;
        
        if (hasGreenTint && !foilType) {
          foilType = 'Green Foil';
          indicators.push('Green foil type assigned based on color analysis');
        }
        
        indicators.push(`Color variance score: ${totalColorVariance.toFixed(2)} (threshold: 3.0)`);
      } else if (hasMetallicColors) {
        indicators.push(`Insufficient color variance for foil: ${totalColorVariance.toFixed(2)} (threshold: 3.0)`);
      }
    }

    // Cap confidence at 1.0
    confidence = Math.min(confidence, 1.0);
    
    // If we detected foil characteristics but no specific type, assign a generic type
    if (isFoil && !foilType) {
      foilType = 'Foil';
    }

    console.log('=== VISUAL FOIL DETECTION RESULT ===');
    console.log(`Is Foil: ${isFoil}`);
    console.log(`Foil Type: ${foilType}`);
    console.log(`Confidence: ${confidence.toFixed(2)}`);
    console.log(`Indicators: ${indicators.join('; ')}`);

    return {
      isFoil,
      foilType,
      confidence,
      indicators
    };

  } catch (error) {
    console.error('Error in visual foil detection:', error);
    return {
      isFoil: false,
      foilType: null,
      confidence: 0,
      indicators: ['Error in visual analysis']
    };
  }
}