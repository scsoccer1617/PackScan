import { useState } from "react";
import SimpleImageUploader from "@/components/SimpleImageUploader";
import { Button } from "@/components/ui/button";
import { ScanSearch } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOCR } from "@/hooks/use-ocr";
import { useToast } from "@/hooks/use-toast";
import OCRResults from "@/components/OCRResults";
import EbayPriceResults from "@/components/EbayPriceResults";
import ParallelPickerSheet, { ParallelOption } from "@/components/ParallelPickerSheet";
import { CardFormValues } from "@shared/schema";

// Resize + JPEG-compress a dataURL before upload.
// Caps the longer edge at maxPx and encodes at the given quality.
// Google Vision reads text accurately from 1200px images; sending full-res
// camera shots (often 3-8 MB) wastes upload time and Vision API bandwidth.
async function compressImage(dataUrl: string, maxPx = 1200, quality = 0.82): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { naturalWidth: w, naturalHeight: h } = img;
      if (w > maxPx || h > maxPx) {
        if (w >= h) { h = Math.round((h * maxPx) / w); w = maxPx; }
        else        { w = Math.round((w * maxPx) / h); h = maxPx; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', quality);
    };
    img.src = dataUrl;
  });
}

// Extract the primary search keyword from a detected parallel string.
// e.g. "Green Foil" → "Green",  "Gold Prizm" → "Gold",  "Rainbow" → "Rainbow"
function extractKeyword(foilType: string): string {
  const words = foilType.trim().split(/\s+/);
  // Return the first meaningful word (3+ chars)
  return words.find(w => w.length >= 3) ?? words[0] ?? "";
}

// Filter a list of DB parallel options to those matching the detected keyword
function filterByKeyword(options: ParallelOption[], foilType: string): ParallelOption[] {
  if (!foilType.trim()) return [];
  const keyword = extractKeyword(foilType).toLowerCase();
  if (!keyword) return [];
  return options.filter(o => o.variationOrParallel.toLowerCase().includes(keyword));
}

// Filter parallel options by serialization status.
// Non-numbered card → only show non-serialized parallels (no /NNN limit).
// Numbered card → only show serialized parallels.
function filterBySerialStatus(options: ParallelOption[], isNumbered: boolean): ParallelOption[] {
  if (isNumbered) {
    return options.filter(o => o.serialNumber && o.serialNumber.trim() !== "");
  }
  return options.filter(o => !o.serialNumber || o.serialNumber.trim() === "");
}

// Filter parallel options to those whose serial number limit exactly matches
// the detected serial number. Both sides are normalized by stripping slashes
// (e.g. "/499" and "499" both compare as "499").
function filterBySerialNumber(options: ParallelOption[], detectedSerial: string): ParallelOption[] {
  const normalized = detectedSerial.replace(/\//g, "").trim();
  if (!normalized) return [];
  return options.filter(o => {
    if (!o.serialNumber) return false;
    return o.serialNumber.replace(/\//g, "").trim() === normalized;
  });
}

// Fetch parallel options from the DB for a given card
async function fetchParallels(
  brand: string,
  year: number,
  collection?: string,
  set?: string
): Promise<ParallelOption[]> {
  const params = new URLSearchParams({ brand, year: year.toString() });
  if (collection) params.set("collection", collection);
  if (set) params.set("set", set);
  const resp = await fetch(`/api/card-variations/options?${params}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  const raw: { variationOrParallel: string; serialNumber: string | null }[] = data.options || [];
  // Deduplicate by name
  const seen = new Set<string>();
  const unique: ParallelOption[] = [];
  for (const o of raw) {
    if (!seen.has(o.variationOrParallel)) {
      seen.add(o.variationOrParallel);
      unique.push({ variationOrParallel: o.variationOrParallel, serialNumber: o.serialNumber });
    }
  }
  return unique;
}

export default function PriceLookup() {
  const [frontImage, setFrontImage] = useState<string>("");
  const [backImage, setBackImage] = useState<string>("");
  const [showOCRResults, setShowOCRResults] = useState<boolean>(false);
  const [cardData, setCardData] = useState<Partial<CardFormValues> | null>(null);
  const [showPriceResults, setShowPriceResults] = useState<boolean>(false);
  const [showParallelPicker, setShowParallelPicker] = useState<boolean>(false);
  const [parallelOptions, setParallelOptions] = useState<ParallelOption[]>([]);
  const [detectedKeyword, setDetectedKeyword] = useState<string>("");
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const { toast } = useToast();
  
  const { loading: ocrLoading, error: ocrError, data: ocrData } = useOCR();

  // Called after scan completes — decides whether to show picker or go straight to eBay
  const processCardData = async (data: Partial<CardFormValues>) => {
    setCardData(data);

    const detected = data.foilType?.trim() || "";
    const detectedSerial = data.serialNumber?.trim() || "";

    // No parallel detected — go straight to eBay as a base card
    if (!detected) {
      setShowPriceResults(true);
      return;
    }

    // Fetch DB parallels and filter to matching variants
    if (data.brand && data.year) {
      const allOptions = await fetchParallels(data.brand, data.year as number, data.collection, data.set);

      // STEP 1 — Serial number match (highest confidence).
      // If we have an exact serial number (e.g. /499), look for DB parallels that
      // carry that exact limit. Only one parallel should have /499 for a given set,
      // so this almost always resolves unambiguously without prompting the user.
      if (detectedSerial) {
        const bySerial = filterBySerialNumber(allOptions, detectedSerial);
        if (bySerial.length === 1) {
          // Unambiguous serial number match — auto-select, no prompt needed
          const match = bySerial[0];
          setCardData({ ...data, foilType: match.variationOrParallel, serialNumber: detectedSerial, isNumbered: true });
          setShowPriceResults(true);
          return;
        }
        if (bySerial.length >= 2) {
          // Rare: multiple parallels share the same serial number limit — ask the user
          setParallelOptions(bySerial);
          setDetectedKeyword(extractKeyword(detected));
          setShowParallelPicker(true);
          return;
        }
        // 0 serial matches — fall through to keyword matching below
      }

      // STEP 2 — Keyword + serialization-status match.
      // Used when no serial number was detected, or the serial matched nothing in the DB.
      // Only prompt if OCR found a color/keyword AND multiple parallels share it.
      const byKeyword = filterByKeyword(allOptions, detected);
      const filtered = filterBySerialStatus(byKeyword, !!data.isNumbered);

      if (filtered.length === 1) {
        // Exactly one keyword match — silently use it
        const match = filtered[0];
        const updated: Partial<CardFormValues> = { ...data, foilType: match.variationOrParallel };
        if (match.serialNumber) {
          const limit = match.serialNumber.replace(/\//g, "");
          updated.serialNumber = `/${limit}`;
          updated.isNumbered = true;
        }
        setCardData(updated);
        setShowPriceResults(true);
        return;
      }

      if (filtered.length >= 2) {
        // Multiple parallels match the same color/keyword — ask the user to disambiguate
        setParallelOptions(filtered);
        setDetectedKeyword(extractKeyword(detected));
        setShowParallelPicker(true);
        return;
      }
    }

    // 0 DB matches — use the OCR-detected value as-is and go straight to eBay
    setShowPriceResults(true);
  };

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
      // Compress both images in parallel before upload — reduces size 5-10x
      // (camera images are often 1.5-3 MB; 1200px JPEG is plenty for OCR)
      const [backBlob, frontBlob] = await Promise.all([
        compressImage(backImage),
        frontImage ? compressImage(frontImage) : Promise.resolve(null),
      ]);

      const formData = new FormData();
      formData.append('backImage', backBlob, 'back.jpg');
      if (frontBlob) formData.append('frontImage', frontBlob, 'front.jpg');

      const response = await fetch('/api/analyze-card-dual-images', {
        method: 'POST',
        body: formData,
      });
      
      if (!response.ok) throw new Error('Analysis failed');
      
      const result = await response.json();
      
      if (result.success && result.data) {
        await processCardData(result.data);
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

  const handleParallelConfirm = (foilType: string, serialNumber?: string) => {
    setCardData(prev => {
      if (!prev) return prev;
      const updated: Partial<CardFormValues> = { ...prev, foilType };
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
  
  // Legacy path: OCR hook results (not used by main scan flow)
  const handleApplyOCRResults = (data: Partial<CardFormValues>) => {
    setCardData(data);
    setShowOCRResults(false);
    setShowPriceResults(true);
  };
  
  const handleReset = () => {
    setFrontImage("");
    setBackImage("");
    setShowOCRResults(false);
    setShowPriceResults(false);
    setShowParallelPicker(false);
    setParallelOptions([]);
    setCardData(null);
  };

  const cardDescription = cardData
    ? [
        cardData.year,
        cardData.brand,
        cardData.collection,
        cardData.cardNumber ? `#${cardData.cardNumber}` : undefined,
        [cardData.playerFirstName, cardData.playerLastName].filter(Boolean).join(" "),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <div className="p-4 space-y-6">
      {!showOCRResults && !showPriceResults && !showParallelPicker && (
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
      )}

      {/* Legacy OCR hook path */}
      {showOCRResults && ocrData && (
        <OCRResults 
          loading={ocrLoading}
          error={ocrError}
          data={ocrData}
          onApply={handleApplyOCRResults}
          onCancel={() => setShowOCRResults(false)}
        />
      )}

      {/* Parallel picker — only shown when 2+ matching variants exist */}
      {cardData && (
        <ParallelPickerSheet
          open={showParallelPicker}
          detectedLabel={detectedKeyword}
          cardDescription={cardDescription}
          options={parallelOptions}
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
