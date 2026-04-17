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
  const wordBoundary = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return options.filter(o => wordBoundary.test(o.variationOrParallel));
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

// Merge a "primary" list (keyword-matched parallels) with a broader "all" list
// (everything else with the same serial-status), keeping primary entries first
// and deduplicating. This is used when showing the picker so the user can find
// the correct parallel even if the visual foil detector mis-classified the
// color (e.g. detected "Aqua Foil" when the card is actually a Sandglitter).
function mergePreferringPrimary(primary: ParallelOption[], all: ParallelOption[]): ParallelOption[] {
  const seen = new Set<string>();
  const merged: ParallelOption[] = [];
  for (const o of [...primary, ...all]) {
    if (!seen.has(o.variationOrParallel)) {
      seen.add(o.variationOrParallel);
      merged.push(o);
    }
  }
  return merged;
}

// Extract the serial limit (denominator) from detected serial strings.
// "487/499" → "499",  "/499" → "499",  "499" → "499"
function extractSerialLimit(serial: string): string {
  const afterSlash = serial.match(/\/(\d+)\s*$/);
  if (afterSlash) return afterSlash[1];
  const bareDigits = serial.match(/^(\d+)$/);
  if (bareDigits) return bareDigits[1];
  return "";
}

// Filter parallel options to those whose serial number limit matches the detected one.
function filterBySerialNumber(options: ParallelOption[], detectedSerial: string): ParallelOption[] {
  const limit = extractSerialLimit(detectedSerial);
  if (!limit) return [];
  return options.filter(o => {
    if (!o.serialNumber) return false;
    return extractSerialLimit(o.serialNumber) === limit;
  });
}

// Fetch parallel options from the DB for a given card.
//
// Important: parallels often live in a DIFFERENT collection than the base
// card (e.g. 2026 Topps "Holiday Polka Dots Green/Pink" is filed under
// collection "Base - Holiday Variation", but is inserted into Topps Series
// One packs). The endpoint's collection cascade would hide those when the
// base card OCR'd a different collection. To make sure the picker can
// surface them, we run two queries in parallel — one collection-precise,
// one brand+year broad — and merge them with the collection-precise
// variants first (so the most-relevant matches stay near the top).
async function fetchParallels(
  brand: string,
  year: number,
  collection?: string,
  set?: string
): Promise<ParallelOption[]> {
  const fetchOne = async (extraParams: Record<string, string>) => {
    const params = new URLSearchParams({ brand, year: year.toString(), ...extraParams });
    const resp = await fetch(`/api/card-variations/options?${params}`);
    if (!resp.ok) return [] as { variationOrParallel: string; serialNumber: string | null }[];
    const data = await resp.json();
    return (data.options || []) as { variationOrParallel: string; serialNumber: string | null }[];
  };

  const preciseParams: Record<string, string> = {};
  if (collection) preciseParams.collection = collection;
  if (set) preciseParams.set = set;

  const empty: { variationOrParallel: string; serialNumber: string | null }[] = [];
  const [precise, broad] = await Promise.all([
    Object.keys(preciseParams).length > 0 ? fetchOne(preciseParams) : Promise.resolve(empty),
    fetchOne({}), // brand+year only — picks up cross-collection parallels
  ]);

  // Deduplicate by parallel name, keeping the precise list first so it
  // appears at the top of the picker.
  const seen = new Set<string>();
  const merged: ParallelOption[] = [];
  for (const o of [...precise, ...broad]) {
    if (!seen.has(o.variationOrParallel)) {
      seen.add(o.variationOrParallel);
      merged.push({ variationOrParallel: o.variationOrParallel, serialNumber: o.serialNumber });
    }
  }
  return merged;
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
    const isNumberedCard = !!data.isNumbered || /\d+\/\d+/.test(detectedSerial);

    // No parallel detected AND no serial number — go straight to eBay as a base card
    if (!detected && !isNumberedCard) {
      setShowPriceResults(true);
      return;
    }

    // Fetch DB parallels and filter to matching variants
    if (data.brand && data.year) {
      const allOptions = await fetchParallels(data.brand, data.year as number, data.collection, data.set);

      // STEP 1 — Serial number match (highest confidence).
      // Filter DB parallels by the exact serial limit (e.g. /499). Multiple parallels
      // can share the same limit (Refractors /499, Sky Blue /499, Base /499), so when
      // there are multiple hits we further narrow using the OCR-detected foil keyword.
      if (detectedSerial) {
        const bySerial = filterBySerialNumber(allOptions, detectedSerial);
        if (bySerial.length === 1) {
          // Unambiguous serial match → auto-select, no prompt
          const match = bySerial[0];
          setCardData({ ...data, foilType: match.variationOrParallel, serialNumber: detectedSerial, isNumbered: true });
          setShowPriceResults(true);
          return;
        }
        if (bySerial.length >= 2 && detected) {
          // Multiple parallels share this serial number — try narrowing by foil keyword
          const narrowed = filterByKeyword(bySerial, detected);
          if (narrowed.length === 1) {
            // Serial + keyword together uniquely identify the parallel → auto-select
            const match = narrowed[0];
            setCardData({ ...data, foilType: match.variationOrParallel, serialNumber: detectedSerial, isNumbered: true });
            setShowPriceResults(true);
            return;
          }
          if (narrowed.length >= 2) {
            // Still ambiguous after both filters — show the narrowed set first,
            // followed by every other serial-status-matching parallel so the
            // user can override if the visual foil keyword was wrong.
            setParallelOptions(mergePreferringPrimary(narrowed, bySerial));
            setDetectedKeyword(extractKeyword(detected));
            setShowParallelPicker(true);
            return;
          }
          // narrowed to 0 (foil keyword matched nothing in serial set) — show all serial matches
          setParallelOptions(bySerial);
          setDetectedKeyword(extractKeyword(detected));
          setShowParallelPicker(true);
          return;
        }
        if (bySerial.length >= 2) {
          // Serial matches but no foil type detected — ask with those options
          setParallelOptions(bySerial);
          setDetectedKeyword("");
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
        // Exactly one keyword match. Auto-select ONLY when there are no other
        // non-numbered parallels in the catalog (i.e. it's the unambiguous
        // answer). Otherwise show the picker with the keyword match first so
        // the user can correct an OCR misread — e.g. visual detector said
        // "Red Crackle Foil" and DB has one non-numbered "Red Bordered" but
        // the card is actually a non-red Sandglitter parallel.
        const allForStatus = filterBySerialStatus(allOptions, !!data.isNumbered);
        if (allForStatus.length <= 1) {
          const match = filtered[0];
          const updated: Partial<CardFormValues> = { ...data, foilType: match.variationOrParallel };
          if (match.serialNumber) {
            const limit = match.serialNumber.replace(/\//g, "");
            // Preserve the OCR-detected full serial (e.g. "029/199") when present;
            // only fall back to the limit-only form ("/199") if no serial was scanned.
            updated.serialNumber = detectedSerial && /\d+\s*\/\s*\d+/.test(detectedSerial)
              ? detectedSerial
              : `/${limit}`;
            updated.isNumbered = true;
          }
          setCardData(updated);
          setShowPriceResults(true);
          return;
        }
        // Multiple non-numbered parallels exist — show picker with keyword match first.
        setParallelOptions(mergePreferringPrimary(filtered, allForStatus));
        setDetectedKeyword(extractKeyword(detected));
        setShowParallelPicker(true);
        return;
      }

      if (filtered.length >= 2) {
        // Multiple parallels match the same color/keyword — ask the user to
        // disambiguate. Show keyword matches first, then every other parallel
        // for the same serial-status so the user can correct the visual
        // detector (e.g. detected "Aqua Foil" but card is actually a
        // Sandglitter, which has no "aqua" in the name).
        const allForStatus = filterBySerialStatus(allOptions, !!data.isNumbered);
        setParallelOptions(mergePreferringPrimary(filtered, allForStatus));
        setDetectedKeyword(extractKeyword(detected));
        setShowParallelPicker(true);
        return;
      }

      // STEP 3 — Detected foil keyword had 0 or 1 DB hit but visual/eBay
      // detection asserted "this is a parallel". When 0 keyword matches but
      // the card is non-numbered with a detected parallel, give the user the
      // full list of non-serialized parallels rather than silently using a
      // wrong/unverifiable foil name. Sandglitter is exactly this case —
      // visual detector said "Aqua Foil" (0 keyword overlap with Sandglitter)
      // but the card is actually a non-numbered Sandglitter parallel.
      if (filtered.length === 0 && detected) {
        const allForStatus = filterBySerialStatus(allOptions, !!data.isNumbered);
        if (allForStatus.length >= 2) {
          setParallelOptions(allForStatus);
          setDetectedKeyword(extractKeyword(detected));
          setShowParallelPicker(true);
          return;
        }
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
        // Preserve a real OCR-detected serial (e.g. "029/199") if present;
        // only fall back to the limit-only form when none was scanned.
        const existing = (cardData?.serialNumber || "").trim();
        updated.serialNumber = /\d+\s*\/\s*\d+/.test(existing) ? existing : `/${limit}`;
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
