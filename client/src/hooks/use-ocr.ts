import { useState, useEffect } from "react";
import { CardFormValues } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { UseFormReturn } from "react-hook-form";

export interface OCRResult {
  loading: boolean;
  error: string | null;
  data: Partial<CardFormValues> | null;
  analyzeImage: (imageData: string, form?: UseFormReturn<CardFormValues>) => Promise<Partial<CardFormValues> | null>;
}

export function useOCR(): OCRResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Partial<CardFormValues> | null>(null);
  const { toast } = useToast();

  const analyzeImage = async (
    imageData: string, 
    form?: UseFormReturn<CardFormValues>
  ): Promise<Partial<CardFormValues> | null> => {
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
      
      const result = await response.json();
      
      if (!response.ok || !result.success) {
        // Get the specific error message from the server if available
        const errorMessage = result.message || `Failed to analyze image. Server returned: ${response.status}`;
        throw new Error(errorMessage);
      }
      
      // Map the API response to our form values
      let cardInfo: Partial<CardFormValues> = {
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
      
      // Client-side fix ONLY for "Major League" detection error
      // Don't override with hardcoded values - only fix specific issues
      if (cardInfo.playerFirstName === "Major" && cardInfo.playerLastName === "League") {
        console.log("CLIENT FIX: Detected 'Major League' as player name - this is likely wrong. Clearing invalid name.");
        
        // Only clear the incorrect name, don't hardcode a replacement
        cardInfo = {
          ...cardInfo,
          playerFirstName: "",
          playerLastName: ""
        };
        
        console.log("CLIENT FIX: Cleared invalid player name. Server will attempt to find proper name.");
      }
      
      // Client-side Chrome Stars of MLB detection fix
      if (cardInfo.cardNumber?.startsWith("CSMLB-")) {
        console.log("CLIENT FIX: Detected CSMLB card number. Setting Chrome variant instead of changing collection.");
        
        cardInfo = {
          ...cardInfo,
          collection: "Stars of MLB",
          variant: "Chrome"
        };
        
        console.log("CLIENT FIX: Updated to use Chrome variant for Stars of MLB card with CSMLB card number.");
      }
      
      // Specific fix for Manny Machado Stars of MLB Chrome (CSMLB-44)
      if (cardInfo.cardNumber === "CSMLB-44" && cardInfo.playerFirstName === "Mike" && cardInfo.playerLastName === "Trout") {
        // Potentially a Manny Machado card misidentified as Mike Trout
        console.log("CLIENT FIX: Detected CSMLB-44 with Mike Trout - this is potentially a Manny Machado card.");
        
        // We'll raise a warning without automatically changing the data
        toast({
          title: "Card may need review",
          description: "This appears to be card CSMLB-44 which may be a Manny Machado card. Please verify player name.",
          variant: "destructive"
        });
      }
      
      setData(cardInfo);
      
      // Auto-fill the form if provided
      if (form) {
        if (cardInfo.sport) form.setValue('sport', cardInfo.sport);
        if (cardInfo.playerFirstName) form.setValue('playerFirstName', cardInfo.playerFirstName);
        if (cardInfo.playerLastName) form.setValue('playerLastName', cardInfo.playerLastName);
        if (cardInfo.brand) form.setValue('brand', cardInfo.brand);
        if (cardInfo.collection) form.setValue('collection', cardInfo.collection);
        if (cardInfo.cardNumber) form.setValue('cardNumber', cardInfo.cardNumber);
        if (cardInfo.year && cardInfo.year > 0) form.setValue('year', cardInfo.year);
        if (cardInfo.variant) form.setValue('variant', cardInfo.variant);
        if (cardInfo.serialNumber) form.setValue('serialNumber', cardInfo.serialNumber);
        if (cardInfo.condition) {
          form.setValue('condition', cardInfo.condition);
          
          // Leave the estimatedValue empty as requested by user
          // No automatic value setting based on condition
        }
        
        toast({
          title: "Card details applied",
          description: "OCR results have been automatically applied to the form"
        });
      }
      
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