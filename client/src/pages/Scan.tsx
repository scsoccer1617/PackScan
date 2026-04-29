// Scan entry page — /scan
//
// Capture half of the pricing pipeline. The Home page owns the three
// entry tiles (Scan / Voice / Manual); this page renders just the capture
// surface the user picked:
//
//   /scan             → front + back photo capture (default)
//   /scan?mode=voice  → mic + confirm sheet for voice lookup
//
// Manual lookup lives at /add-card and is reached directly from Home — it
// is not rendered here.
//
// On successful analyze (image or voice), we seed the ScanFlow context and
// navigate to /result where runPostScanFlow drives parallel disambiguation
// + eBay comps. This is the capture half of the split that replaced the
// old monolithic PriceLookup.tsx.

import { useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import SimpleImageUploader from "@/components/SimpleImageUploader";
import VoiceLookup, { type ExtractedCardFields } from "@/components/VoiceLookup";
import { useToast } from "@/hooks/use-toast";
import { useScanFlow } from "@/hooks/use-scan-flow";
import { compressImage } from "@/lib/scanFlow";
import { queryClient } from "@/lib/queryClient";
import type { CardFormValues } from "@shared/schema";
import type { HoloGrade } from "@/components/HoloGradeCard";
import { ScanLine, RotateCw } from "lucide-react";
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
    psaGrade: fields.psaGrade ?? null,
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

function modeFromSearch(search: string): Mode {
  const params = new URLSearchParams(search);
  return params.get("mode") === "voice" ? "voice" : "image";
}

export default function Scan() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { setAll, reset } = useScanFlow();
  const { toast } = useToast();

  const mode: Mode = modeFromSearch(search);

  // Image capture state — kept local so switching to voice and back doesn't
  // drop captured photos.
  const [frontImage, setFrontImage] = useState<string>("");
  const [backImage, setBackImage] = useState<string>("");
  const [backCameraSignal, setBackCameraSignal] = useState<number>(0);
  const [analyzing, setAnalyzing] = useState<boolean>(false);

  // Ref so minting a new scanId on each front capture doesn't re-render.
  const scanIdRef = useRef<string | null>(null);
  // QW-1: client-minted UUID for the user_scans audit row. Sent in the
  // analyze multipart so the server can fire-and-forget the insert
  // without blocking the response on a `RETURNING id` round-trip.
  const userScanIdRef = useRef<string | null>(null);

  const ready = !!backImage;

  const handleVoiceConfirm = async (
    fields: ExtractedCardFields,
    voiceScanId: string | null,
  ) => {
    reset();
    scanIdRef.current = null;
    const cardData = fieldsToCardData(fields);

    // Voice speculative lookups (F-3b mirror for SCP + H-5 for CardDB): while
    // the confirm sheet was open, the server fired two background lookups
    // keyed by voiceScanId — one to SportsCardsPro and one to the local
    // card_database. Fetch both now in a single call so /result can render
    // SCP pricing immediately (no second /catalog/match round trip) AND so
    // CardDB-authoritative fields (rookie flag, corrected card number via
    // player-anchored fallback, authoritative collection/set/variation) are
    // applied before the /result page reads cardData. The server briefly
    // waits (~2s) for both to resolve. On any error / null, we fall through
    // to the existing client-side fetch path on /result with zero regression.
    if (voiceScanId) {
      try {
        const params = new URLSearchParams({
          voiceScanId,
          playerFirstName: cardData.playerFirstName || "",
          playerLastName: cardData.playerLastName || "",
        });
        const res = await fetch(`/api/voice-lookup/speculative-scp?${params.toString()}`);
        const body = await res.json().catch(() => ({ scpResult: null, cardDbResult: null }));
        if (body?.scpResult) {
          (cardData as any).speculativeCatalog = body.scpResult;
        }
        // H-5: Merge CardDB enrichment into cardData. Only overwrite fields
        // that CardDB populated, preserving any edits the user made in the
        // confirm sheet. Serial number is explicitly preserved — the user
        // may have spoken "12/99" that the catalog doesn't list as a parallel.
        const dbHit = body?.cardDbResult?.hit;
        if (dbHit && dbHit.found) {
          if (dbHit.playerFirstName) cardData.playerFirstName = dbHit.playerFirstName;
          if (dbHit.playerLastName) cardData.playerLastName = dbHit.playerLastName;
          if (dbHit.brand) cardData.brand = dbHit.brand;
          if (dbHit.year) cardData.year = dbHit.year;
          if (dbHit.collection) cardData.collection = dbHit.collection;
          if (dbHit.set) cardData.set = dbHit.set;
          if (dbHit.cardNumber) cardData.cardNumber = dbHit.cardNumber;
          if (dbHit.isRookieCard) cardData.isRookieCard = true;
          // Variant: DB variation is an authoritative catalog parallel name;
          // prefer it over the spoken free-form parallel when the speaker
          // didn't give one, or when the catalog resolved it unambiguously.
          if (dbHit.variation && !cardData.variant) {
            cardData.variant = dbHit.variation;
          }
          if ((dbHit as any).cmpNumber) {
            (cardData as any).cmpNumber = (dbHit as any).cmpNumber;
          }
          console.debug(
            `[Scan] voice CardDB enrichment applied (${body.cardDbResult.source}): cardNumber="${dbHit.cardNumber}" rookie=${!!dbHit.isRookieCard} collection="${dbHit.collection}"`,
          );
        }
      } catch (err) {
        console.warn("[Scan] voice speculative lookups fetch failed (non-blocking):", err);
      }
    }

    setAll({
      frontImage: "",
      backImage: "",
      cardData,
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

    // ── Diagnostic timing markers ──────────────────────────────────────
    // We were seeing the server-side scan log row land in the Sheet ~30s
    // before the UI showed results. These markers narrow down where the
    // wall-clock is going (compress → network → parse → navigate →
    // results render → picker open). Stash a global timestamp so the
    // ScanResult page can finish the chain.
    const timing = {
      clickedAt: performance.now(),
      compressDoneAt: 0,
      requestSentAt: 0,
      responseReceivedAt: 0,
      navigateAt: 0,
    };
    (window as any).__holoScanTiming = timing;
    console.log('[holo-timing] click → starting compress');

    setAnalyzing(true);
    try {
      const [backBlob, frontBlob] = await Promise.all([
        compressImage(backImage),
        frontImage ? compressImage(frontImage) : Promise.resolve(null),
      ]);
      timing.compressDoneAt = performance.now();
      console.log(
        `[holo-timing] compress complete +${(timing.compressDoneAt - timing.clickedAt).toFixed(0)}ms`,
      );

      const formData = new FormData();
      formData.append("backImage", backBlob, "back.jpg");
      if (frontBlob) formData.append("frontImage", frontBlob, "front.jpg");
      if (scanIdRef.current) formData.append("scanId", scanIdRef.current);
      // Mint (or reuse) a client UUID for the audit row. Letting the
      // client own the id means the server can fire-and-forget the
      // user_scans INSERT and we still know how to update it on save.
      if (!userScanIdRef.current) userScanIdRef.current = mintScanId();
      formData.append("userScanId", userScanIdRef.current);

      timing.requestSentAt = performance.now();
      console.log(
        `[holo-timing] request sent +${(timing.requestSentAt - timing.clickedAt).toFixed(0)}ms`,
      );
      const response = await fetch("/api/analyze-card-dual-images", {
        method: "POST",
        body: formData,
      });
      timing.responseReceivedAt = performance.now();
      console.log(
        `[holo-timing] response received +${(timing.responseReceivedAt - timing.clickedAt).toFixed(0)}ms ` +
          `(network+server: ${(timing.responseReceivedAt - timing.requestSentAt).toFixed(0)}ms)`,
      );
      // Beta scan cap: surface a friendly message + bail before parsing
      // the body. The server returns { error: 'limit_reached', limit, used }
      // which we don't need to display — the TopBar usage pill already
      // renders the numbers, so the toast just needs to explain *why*.
      if (response.status === 429) {
        toast({
          title: "Beta scan limit reached",
          description:
            "You've used all your beta scans. Reach out to the dev to bump your quota.",
          variant: "destructive",
        });
        // Refresh quota so the header pill flips to red immediately.
        queryClient.invalidateQueries({ queryKey: ["/api/user/scan-quota"] });
        return;
      }
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

      // Prefer the server's echo (covers older clients that didn't send a
      // userScanId), but fall back to the client-minted ref so the save
      // path can still promote the analyzed_no_save row even if the server
      // omits the field. Accept either int (legacy) or string (post-QW-1).
      const echoedScanId = result._userScanId;
      const resolvedUserScanId: number | string | null =
        typeof echoedScanId === 'number' || (typeof echoedScanId === 'string' && echoedScanId.length > 0)
          ? echoedScanId
          : userScanIdRef.current;

      reset();
      scanIdRef.current = null;
      userScanIdRef.current = null;
      setAll({
        frontImage,
        backImage,
        cardData: result.data,
        holoGrade: (result.data.holo as HoloGrade) ?? null,
        // Audit-row id from analyze; threaded into _scanTracking._userScanId
        // on save so the row is promoted in place rather than duplicated.
        userScanId: resolvedUserScanId,
      });
      // Recent Scans (Home), Collection, and Stats all read from
      // /api/scan-grades. The shared queryClient uses staleTime: Infinity,
      // so without an explicit invalidation the carousel never refetches
      // after a scan and stays stuck on whatever was cached at first load.
      // Invalidate both keyed variants (Home uses { limit: 8 }, Collection
      // uses { limit: 100 }, Stats uses a fixed URL) — passing just the
      // prefix matches all three.
      queryClient.invalidateQueries({ queryKey: ["/api/scan-grades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-grades?limit=100"] });
      // Bump the header usage pill in lock-step with the server-side count.
      queryClient.invalidateQueries({ queryKey: ["/api/user/scan-quota"] });
      timing.navigateAt = performance.now();
      console.log(
        `[holo-timing] navigate(/result) +${(timing.navigateAt - timing.clickedAt).toFixed(0)}ms ` +
          `(json parse+state: ${(timing.navigateAt - timing.responseReceivedAt).toFixed(0)}ms)`,
      );
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
          {mode === "voice" ? "Describe a card" : "Scan a card"}
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          {mode === "voice"
            ? "Speak the card details — we'll transcribe and price it."
            : "Capture the front and back to identify, grade, and price."}
        </p>
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
