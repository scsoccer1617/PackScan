// Scan capture page — /scan
//
// Owns ONLY image capture (front + back) and the "Analyze & price" action.
// On successful analyze, the result is stored in the ScanFlow context and
// the user is navigated to /result, where pricing / grading / pickers live.
//
// This is the capture half of the split that replaced the old monolithic
// PriceLookup.tsx. The results half is ScanResult.tsx.

import { useRef, useState } from "react";
import { useLocation } from "wouter";
import SimpleImageUploader from "@/components/SimpleImageUploader";
import { useToast } from "@/hooks/use-toast";
import { useScanFlow } from "@/hooks/use-scan-flow";
import { compressImage } from "@/lib/scanFlow";
import type { HoloGrade } from "@/components/HoloGradeCard";
import { ScanLine, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

// ── F-3a: preliminary front OCR during card flip ─────────────────────────
// Generate a fresh scanId per scan session (front shutter → back shutter →
// analyze). We include this in both the preliminary fire-and-forget call and
// the final /analyze-card-dual-images upload so the server can stitch them
// together. A new id is minted after every reset() so stale server-side
// cache entries never collide with a later scan.
function mintScanId(): string {
  // crypto.randomUUID is available in all modern browsers + the iOS webview
  // PackScan ships in. Fall back to a timestamp+random string for safety.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Fire the preliminary OCR call in the background. Resolves/rejects are
// swallowed — the main scan flow has zero dependency on this succeeding.
// We still compress the image first (same path as the real upload) so the
// payload the preliminary handler analyzes is byte-identical to what the
// main handler will see, which means any OCR/analyzer output the preliminary
// produced is directly reusable by the main pipeline.
async function firePreliminaryScan(scanId: string, frontImageDataUrl: string): Promise<void> {
  try {
    const blob = await compressImage(frontImageDataUrl);
    const form = new FormData();
    form.append("frontImage", blob, "front.jpg");
    form.append("scanId", scanId);
    const response = await fetch("/api/scan/preliminary", {
      method: "POST",
      body: form,
    });
    // F-3c: read the response so we can log the visual-foil hint the server
    // computed during preliminary. The main scan flow's UI still fires from
    // /result based on the authoritative dual-image analyze response, but
    // surfacing this hint here gives us an observation point if we later
    // want to show a "parallel detected" cue before the back shutter.
    try {
      const body = (await response.json()) as {
        success?: boolean;
        visualFoil?: {
          isFoil: boolean;
          foilType: string | null;
          confidence: number;
        } | null;
      };
      if (body?.visualFoil) {
        console.debug(
          `[preliminary] visualFoil hint: isFoil=${body.visualFoil.isFoil} foilType=${body.visualFoil.foilType ?? 'none'} confidence=${body.visualFoil.confidence?.toFixed?.(2) ?? body.visualFoil.confidence}`,
        );
      }
    } catch {
      // Body parse failures don't matter — server still cached the hint.
    }
  } catch (err) {
    // Silent — any failure here just means the main handler does what it
    // already does today (runs front OCR + analyzer inline). No user impact.
    console.debug("[preliminary] skipped:", err);
  }
}

export default function Scan() {
  const [, navigate] = useLocation();
  const { setAll, reset } = useScanFlow();
  const { toast } = useToast();

  // Local-only capture state — only committed to the shared context after
  // the analyze call succeeds, so returning to /scan after a result doesn't
  // show stale images in the slots.
  const [frontImage, setFrontImage] = useState<string>("");
  const [backImage, setBackImage] = useState<string>("");
  const [backCameraSignal, setBackCameraSignal] = useState<number>(0);
  const [analyzing, setAnalyzing] = useState<boolean>(false);

  // Ref (not state) so updating the scanId on front capture doesn't trigger
  // a re-render. Null until the first front capture mints one; reset to a
  // new id whenever the user retakes the front.
  const scanIdRef = useRef<string | null>(null);

  const ready = !!backImage;

  const handleAnalyze = async () => {
    if (!backImage) {
      toast({
        title: "Back Image Required",
        description:
          "Please capture the BACK of the card for detailed card info.",
        variant: "destructive",
      });
      return;
    }

    setAnalyzing(true);
    try {
      // Compress both sides in parallel before upload.
      const [backBlob, frontBlob] = await Promise.all([
        compressImage(backImage),
        frontImage ? compressImage(frontImage) : Promise.resolve(null),
      ]);

      const formData = new FormData();
      formData.append("backImage", backBlob, "back.jpg");
      if (frontBlob) formData.append("frontImage", frontBlob, "front.jpg");
      // Include the scanId so the server can pair this upload with a
      // preliminary front-side result if one was cached. When the ref is
      // unset (edge case: no front image captured), skip it.
      if (scanIdRef.current) {
        formData.append("scanId", scanIdRef.current);
      }

      const response = await fetch("/api/analyze-card-dual-images", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) throw new Error("Analysis failed");

      const result = await response.json();
      console.log("[Scan] analyze response", {
        ok: response.ok,
        success: result?.success,
        hasData: !!result?.data,
        foilType: result?.data?.foilType,
        hasHolo: !!result?.data?.holo,
      });
      if (!result.success || !result.data) {
        throw new Error(result.message || "Analysis failed");
      }

      // Clear any prior scan's leftovers, then seed the fresh payload.
      reset();
      // Consume the scanId: a retry after this point should mint a new one
      // (the server cache is consume-once anyway, but this keeps state tidy).
      scanIdRef.current = null;
      setAll({
        frontImage,
        backImage,
        cardData: result.data,
        holoGrade: (result.data.holo as HoloGrade) ?? null,
      });
      console.log("[Scan] navigating to /result");
      navigate("/result");
    } catch (error) {
      console.error("Analysis error:", error);
      toast({
        title: "Analysis Failed",
        description: "Could not analyze the card image. Please try again.",
        variant: "destructive",
      });
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="pt-4 pb-6 space-y-4">
      <div className="px-4">
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">
          Scan a card
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Capture front and back. We'll analyze, grade and pull comps in
          seconds.
        </p>
      </div>

      <div className="px-4 grid grid-cols-2 gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
            Front
          </p>
          <SimpleImageUploader
            onImageCaptured={(img, source) => {
              setFrontImage(img);
              // Mint a fresh scanId for every new front capture (including
              // retakes) so the server-side cache never serves stale OCR
              // against a different image than what the user ultimately
              // uploads for analysis.
              const scanId = mintScanId();
              scanIdRef.current = scanId;
              // Fire-and-forget preliminary OCR so the server starts analyzing
              // the front while the user flips the card. Errors are ignored
              // entirely — the main /analyze call has zero dependency on this.
              void firePreliminaryScan(scanId, img);
              // Auto-chain into the back camera only when the user captured
              // the front via live camera — if they uploaded from library,
              // they probably want to upload the back the same way.
              if (!backImage && source === "camera") {
                setBackCameraSignal((n) => n + 1);
              }
            }}
            label="Capture front"
            cameraTitle="Front of Card"
            existingImage={frontImage}
          />
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
            Back
          </p>
          <SimpleImageUploader
            onImageCaptured={setBackImage}
            label="Capture back"
            cameraTitle="Back of Card"
            existingImage={backImage}
            openCameraSignal={backCameraSignal}
          />
        </div>
      </div>

      <div className="px-4 pt-2">
        <button
          type="button"
          onClick={handleAnalyze}
          disabled={!ready || analyzing}
          className={cn(
            "w-full h-14 rounded-2xl font-display font-semibold text-base flex items-center justify-center gap-2 transition",
            ready && !analyzing
              ? "bg-foil text-white grade-halo"
              : "bg-slate-100 text-slate-400 cursor-not-allowed",
          )}
          data-testid="button-analyze"
        >
          {analyzing ? (
            <>
              <RotateCw className="w-5 h-5 animate-spin" /> Analyzing…
            </>
          ) : (
            <>
              <ScanLine className="w-5 h-5" /> Analyze &amp; price
            </>
          )}
        </button>
        {!ready && !analyzing && (
          <p className="text-xs text-slate-500 text-center mt-2">
            Capture the back of the card to continue
          </p>
        )}
      </div>
    </div>
  );
}
