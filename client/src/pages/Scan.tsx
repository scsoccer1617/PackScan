// Scan capture page — /scan
//
// Owns ONLY image capture (front + back) and the "Analyze & price" action.
// On successful analyze, the result is stored in the ScanFlow context and
// the user is navigated to /result, where pricing / grading / pickers live.
//
// This is the capture half of the split that replaced the old monolithic
// PriceLookup.tsx. The results half is ScanResult.tsx.

import { useState } from "react";
import { useLocation } from "wouter";
import SimpleImageUploader from "@/components/SimpleImageUploader";
import { useToast } from "@/hooks/use-toast";
import { useScanFlow } from "@/hooks/use-scan-flow";
import { compressImage } from "@/lib/scanFlow";
import type { HoloGrade } from "@/components/HoloGradeCard";
import { ScanLine, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

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
