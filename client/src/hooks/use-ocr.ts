import { useState } from "react";
import { CardFormValues } from "@shared/schema";

export interface OCRResult {
  loading: boolean;
  error: string | null;
  data: Partial<CardFormValues> | null;
  analyzeImage: (imageData: string) => Promise<Partial<CardFormValues> | null>;
}

export function useOCR(): OCRResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Partial<CardFormValues> | null>(null);

  const analyzeImage = async (imageData: string): Promise<Partial<CardFormValues> | null> => {
    setLoading(true);
    setError(null);
    
    try {
      // Extract base64 data from dataURL
      const base64Data = imageData.split(',')[1];
      
      // Create a Blob from the base64 data
      const blob = await fetch(imageData).then(r => r.blob());
      
      // Create FormData and append the image
      const formData = new FormData();
      formData.append('image', blob, 'card.jpg');
      
      // Send to API for analysis
      const response = await fetch('/api/analyze-card-image', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      
      if (!response.ok) {
        throw new Error('Failed to analyze image. Server returned: ' + response.status);
      }
      
      const result = await response.json();
      
      if (!result.success) {
        throw new Error(result.message || 'Analysis failed');
      }
      
      // Map the API response to our form values
      const cardInfo: Partial<CardFormValues> = {
        sport: result.data.sport || "",
        playerFirstName: result.data.playerFirstName || "",
        playerLastName: result.data.playerLastName || "",
        brand: result.data.brand || "",
        collection: result.data.collection || "",
        cardNumber: result.data.cardNumber || "",
        year: result.data.year > 0 ? result.data.year : new Date().getFullYear(),
        variant: result.data.variant || "",
        serialNumber: result.data.serialNumber || "",
        condition: result.data.condition || "",
      };
      
      setData(cardInfo);
      setLoading(false);
      return cardInfo;
      
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error during image analysis';
      setError(errorMessage);
      setLoading(false);
      return null;
    }
  };

  return { loading, error, data, analyzeImage };
}