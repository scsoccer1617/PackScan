import OpenAI from "openai";

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Analyzes a sports card image and extracts relevant information
 * @param base64Image - Base64 encoded image data
 * @returns Object containing extracted card information
 */
export async function analyzeSportsCardImage(base64Image: string): Promise<any> {
  try {
    const prompt = `
      You are a sports card expert. Analyze this card image and extract the following information:
      - Sport type (baseball, basketball, football, hockey, etc.)
      - Player first name
      - Player last name
      - Brand name (Topps, Upper Deck, Panini, Bowman, etc.)
      - Collection name/set
      - Card number
      - Year
      - Any variant or special edition info
      - Serial number (if visible)
      - Condition assessment if possible (but don't guess if not obvious)
      
      Return the data in JSON format with these fields:
      {
        "sport": string,
        "playerFirstName": string,
        "playerLastName": string,
        "brand": string,
        "collection": string,
        "cardNumber": string,
        "year": number,
        "variant": string,
        "serialNumber": string,
        "condition": string,
        "notes": string
      }
      
      Use "unknown" or empty string for fields you cannot identify. For the year, use -1 if unknown.
      Include in "notes" any additional observations about the card that might be relevant.
    `;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1000,
    });

    const result = JSON.parse(response.choices[0].message.content || "{}");
    
    // Convert year from string to number if possible
    if (result.year && result.year !== -1) {
      result.year = parseInt(result.year, 10);
      // If parsing fails, set to -1
      if (isNaN(result.year)) {
        result.year = -1;
      }
    }
    
    return result;
  } catch (error) {
    console.error("Error analyzing card image:", error);
    
    // Check for rate limit errors
    if (typeof error === 'object' && error !== null) {
      const err = error as any;
      if (err.status === 429 || (err.error && err.error.type === 'insufficient_quota')) {
        throw new Error(`OpenAI API quota exceeded. Please try again later or contact the administrator to update the API key.`);
      }
      
      // Handle other types of errors with message
      if ('message' in err) {
        throw new Error(`Failed to analyze card image: ${err.message}`);
      }
    }
    
    // Fallback error message
    throw new Error(`Failed to analyze card image due to an unknown error.`);
  }
}