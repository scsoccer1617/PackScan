import { useState } from "react";
import { CardFormValues } from "@shared/schema";
import { analyzeCardImage } from "@/lib/tesseractOcr";

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
      // Use local Tesseract.js for image analysis instead of OpenAI API
      const cardInfo = await analyzeCardImage(imageData);
      
      setData(cardInfo);
      setLoading(false);
      return cardInfo;
      
    } catch (err) {
      let errorMessage = err instanceof Error ? err.message : 'Unknown error during image analysis';
      setError(errorMessage);
      setLoading(false);
      return null;
    }
  };

  return { loading, error, data, analyzeImage };
}