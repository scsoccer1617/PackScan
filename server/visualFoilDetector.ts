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
    
    for (const label of labels) {
      const description = label.description?.toLowerCase() || '';
      const score = label.score || 0;
      
      // Look for metallic, reflective, or shiny characteristics
      if (description.includes('metal') || description.includes('metallic')) {
        indicators.push(`Metallic surface detected (${score.toFixed(2)})`);
        confidence += score * 0.4;
        isFoil = true;
      }
      
      if (description.includes('reflect') || description.includes('shiny') || description.includes('gloss')) {
        indicators.push(`Reflective surface detected (${score.toFixed(2)})`);
        confidence += score * 0.5;
        isFoil = true;
      }
      
      if (description.includes('rainbow') || description.includes('prismatic') || description.includes('iridescent')) {
        indicators.push(`Prismatic effect detected (${score.toFixed(2)})`);
        confidence += score * 0.6;
        isFoil = true;
        foilType = 'Rainbow Foil';
      }
      
      if (description.includes('chrome') || description.includes('silver')) {
        indicators.push(`Chrome/silver surface detected (${score.toFixed(2)})`);
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
    }

    // Analyze color properties for foil characteristics
    const imageProps = result.imagePropertiesAnnotation;
    if (imageProps?.dominantColors?.colors) {
      console.log('Analyzing color properties for foil detection...');
      
      const colors = imageProps.dominantColors.colors;
      let hasMetallicColors = false;
      let hasGreenTint = false;
      
      for (const colorInfo of colors) {
        const color = colorInfo.color;
        if (!color) continue;
        
        const r = color.red || 0;
        const g = color.green || 0;
        const b = color.blue || 0;
        const pixelFraction = colorInfo.pixelFraction || 0;
        
        // Check for metallic color characteristics (high saturation with reflective qualities)
        const brightness = (r + g + b) / 3;
        const saturation = Math.max(r, g, b) - Math.min(r, g, b);
        
        // Metallic surfaces often have high brightness and moderate saturation
        if (brightness > 180 && saturation > 30 && pixelFraction > 0.1) {
          hasMetallicColors = true;
          indicators.push(`Metallic color detected: RGB(${r},${g},${b}) - ${(pixelFraction * 100).toFixed(1)}%`);
        }
        
        // Check for green-tinted metallic (common in foil cards)
        if (g > r && g > b && g > 150 && pixelFraction > 0.15) {
          hasGreenTint = true;
          indicators.push(`Green metallic tint detected: ${(pixelFraction * 100).toFixed(1)}%`);
        }
      }
      
      if (hasMetallicColors) {
        confidence += 0.3;
        isFoil = true;
        
        if (hasGreenTint && !foilType) {
          foilType = 'Green Foil';
          indicators.push('Green foil type assigned based on color analysis');
        }
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