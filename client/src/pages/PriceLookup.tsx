import { useState } from "react";
import SimpleImageUploader from "@/components/SimpleImageUploader";
import { Button } from "@/components/ui/button";
import { ScanSearch } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOCR } from "@/hooks/use-ocr";
import { useToast } from "@/hooks/use-toast";
import OCRResults from "@/components/OCRResults";
import EbayPriceResults from "@/components/EbayPriceResults";
import ParallelPickerSheet from "@/components/ParallelPickerSheet";
import { CardFormValues } from "@shared/schema";

export default function PriceLookup() {
  const [frontImage, setFrontImage] = useState<string>("");
  const [backImage, setBackImage] = useState<string>("");
  const [showOCRResults, setShowOCRResults] = useState<boolean>(false);
  const [cardData, setCardData] = useState<Partial<CardFormValues> | null>(null);
  const [showPriceResults, setShowPriceResults] = useState<boolean>(false);
  const [showParallelPicker, setShowParallelPicker] = useState<boolean>(false);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const { toast } = useToast();
  
  // OCR hook for analyzing card images
  const { loading: ocrLoading, error: ocrError, data: ocrData, analyzeImage } = useOCR();
  
  // Handle combined OCR + eBay price analysis
  const handleAnalyzeRequest = async () => {
    if (!backImage) {
      toast({
        title: "Back Image Required",
        description: "Please upload the BACK of the card for detailed card information.",
        variant: "destructive",
      });
      return;
    }
    
    setAnalyzing(true);
    try {
      const response = await fetch('/api/analyze-card-dual-images', {
        method: 'POST',
        body: (() => {
          const formData = new FormData();
          
          const backByteCharacters = atob(backImage.split(',')[1]);
          const backByteNumbers = new Array(backByteCharacters.length);
          for (let i = 0; i < backByteCharacters.length; i++) {
            backByteNumbers[i] = backByteCharacters.charCodeAt(i);
          }
          const backByteArray = new Uint8Array(backByteNumbers);
          const backBlob = new Blob([backByteArray], { type: 'image/jpeg' });
          formData.append('backImage', backBlob, 'back.jpg');
          
          if (frontImage) {
            const frontByteCharacters = atob(frontImage.split(',')[1]);
            const frontByteNumbers = new Array(frontByteCharacters.length);
            for (let i = 0; i < frontByteCharacters.length; i++) {
              frontByteNumbers[i] = frontByteCharacters.charCodeAt(i);
            }
            const frontByteArray = new Uint8Array(frontByteNumbers);
            const frontBlob = new Blob([frontByteArray], { type: 'image/jpeg' });
            formData.append('frontImage', frontBlob, 'front.jpg');
          }
          
          return formData;
        })()
      });
      
      if (!response.ok) {
        throw new Error('Analysis failed');
      }
      
      const result = await response.json();
      
      if (result.success && result.data) {
        setCardData(result.data);
        // Show parallel picker before running eBay search
        setShowParallelPicker(true);
      } else {
        throw new Error(result.message || 'Analysis failed');
      }
    } catch (error) {
      console.error('Analysis error:', error);
      toast({
        title: "Analysis Failed",
        description: "Could not analyze the card image. Please try again.",
        variant: "destructive",
      });
    } finally {
      setAnalyzing(false);
    }
  };

  // Called when user confirms their parallel selection in the sheet
  const handleParallelConfirm = (foilType: string, serialNumber?: string) => {
    setCardData(prev => {
      if (!prev) return prev;
      const updated: Partial<CardFormValues> = { ...prev, foilType: foilType || "" };
      // If the user picked a numbered parallel and no serial was detected yet, apply the serial limit
      if (serialNumber) {
        const limit = serialNumber.replace(/\//g, "");
        updated.serialNumber = `/${limit}`;
        updated.isNumbered = true;
      }
      return updated;
    });
    setShowParallelPicker(false);
    setShowPriceResults(true);
  };
  
  // Apply OCR results and show price lookup
  const handleApplyOCRResults = (data: Partial<CardFormValues>) => {
    setCardData(data);
    setShowOCRResults(false);
    setShowPriceResults(true);
    
    toast({
      title: "Card Analyzed",
      description: "Searching eBay for recent sold prices...",
    });
  };
  
  // Reset to start over
  const handleReset = () => {
    setFrontImage("");
    setBackImage("");
    setShowOCRResults(false);
    setShowPriceResults(false);
    setShowParallelPicker(false);
    setCardData(null);
  };

  return (
    <div className="p-4 space-y-6">
      {!showOCRResults && !showPriceResults && !showParallelPicker && (
        <>
          {/* Image Upload Section */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ScanSearch className="h-5 w-5" />
                Upload Card Images
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <h3 className="font-medium mb-2">Front of Card</h3>
                  <SimpleImageUploader
                    onImageCaptured={setFrontImage}
                    label="Upload front image"
                    existingImage={frontImage}
                  />
                </div>
                <div>
                  <h3 className="font-medium mb-2">Back of Card</h3>
                  <SimpleImageUploader
                    onImageCaptured={setBackImage}
                    label="Upload back image"
                    existingImage={backImage}
                  />
                </div>
              </div>
              
              <Button 
                onClick={handleAnalyzeRequest}
                disabled={analyzing || !backImage}
                className="w-full"
                size="lg"
              >
                {analyzing ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                    Analyzing Card...
                  </>
                ) : (
                  <>
                    <ScanSearch className="h-4 w-4 mr-2" />
                    Analyze Card & Get Prices
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {/* OCR Results (when triggered via OCR hook — legacy path) */}
      {showOCRResults && ocrData && (
        <OCRResults 
          loading={ocrLoading}
          error={ocrError}
          data={ocrData}
          onApply={handleApplyOCRResults}
          onCancel={() => setShowOCRResults(false)}
        />
      )}

      {/* Parallel picker sheet — appears after scan, before eBay search */}
      {cardData && (
        <ParallelPickerSheet
          open={showParallelPicker}
          cardData={cardData}
          onConfirm={handleParallelConfirm}
        />
      )}

      {showPriceResults && cardData && (
        <div className="space-y-4">
          <EbayPriceResults 
            cardData={cardData} 
            frontImage={frontImage}
            backImage={backImage}
            onCardDataUpdate={(updatedData) => {
              setCardData(updatedData);
            }}
          />
          <Button 
            onClick={handleReset}
            variant="outline"
            className="w-full"
          >
            Look Up Another Card
          </Button>
        </div>
      )}
    </div>
  );
}
