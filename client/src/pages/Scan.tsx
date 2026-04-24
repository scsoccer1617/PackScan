// Scan entry page — /scan
//
// Three-tile entry point to the pricing pipeline:
//   • Scan   — capture front + back photos, full dual-image analyze
//   • Voice  — speak a card description; Gemini extracts fields, user
//               confirms, lands on /result with same SCP+eBay pipeline
//   • Manual — jump to the long-form /add-card page (SimpleCardForm)
//
// The Scan tile is the primary action and is pre-selected — tapping it
// reveals the front/back capture grid and the "Analyze & price" button
// below the tiles. Tapping Voice toggles into voice mode (mic tile).
// Tapping Manual navigates away. Switching back and forth doesn't lose
// already-captured images (scan state stays local).
//
// On successful analyze (image or voice), we seed the ScanFlow context
// and navigate to /result where runPostScanFlow drives parallel
// disambiguation + eBay comps. This is the capture half of the split
// that replaced the old monolithic PriceLookup.tsx.

import { useRef, useState } from "react";
import { useLocation } from "wouter";
import SimpleImageUploader from "@/components/SimpleImageUploader";
import VoiceLookup, { type ExtractedCardFields } from "@/components/VoiceLookup";
import { useToast } from "@/hooks/use-toast";
import { useScanFlow } from "@/hooks/use-scan-flow";
import { compressImage } from "@/lib/scanFlow";
import type { CardFormValues } from "@shared/schema";
import type { HoloGrade } from "@/components/HoloGradeCard";
import { Camera, Mic, PenLine, ScanLine, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Voice → CardFormValues mapping ────────────────────────────────────────
// Mirrors the server-side splitPlayerName() so Jr/Sr/III stay attached to the
// last name and eBay's stripMiddleNames pass still behaves the same.
function splitPlayerName(playerName: string | null | undefined): { first: string; last: string } {
  if (!playerName) return { first: "", last: "" };
  const tokens = playerName.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { first: "", last: "" };
  if (tokens.length === 1) return { first: tokens[0], last: "" };
  const suffixRe = /^(jr|sr|ii|iii|iv|v)\.?$/i;
  const lastToken = tokens[tokens.length - 1];
  if (suffixRe.test(lastToken) && tokens.length >= 3) {
    return { first: tokens[0], last: `${tokens[tokens.length - 2]} ${lastToken}` };
  }
  return { first: tokens[0], last: tokens.slice(1).join(" ") };
}

// Map voice-extracted fields onto the CardFormValues shape the /result page
// expects. /result's runPostScanFlow tolerates missing fields — we don't need
// to force placeholders past what the existing image-scan flow would produce.
function fieldsToCardData(fields: ExtractedCardFields): Partial<CardFormValues> {
  const { first, last } = splitPlayerName(fields.playerName);
  return {
    sport: fields.sport || "Baseball",
    playerFirstName: first,
    playerLastName: last,
    brand: fields.brand || "",
    collection: fields.collection || "",
    set: fields.setName || fields.collection || "",
    cardNumber: fields.cardNumber || "",
    year: fields.year ?? 0,
    variant: fields.parallel || "",
    serialNumber: fields.serialNumber || "",
    notes: fields.notes || "",
    isNumbered: !!fields.serialNumber,
    isFoil: false,
    foilType: null,
    isRookieCard: false,
    isAutographed: false,
    frontImage: "",
    backImage: "",
  };
}

// ── F-3a: preliminary front OCR during card flip ─────────────────────────
// Generate a fresh scanId per scan session (front shutter → back shutter →
// analyze) so the server can stitch the preliminary fire-and-forget call and
// the final /analyze-card-dual-images upload together. A new id is minted
// after every reset() so stale server-side cache entries never collide.
function mintScanId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function firePreliminaryScan(scanId: string, frontImageDataUrl: string): Promise<void> {
  try {
    const blob = await compressImage(frontImageDataUrl);
    const form = new FormData();
    form.append("frontImage", blob, "front.jpg");
    form.append("scanId", scanId);
    const response = await fetch("/api/scan/preliminary", { method: "POST", body: form });
    try {
      const body = (await response.json()) as {
        success?: boolean;
        visualFoil?: { isFoil: boolean; foilType: string | null; confidence: number } | null;
      };
      if (body?.visualFoil) {
        console.debug(
          `[preliminary] visualFoil hint: isFoil=${body.visualFoil.isFoil} foilType=${body.visualFoil.foilType ?? 'none'} confidence=${body.visualFoil.confidence?.toFixed?.(2) ?? body.visualFoil.confidence}`,
        );
      }
    } catch {
      /* Body parse failures don't matter — the server still cached the hint. */
    }
  } catch (err) {
    console.debug("[preliminary] skipped:", err);
  }
}

// ── Page ─────────────────────────────────────────────────────────────────
type Mode = "image" | "voice";

export default function Scan() {
  const [, navigate] = useLocation();
  const { setAll, reset } = useScanFlow();
  const { toast } = useToast();

  const [mode, setMode] = useState<Mode>("image");

  // Image capture state — kept local so switching to voice and back doesn't
  // drop captured photos.
  const [frontImage, setFrontImage] = useState<string>("");
  const [backImage, setBackImage] = useState<string>("");
  const [backCameraSignal, setBackCameraSignal] = useState<number>(0);
  const [analyzing, setAnalyzing] = useState<boolean>(false);

  // Ref so minting a new scanId on each front capture doesn't re-render.
  const scanIdRef = useRef<string | null>(null);

  const ready = !!backImage;

  const handleVoiceConfirm = (fields: ExtractedCardFields) => {
    reset();
    scanIdRef.current = null;
    setAll({
      frontImage: "",
      backImage: "",
      cardData: fieldsToCardData(fields),
      holoGrade: null,
    });
    navigate("/result");
  };

  const handleAnalyze = async () => {
    if (!backImage) {
      toast({
        title: "Back Image Required",
        description: "Please capture the BACK of the card for detailed card info.",
        variant: "destructive",
      });
      return;
    }

    setAnalyzing(true);
    try {
      const [backBlob, frontBlob] = await Promise.all([
        compressImage(backImage),
        frontImage ? compressImage(frontImage) : Promise.resolve(null),
      ]);

      const formData = new FormData();
      formData.append("backImage", backBlob, "back.jpg");
      if (frontBlob) formData.append("frontImage", frontBlob, "front.jpg");
      if (scanIdRef.current) formData.append("scanId", scanIdRef.current);

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

      reset();
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
          Look up a card
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Choose how you want to find your card.
        </p>
      </div>

      {/* ── Entry tiles ─────────────────────────────────────────────────── */}
      <div className="px-4 grid grid-cols-3 gap-2.5">
        <ModeTile
          icon={<Camera className="w-5 h-5" />}
          label="Scan"
          hint="Front & back"
          active={mode === "image"}
          onClick={() => setMode("image")}
          testId="tile-scan"
        />
        <ModeTile
          icon={<Mic className="w-5 h-5" />}
          label="Voice"
          hint="Speak it"
          active={mode === "voice"}
          onClick={() => setMode("voice")}
          testId="tile-voice"
        />
        <ModeTile
          icon={<PenLine className="w-5 h-5" />}
          label="Manual"
          hint="Type it"
          active={false}
          onClick={() => navigate("/add-card")}
          testId="tile-manual"
        />
      </div>

      {/* ── Image capture ───────────────────────────────────────────────── */}
      {mode === "image" && (
        <>
          <div className="px-4 grid grid-cols-2 gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
                Front
              </p>
              <SimpleImageUploader
                onImageCaptured={(img, source) => {
                  setFrontImage(img);
                  const scanId = mintScanId();
                  scanIdRef.current = scanId;
                  void firePreliminaryScan(scanId, img);
                  if (!backImage && source === "camera") {
                    setBackCameraSignal((n) => n + 1);
                  }
                }}
                label="Capture front"
                cameraTitle="Front of Card"
                existingImage={frontImage}
                retakeLabel="Rescan Front"
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
                retakeLabel="Rescan Back"
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
        </>
      )}

      {/* ── Voice capture ───────────────────────────────────────────────── */}
      {mode === "voice" && (
        <div className="px-4 space-y-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-sm font-display font-semibold text-ink">
              Describe the card you&apos;re holding
            </p>
            <p className="text-xs text-slate-500 mt-1 leading-snug">
              Example: &ldquo;2025 Topps Series One Nolan Arenado card number
              193 pink green polka dots.&rdquo; Tap the mic, speak, then confirm
              the fields before we price it.
            </p>
          </div>
          <VoiceLookup onConfirm={handleVoiceConfirm} disabled={analyzing} />
        </div>
      )}
    </div>
  );
}

// ── Tile ──────────────────────────────────────────────────────────────────
interface ModeTileProps {
  icon: React.ReactNode;
  label: string;
  hint: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}

function ModeTile({ icon, label, hint, active, onClick, testId }: ModeTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "group flex flex-col items-center justify-center gap-1 rounded-2xl h-[88px] px-2 border transition",
        active
          ? "bg-foil text-white border-foil shadow-sm"
          : "bg-white text-ink border-slate-200 hover:border-slate-300 active:bg-slate-50",
      )}
    >
      <div
        className={cn(
          "w-9 h-9 rounded-full flex items-center justify-center",
          active ? "bg-white/15" : "bg-slate-100 text-slate-600 group-hover:bg-slate-200",
        )}
      >
        {icon}
      </div>
      <div className="flex flex-col items-center leading-tight">
        <span className="font-display text-[13px] font-semibold">{label}</span>
        <span
          className={cn(
            "text-[10px] uppercase tracking-wider font-semibold",
            active ? "text-white/70" : "text-slate-400",
          )}
        >
          {hint}
        </span>
      </div>
    </button>
  );
}
