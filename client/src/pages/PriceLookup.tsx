import { useState, useEffect, useRef } from "react";
import CardCameraCapture from "@/components/CardCameraCapture";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Sparkles, ScanSearch, Camera, Image as ImageIcon, ScanLine } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOCR } from "@/hooks/use-ocr";
import { useToast } from "@/hooks/use-toast";
import OCRResults from "@/components/OCRResults";
import EbayPriceResults from "@/components/EbayPriceResults";
import ParallelPickerSheet, { ParallelOption } from "@/components/ParallelPickerSheet";
import { CardFormValues } from "@shared/schema";

// Resize + JPEG-compress a dataURL before upload.
// Caps the longer edge at maxPx and encodes at the given quality.
//
// Previous limits (1200 px @ q=0.82) worked fine for the large foreground
// text on a card (player name, brand banner, card number on the back) but
// silently destroyed small foil/hand-stamped serial numbers: at 1200 px on
// the long edge a 5 mm foil stamp shrinks to ~15 px tall, well below
// Vision API's reliable text-recovery threshold, and quality 0.82 then
// smears what little detail remains. We initially bumped to 2400 px @ q=0.92
// for foil-serial recovery but uploads ballooned to ~1.5 MB and total scan
// time grew noticeably. 1800 px @ q=0.88 is the middle ground: still
// ~2.25× the pixel area of the original 1200 px setting (plenty for serials),
// uploads typically ~700-900 KB, and Vision processes ~40% faster.
async function compressImage(dataUrl: string, maxPx = 1800, quality = 0.88): Promise<Blob> {
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

  // Prefer the collection/set-precise parallels. The broad brand+year query
  // is ONLY a fallback for when the catalog has no entries for the precise
  // collection/set combo (e.g. cross-collection parallels like Topps "Holiday
  // Polka Dots" filed under a different collection than the base card).
  // Mixing them unconditionally drags in every Topps 2025 parallel from
  // Chrome / Allen & Ginter / Heritage / etc., which is exactly what we
  // don't want when the picker is asking "which Stars of MLB parallel is
  // this?".
  let raw: { variationOrParallel: string; serialNumber: string | null }[] = [];
  if (Object.keys(preciseParams).length > 0) {
    raw = await fetchOne(preciseParams);
  }
  if (raw.length === 0) {
    raw = await fetchOne({}); // brand+year only — last-resort fallback
  }

  // Deduplicate by parallel name.
  const seen = new Set<string>();
  const merged: ParallelOption[] = [];
  for (const o of raw) {
    if (!seen.has(o.variationOrParallel)) {
      seen.add(o.variationOrParallel);
      merged.push({ variationOrParallel: o.variationOrParallel, serialNumber: o.serialNumber });
    }
  }
  return merged;
}

// Decorative viewfinder corner brackets that frame the preview area.
function CornerBrackets({ active }: { active: boolean }) {
  const color = active ? 'border-emerald-400' : 'border-slate-400';
  const base = `absolute w-6 h-6 border-2 ${color} pointer-events-none transition-colors`;
  return (
    <>
      <div className={`${base} top-2 left-2 border-r-0 border-b-0 rounded-tl-lg`} />
      <div className={`${base} top-2 right-2 border-l-0 border-b-0 rounded-tr-lg`} />
      <div className={`${base} bottom-2 left-2 border-r-0 border-t-0 rounded-bl-lg`} />
      <div className={`${base} bottom-2 right-2 border-l-0 border-t-0 rounded-br-lg`} />
    </>
  );
}

export default function PriceLookup() {
  const [frontImage, setFrontImage] = useState<string>("");
  const [backImage, setBackImage] = useState<string>("");
  // Sequential capture state machine: which side we're currently capturing.
  // 'idle' = nothing in flight, 'front' = camera/library expecting front image,
  // 'back' = camera/library expecting back image.
  const [captureStep, setCaptureStep] = useState<'idle' | 'front' | 'back'>('idle');
  const [cameraOpen, setCameraOpen] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showOCRResults, setShowOCRResults] = useState<boolean>(false);
  const [cardData, setCardData] = useState<Partial<CardFormValues> | null>(null);
  const [showPriceResults, setShowPriceResults] = useState<boolean>(false);
  const [showParallelPicker, setShowParallelPicker] = useState<boolean>(false);
  const [showParallelConfirm, setShowParallelConfirm] = useState<boolean>(false);
  const [parallelOptions, setParallelOptions] = useState<ParallelOption[]>([]);
  const [detectedKeyword, setDetectedKeyword] = useState<string>("");
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [useGeminiFirst, setUseGeminiFirst] = useState<boolean>(false);
  const { toast } = useToast();
  
  const { loading: ocrLoading, error: ocrError, data: ocrData } = useOCR();

  // When the parallel-confirm card or picker first appears, the page is
  // often still scrolled to wherever the user left it (typically below the
  // upload buttons), which leaves the prompt's title clipped above the
  // viewport. Snap back to the top so the whole prompt is visible.
  useEffect(() => {
    if (showParallelConfirm || showParallelPicker) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [showParallelConfirm, showParallelPicker]);

  // Surface the result of a "connect-and-add" Google sheet flow on return.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('sheetAdded')) {
      toast({ title: 'Saved to Google Sheet', description: 'Your card was added after connecting Google.' });
      params.delete('sheetAdded');
      const search = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (search ? `?${search}` : ''));
    } else if (params.has('sheetAddFailed')) {
      toast({ title: 'Could not save card after connecting', description: 'Please try Add to Google Sheet again.', variant: 'destructive' });
      params.delete('sheetAddFailed');
      const search = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (search ? `?${search}` : ''));
    }
  }, [toast]);

  // Called after scan completes — decides whether to show picker or go straight to eBay
  const processCardData = async (data: Partial<CardFormValues>) => {
    setCardData(data);

    const detected = data.foilType?.trim() || "";
    const detectedSerial = data.serialNumber?.trim() || "";
    const isNumberedCard = !!data.isNumbered || /\d+\/\d+/.test(detectedSerial);
    // Server flag: visual foil detector saw genuine foil/parallel signal but
    // FoilDB couldn't confirm a specific colour. We still want to prompt the
    // user to pick from the catalog rather than silently treating as base.
    const parallelSuspected = !!(data as any).parallelSuspected;

    // No parallel detected AND no serial number AND no suspected parallel —
    // go straight to eBay as a base card
    if (!detected && !isNumberedCard && !parallelSuspected) {
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
            setShowParallelConfirm(true);
            return;
          }
          // narrowed to 0 (foil keyword matched nothing in serial set) — show all serial matches
          setParallelOptions(bySerial);
          setDetectedKeyword(extractKeyword(detected));
          setShowParallelConfirm(true);
          return;
        }
        if (bySerial.length >= 2) {
          // Serial matches but no foil type detected — ask with those options
          setParallelOptions(bySerial);
          setDetectedKeyword("");
          setShowParallelConfirm(true);
          return;
        }
        // 0 serial matches — fall through to keyword matching below
      }

      // STEP 2 — Keyword + serialization-status match.
      // Used when no serial number was detected, or the serial matched nothing in the DB.
      // Only prompt if OCR found a color/keyword AND multiple parallels share it.
      const byKeyword = filterByKeyword(allOptions, detected);
      const filtered = filterBySerialStatus(byKeyword, !!detectedSerial && !!data.isNumbered);

      if (filtered.length === 1) {
        // Exactly one keyword match. Auto-select ONLY when there are no other
        // non-numbered parallels in the catalog (i.e. it's the unambiguous
        // answer). Otherwise show the picker with the keyword match first so
        // the user can correct an OCR misread — e.g. visual detector said
        // "Red Crackle Foil" and DB has one non-numbered "Red Bordered" but
        // the card is actually a non-red Sandglitter parallel.
        const allForStatus = filterBySerialStatus(allOptions, !!detectedSerial && !!data.isNumbered);
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
        setShowParallelConfirm(true);
        return;
      }

      if (filtered.length >= 2) {
        // Multiple parallels match the same color/keyword — ask the user to
        // disambiguate. Show keyword matches first, then every other parallel
        // for the same serial-status so the user can correct the visual
        // detector (e.g. detected "Aqua Foil" but card is actually a
        // Sandglitter, which has no "aqua" in the name).
        const allForStatus = filterBySerialStatus(allOptions, !!detectedSerial && !!data.isNumbered);
        setParallelOptions(mergePreferringPrimary(filtered, allForStatus));
        setDetectedKeyword(extractKeyword(detected));
        setShowParallelConfirm(true);
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
        const allForStatus = filterBySerialStatus(allOptions, !!detectedSerial && !!data.isNumbered);
        if (allForStatus.length >= 2) {
          setParallelOptions(allForStatus);
          setDetectedKeyword(extractKeyword(detected));
          setShowParallelConfirm(true);
          return;
        }
      }

      // STEP 4 — Visual detector saw foil-like signal but couldn't pin down a
      // specific colour (parallelSuspected). No keyword to filter on, so show
      // every non-numbered parallel for this set and let the user pick.
      // Triggers the picker in cases like "Rainbow Foil / Shimmer" where the
      // colour detector sees lots of hues but FoilDB rejects the named colour.
      if (parallelSuspected && !detected && !detectedSerial) {
        const allForStatus = filterBySerialStatus(allOptions, !!detectedSerial && !!data.isNumbered);
        if (allForStatus.length >= 1) {
          setParallelOptions(allForStatus);
          setDetectedKeyword("");
          setShowParallelConfirm(true);
          return;
        }
      }
    }

    // 0 DB matches — use the OCR-detected value as-is and go straight to eBay
    setShowPriceResults(true);
  };

  const handleAnalyzeRequest = async (frontOverride?: string, backOverride?: string) => {
    const front = frontOverride ?? frontImage;
    const back = backOverride ?? backImage;
    if (!back) {
      toast({
        title: "Back Image Required",
        description: "Please capture the back of the card for detailed card information.",
        variant: "destructive",
      });
      return;
    }
    
    setAnalyzing(true);
    try {
      // Compress both images in parallel before upload — reduces size 5-10x
      // (camera images are often 1.5-3 MB; 1200px JPEG is plenty for OCR)
      const [backBlob, frontBlob] = await Promise.all([
        compressImage(back),
        front ? compressImage(front) : Promise.resolve(null),
      ]);

      const formData = new FormData();
      formData.append('backImage', backBlob, 'back.jpg');
      if (frontBlob) formData.append('frontImage', frontBlob, 'front.jpg');
      formData.append('engine', useGeminiFirst ? 'gemini' : 'ocr');

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
    setShowParallelConfirm(false);
    setParallelOptions([]);
    setCardData(null);
    setCaptureStep('idle');
    setCameraOpen(false);
  };

  // Sequential camera capture: front → back → auto-analyze.
  const startCameraCapture = () => {
    setFrontImage("");
    setBackImage("");
    setCaptureStep('front');
    setCameraOpen(true);
  };

  const handleCameraCapture = (dataUrl: string) => {
    if (captureStep === 'front') {
      setFrontImage(dataUrl);
      // Brief close so the camera reinitialises with the new title.
      setCameraOpen(false);
      setCaptureStep('back');
      // Re-open immediately for the back. requestAnimationFrame avoids
      // the modal flicker of doing it synchronously.
      requestAnimationFrame(() => setCameraOpen(true));
    } else if (captureStep === 'back') {
      setBackImage(dataUrl);
      setCameraOpen(false);
      setCaptureStep('idle');
      // Auto-trigger analysis once we have both sides.
      handleAnalyzeRequest(frontImage, dataUrl);
    }
  };

  const handleCameraClose = () => {
    setCameraOpen(false);
    setCaptureStep('idle');
  };

  // Sequential photo library pick: front → back → auto-analyze.
  const startLibraryPick = () => {
    setFrontImage("");
    setBackImage("");
    setCaptureStep('front');
    fileInputRef.current?.click();
  };

  const handleLibraryFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      setCaptureStep('idle');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      if (captureStep === 'front') {
        setFrontImage(dataUrl);
        setCaptureStep('back');
        // Re-open the file picker for the back image on next tick.
        setTimeout(() => fileInputRef.current?.click(), 50);
      } else if (captureStep === 'back') {
        setBackImage(dataUrl);
        setCaptureStep('idle');
        handleAnalyzeRequest(frontImage, dataUrl);
      }
    };
    reader.readAsDataURL(file);
  };

  // User said "Yes, this is a parallel" → show the picker
  const handleParallelConfirmYes = () => {
    setShowParallelConfirm(false);
    setShowParallelPicker(true);
  };

  // User said "No, not a parallel" → clear any detected foil and price as base
  const handleParallelConfirmNo = () => {
    setCardData((prev) => {
      if (!prev) return prev;
      return { ...prev, foilType: "" };
    });
    setShowParallelConfirm(false);
    setParallelOptions([]);
    setDetectedKeyword("");
    setShowPriceResults(true);
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
      {!showOCRResults && !showPriceResults && !showParallelPicker && !showParallelConfirm && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScanSearch className="h-5 w-5" />
              {analyzing ? 'Instant Card Recognition' : 'Scan Your Card'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!analyzing && (
              <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-purple-500" />
                  <Label htmlFor="gemini-first" className="cursor-pointer text-sm font-medium">
                    Try Gemini first (beta)
                  </Label>
                </div>
                <Switch
                  id="gemini-first"
                  checked={useGeminiFirst}
                  onCheckedChange={setUseGeminiFirst}
                />
              </div>
            )}

            {/* Card preview / scanning interstitial */}
            <div
              className={`relative mx-auto w-full max-w-sm aspect-[3/4] rounded-2xl overflow-hidden bg-slate-50 border-2 transition-all ${
                analyzing
                  ? 'border-emerald-400 shadow-[0_0_40px_rgba(52,211,153,0.45)]'
                  : frontImage
                  ? 'border-slate-300'
                  : 'border-dashed border-slate-300'
              }`}
            >
              {/* Corner brackets — always visible to evoke a viewfinder */}
              <CornerBrackets active={analyzing} />

              {frontImage ? (
                <img src={frontImage} alt="Front preview" className="w-full h-full object-contain" />
              ) : backImage ? (
                <img src={backImage} alt="Back preview" className="w-full h-full object-contain" />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 gap-2">
                  <ScanLine className="h-12 w-12" />
                  <p className="text-xs uppercase tracking-widest font-semibold">Scanner Ready</p>
                </div>
              )}

              {analyzing && (
                <>
                  <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-black/70 text-emerald-300 text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Scanning
                  </div>
                  {/* Animated scan line sweep */}
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-full overflow-hidden">
                    <div className="absolute inset-x-0 h-1 bg-gradient-to-r from-transparent via-emerald-400 to-transparent shadow-[0_0_12px_rgba(52,211,153,0.8)] animate-scan-sweep" />
                  </div>
                </>
              )}
            </div>

            {analyzing ? (
              <div className="flex flex-col items-center gap-3 pt-2">
                <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm font-medium">
                  <ScanSearch className="h-4 w-4" />
                  Analyzing card...
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            ) : (
              <>
                <p className="text-center text-sm text-muted-foreground">
                  {captureStep === 'front'
                    ? 'Capture the FRONT of the card'
                    : captureStep === 'back'
                    ? 'Now capture the BACK of the card'
                    : 'Drop a card into the portal to unlock real-time market insights'}
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <Button
                    onClick={startCameraCapture}
                    size="lg"
                    className="bg-slate-800 hover:bg-slate-900 text-white"
                  >
                    <Camera className="h-4 w-4 mr-2" />
                    Take a Photo
                  </Button>
                  <Button onClick={startLibraryPick} size="lg" variant="outline">
                    <ImageIcon className="h-4 w-4 mr-2" />
                    Photo Library
                  </Button>
                </div>
              </>
            )}

            <input
              type="file"
              ref={fileInputRef}
              onChange={handleLibraryFile}
              accept="image/jpeg,image/png,image/heic,image/heif,image/webp"
              className="hidden"
            />

            <CardCameraCapture
              open={cameraOpen}
              title={captureStep === 'back' ? 'Back of Card' : 'Front of Card'}
              onCapture={handleCameraCapture}
              onClose={handleCameraClose}
            />
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

      {/* Confirmation prompt — shown before the picker so the user can dismiss
          a false-positive parallel detection without scrolling through options. */}
      {showParallelConfirm && cardData && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScanSearch className="h-5 w-5" />
              Potential Parallel Detected
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {cardDescription && (
              <p className="text-sm text-muted-foreground">{cardDescription}</p>
            )}
            {detectedKeyword && (
              <p className="text-sm">
                Detected: <span className="font-medium">{detectedKeyword}</span>
              </p>
            )}
            <p>Is this a parallel?</p>
            <div className="grid grid-cols-2 gap-3">
              <Button onClick={handleParallelConfirmYes} size="lg">
                Yes
              </Button>
              <Button
                onClick={handleParallelConfirmNo}
                variant="outline"
                size="lg"
              >
                No
              </Button>
            </div>
          </CardContent>
        </Card>
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
              // If the user added or changed the serial-number limit during
              // edit (e.g. filled in "041/150" that OCR missed), re-run the
              // parallel resolution flow so the picker can narrow options to
              // the matching print run — or auto-select when only one
              // parallel shares that limit. Otherwise just save and let the
              // results pane re-fetch eBay with the edited fields.
              const prevLimit = extractSerialLimit((cardData?.serialNumber || "").trim());
              const nextLimit = extractSerialLimit((updatedData.serialNumber || "").trim());
              if (nextLimit && nextLimit !== prevLimit) {
                setShowPriceResults(false);
                processCardData(updatedData);
              } else {
                setCardData(updatedData);
              }
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
