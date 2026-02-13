import { useState } from "react";
import SimpleImageUploader from "@/components/SimpleImageUploader";
import { Button } from "@/components/ui/button";
import { ScanSearch } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import OCRResults from "@/components/OCRResults";
import EbayPriceResults from "@/components/EbayPriceResults";
import { CardFormValues } from "@shared/schema";

export default function PriceLookup() {
  const [frontImage, setFrontImage] = useState<string>("");
  const [backImage, setBackImage] = useState<string>("");
  const [cardData, setCardData] = useState<Partial<CardFormValues> | null>(null);
  const [showPriceResults, setShowPriceResults] = useState<boolean>(false);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const { toast } = useToast();

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
    setShowPriceResults(false);
    setCardData(null);
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

  const handleApplyOCRResults = (data: Partial<CardFormValues>) => {
    setCardData(data);
    setShowPriceResults(true);

    toast({
      title: "Card Analyzed",
      description: "Searching eBay for recent sold prices...",
    });
  };

  const handleReset = () => {
    setFrontImage("");
    setBackImage("");
    setShowPriceResults(false);
    setCardData(null);
  };

  return (
    <div className="p-4 space-y-6">
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

          {!showPriceResults && (
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
          )}
        </CardContent>
      </Card>

      {cardData && !showPriceResults && (
        <OCRResults
          loading={analyzing}
          error={null}
          data={cardData}
          onApply={handleApplyOCRResults}
          onCancel={() => setCardData(null)}
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
