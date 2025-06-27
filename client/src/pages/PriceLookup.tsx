import { useState } from "react";
import SimpleImageUploader from "@/components/SimpleImageUploader";
import { Button } from "@/components/ui/button";
import { ScanSearch } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOCR } from "@/hooks/use-ocr";
import { useToast } from "@/hooks/use-toast";
import OCRResults from "@/components/OCRResults";
import EbayPriceResults from "@/components/EbayPriceResults";
import { CardFormValues } from "@shared/schema";

export default function PriceLookup() {
  const [frontImage, setFrontImage] = useState<string>("");
  const [backImage, setBackImage] = useState<string>("");
  const [showOCRResults, setShowOCRResults] = useState<boolean>(false);
  const [cardData, setCardData] = useState<Partial<CardFormValues> | null>(null);
  const [showPriceResults, setShowPriceResults] = useState<boolean>(false);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const { toast } = useToast();
  
  // OCR hook for analyzing card images
  const { loading: ocrLoading, error: ocrError, data: ocrData, analyzeImage } = useOCR();
  
  // Handle combined OCR + eBay price analysis
  const handleAnalyzeRequest = async () => {
    if (!backImage) {
      toast({
        title: "Back Image Required",
        description: "Please upload the BACK of the card for analysis. Card numbers and details are typically found on the back.",
        variant: "destructive",
      });
      return;
    }
    
    setAnalyzing(true);
    try {
      // Use the new combined endpoint for OCR + price lookup
      const response = await fetch('/api/analyze-card-with-prices', {
        method: 'POST',
        body: (() => {
          const formData = new FormData();
          
          // Convert base64 image to file for upload
          const byteCharacters = atob(backImage.split(',')[1]);
          const byteNumbers = new Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
          }
          const byteArray = new Uint8Array(byteNumbers);
          const blob = new Blob([byteArray], { type: 'image/jpeg' });
          
          formData.append('image', blob, 'card.jpg');
          return formData;
        })()
      });
      
      if (!response.ok) {
        throw new Error('Analysis failed');
      }
      
      const result = await response.json();
      
      if (result.success && result.data) {
        setCardData(result.data);
        setShowOCRResults(true);
        setShowPriceResults(true); // Show both OCR and price results
        
        toast({
          title: "Analysis Complete",
          description: `Found ${result.data.ebayResults?.length || 0} recent sales with average value of $${result.data.averageValue || 0}`,
        });
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
    setCardData(null);
  };

  return (
    <div className="p-4 space-y-6">
      {!showOCRResults && !showPriceResults && (
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
                disabled={ocrLoading || !backImage}
                className="w-full"
                size="lg"
              >
                {ocrLoading ? (
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
      {/* OCR Results */}
      {showOCRResults && ocrData && (
        <OCRResults 
          loading={ocrLoading}
          error={ocrError}
          data={ocrData}
          onApply={handleApplyOCRResults}
          onCancel={() => setShowOCRResults(false)}
        />
      )}
      {/* Price Results */}
      {showPriceResults && cardData && (
        <div className="space-y-4">
          <EbayPriceResults cardData={cardData} />
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