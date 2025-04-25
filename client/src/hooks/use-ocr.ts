import { useState } from "react";
import { CardFormValues } from "@shared/schema";
import { analyzeCardImage } from "../lib/tesseractOcr";

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
      console.log("Starting client-side OCR analysis with Tesseract.js...");
      
      // Use Tesseract.js for client-side OCR processing
      const cardInfo = await analyzeCardImage(imageData);
      
      // Convert to the expected format
      const formattedCardInfo: Partial<CardFormValues> = {
        sport: cardInfo.sport || "",
        playerFirstName: cardInfo.playerFirstName || "",
        playerLastName: cardInfo.playerLastName || "",
        brand: cardInfo.brand || "",
        collection: cardInfo.collection || "",
        cardNumber: cardInfo.cardNumber || "",
        year: cardInfo.year || new Date().getFullYear(),
        variant: cardInfo.variant || "",
        serialNumber: cardInfo.serialNumber || "",
        condition: cardInfo.condition || "PSA 9",
      };
      
      setData(formattedCardInfo);
      setLoading(false);
      return formattedCardInfo;
      
    } catch (err) {
      let errorMessage = err instanceof Error ? err.message : 'Unknown error during image analysis';
      console.error("OCR Analysis error:", errorMessage);
      setError(errorMessage);
      setLoading(false);
      return null;
    }
  };

  return { loading, error, data, analyzeImage };
}