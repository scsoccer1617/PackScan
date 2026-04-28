// Scan result page — /result
//
// Reads the cardData + holoGrade produced by /scan from the ScanFlow
// context and drives the rest of the flow: collection picker, parallel
// picker, HoloGrade display, graded price breakdown, eBay comps, and
// Add-to-GSheet. Redirects back to /scan if the user lands here cold
// with no result in memory.
//
// Tabs follow the redesigned mobile IA:
//   1. Details  (default — card info + scanned images)
//   2. Grade    (HoloGrade only)
//   3. Price    (graded price breakdown + eBay active listings)

import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useScanFlow } from "@/hooks/use-scan-flow";
import { formatSeasonYear } from "@/lib/seasonYear";
import { useToast } from "@/hooks/use-toast";
import { usePreferences } from "@/hooks/use-preferences";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import EbayActiveComps from "@/components/EbayActiveComps";
import { HoloGradeCard } from "@/components/HoloGradeCard";
import GradedPriceBreakdown from "@/components/GradedPriceBreakdown";
import CatalogPriceStrip from "@/components/CatalogPriceStrip";
import PsaGradeSelect from "@/components/PsaGradeSelect";
import AddToSheetButton, {
  type ScanFieldSnapshot,
  type ScanTracking,
  type ScanUserAction,
} from "@/components/AddToSheetButton";
import ParallelPickerSheet, {
  type ParallelOption,
} from "@/components/ParallelPickerSheet";
import GeminiParallelPickerSheet from "@/components/GeminiParallelPickerSheet";
import CollectionPickerSheet, {
  type CollectionCandidate,
} from "@/components/CollectionPickerSheet";
import { Camera, Check, Loader2, ScanLine, ScanSearch, Sparkles, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CardFormValues } from "@shared/schema";
import {
  extractSerialLimit,
  extractKeyword,
  fetchParallels,
  filterByKeyword,
  filterBySerialNumber,
  filterBySerialStatus,
  mergePreferringPrimary,
} from "@/lib/scanFlow";
import { useScpParallels } from "@/hooks/use-scp-parallels";

/** Palette tone helper for the grade chip — maps numeric grade → token bg/text. */
function gradeTone(grade: number): { bg: string; text: string; ring: string } {
  if (grade >= 9.5) return { bg: "bg-foil-gold/15", text: "text-foil-gold", ring: "ring-foil-gold/40" };
  if (grade >= 9) return { bg: "bg-foil-violet/15", text: "text-foil-violet", ring: "ring-foil-violet/40" };
  if (grade >= 8) return { bg: "bg-foil-cyan/15", text: "text-foil-cyan", ring: "ring-foil-cyan/40" };
  if (grade >= 6) return { bg: "bg-foil-green/15", text: "text-foil-green", ring: "ring-foil-green/40" };
  return { bg: "bg-foil-amber/15", text: "text-foil-amber", ring: "ring-foil-amber/40" };
}

/** "Lance Lynn" display from first+last (either may be missing). */
function playerName(c: Partial<CardFormValues> | null): string {
  if (!c) return "";
  return [c.playerFirstName, c.playerLastName].filter(Boolean).join(" ").trim();
}

/**
 * Project a CardFormValues blob down to the ScanFieldSnapshot shape used
 * by the user-scans logger. We only carry fields the scan-result screen
 * has visibility into; CardFormValues fields not present here (e.g.
 * speculativeCatalog) are intentionally dropped — they're scan-pipeline
 * scratch state, not card identity.
 */
function snapshotFromCardData(c: Partial<CardFormValues>): ScanFieldSnapshot {
  return {
    sport: c.sport ?? null,
    playerFirstName: c.playerFirstName ?? null,
    playerLastName: c.playerLastName ?? null,
    brand: c.brand ?? null,
    collection: c.collection ?? null,
    set: (c as { set?: string | null }).set ?? null,
    cardNumber: c.cardNumber ?? null,
    year: typeof c.year === 'number' ? c.year : (c.year ? Number.parseInt(String(c.year), 10) || null : null),
    variant: c.variant ?? null,
    team: (c as { team?: string | null }).team ?? null,
    cmpNumber: (c as { cmpNumber?: string | null }).cmpNumber ?? null,
    serialNumber: c.serialNumber ?? null,
    foilType: c.foilType ?? null,
    isRookie: c.isRookieCard ?? null,
    isAuto: c.isAutographed ?? null,
    isNumbered: c.isNumbered ?? null,
    isFoil: null,
  };
}

export default function ScanResult() {
  const [, navigate] = useLocation();
  const flow = useScanFlow();
  const { toast } = useToast();

  // Picker + processing state is owned locally — it's only meaningful
  // while this page is mounted.
  const [showParallelPicker, setShowParallelPicker] = useState(false);
  // Gemini-authority picker (PR #162). Opens whenever the analyze response
  // includes a `_gemini` payload, regardless of whether Gemini emitted a
  // parallel — the dealer can confirm Yes / No or freetext-type a name.
  const [showGeminiPicker, setShowGeminiPicker] = useState(false);
  const [showParallelConfirm, setShowParallelConfirm] = useState(false);
  // Two-step "No" flow: when the user disagrees with the detected
  // colour we ask whether the card is a parallel at all, instead of
  // immediately saving as base. "reject" is the secondary state shown
  // after No is tapped on the colour-specific prompt.
  const [parallelConfirmStage, setParallelConfirmStage] = useState<
    "detected" | "reject"
  >("detected");
  const [parallelOptions, setParallelOptions] = useState<ParallelOption[]>([]);
  // Picker mode: when true the picker title is generic ("Which parallel
  // is this?") and the keyword-preselect is skipped — used after the
  // user rejects the detected colour and asks to see all parallels.
  const [pickerShowAllMode, setPickerShowAllMode] = useState(false);
  // Unfiltered list of every parallel for this card, captured the first
  // time fetchParallels runs in runPostScanFlow. Used by the "show all
  // parallels" branch of the No-flow so the user can pick across
  // colours / serialised tiers when our colour detection was wrong.
  // Serialised-only sets stay serialised-only because that's a property
  // of the catalogue, not of the colour filter.
  const allParallelsRef = useRef<ParallelOption[]>([]);
  // SCP-backed parallel discovery. Called in STEP 3 before the local-DB
  // "show everything" fallback — filters by Holo's detected color so the
  // picker only surfaces parallels that SCP actually has for this card.
  const scpParallels = useScpParallels();
  const [detectedKeyword, setDetectedKeyword] = useState("");
  const [showCollectionPicker, setShowCollectionPicker] = useState(false);
  const [collectionCandidates, setCollectionCandidates] = useState<CollectionCandidate[]>([]);
  const [showPriceResults, setShowPriceResults] = useState(false);

  // True while runPostScanFlow is doing async parallel discovery
  // (fetchParallels round-trip + SCP /catalog/parallels lookup). Drives
  // the inline "Checking for parallels…" banner and the subtle shimmer
  // accent under the sticky hero so the user can tell processing isn't
  // finished even though card-info has already rendered. Cleared the
  // moment we either show pricing or open a confirm/picker prompt.
  const [isCheckingParallels, setIsCheckingParallels] = useState(false);

  // Tracks whether we already gave the user a moment to let the analyze
  // payload commit into context before considering a redirect. Avoids a
  // race where /result mounts on the same microtask that set the data,
  // briefly sees hasResult=false, and bounces back to /scan.
  const [bootChecked, setBootChecked] = useState(false);

  // Latest pricing result bubbled up from EbayPriceResults. Drives the
  // avg-asking-price subtitle under the player name in the sticky hero
  // and the ebaySearchUrl payload on the compact Add-to-Sheet button
  // (so when the user taps Add-to-Sheet in the hero we include the same
  // eBay link that Price-tab listings are built from).
  const [priceInfo, setPriceInfo] = useState<{
    averageValue: number;
    dataType: 'sold' | 'current';
    searchUrl: string | null;
  } | null>(null);

  // Once the user has answered the "Is this a parallel?" prompt (Yes opens
  // the picker; No prices as base), we must NOT re-prompt even if the
  // in-flight runPostScanFlow later hits a `setShowParallelConfirm(true)`
  // branch. A ref — not state — is required because runPostScanFlow is an
  // async closure captured when the effect fired, so a useState latch
  // wouldn't be visible to it after the user taps Yes/No mid-flight.
  const parallelDecidedRef = useRef(false);

  const cardData = flow.cardData;
  const holoGrade = flow.holoGrade;
  const frontImage = flow.frontImage;
  const backImage = flow.backImage;

  // ── Diagnostic timing markers ────────────────────────────────────────
  // Picks up the timestamp set by Scan.tsx and logs how long it took
  // for the result page to actually mount and for the picker confirm /
  // sheet to surface. The user reports a few-second gap between results
  // rendering and the picker appearing — these markers prove or
  // disprove that.
  const timingRef = useRef<{ confirmLogged: boolean; pickerLogged: boolean }>({
    confirmLogged: false,
    pickerLogged: false,
  });
  useEffect(() => {
    const t = (window as any).__holoScanTiming;
    if (t && typeof t.clickedAt === 'number') {
      const elapsed = performance.now() - t.clickedAt;
      console.log(`[holo-timing] /result mounted +${elapsed.toFixed(0)}ms`);
    }
  }, []);
  useEffect(() => {
    const t = (window as any).__holoScanTiming;
    if (!t || typeof t.clickedAt !== 'number') return;
    if (showParallelConfirm && !timingRef.current.confirmLogged) {
      timingRef.current.confirmLogged = true;
      const elapsed = performance.now() - t.clickedAt;
      console.log(`[holo-timing] parallel-confirm shown +${elapsed.toFixed(0)}ms`);
    }
    if (showParallelPicker && !timingRef.current.pickerLogged) {
      timingRef.current.pickerLogged = true;
      const elapsed = performance.now() - t.clickedAt;
      console.log(`[holo-timing] parallel-picker shown +${elapsed.toFixed(0)}ms`);
    }
  }, [showParallelConfirm, showParallelPicker]);

  // ——— Scan-feedback (👍 / 👎) state ———
  //
  // `feedback` tracks what the user clicked on the Card-info section header.
  //   - 'none'             → user hasn't expressed a preference. A subsequent
  //                          Add-to-Sheet press logs as 'saved_no_feedback'.
  //   - 'confirmed'        → 👍. Add-to-Sheet logs as 'confirmed' and the diff
  //                          is forced to [].
  //   - 'declined_edited'  → 👎. Opens the inline edit panel; subsequent
  //                          Add-to-Sheet logs as 'declined_edited' with the
  //                          per-field diff captured server-side.
  //
  // `initialDetected` is the snapshot of cardData *as the scanner returned
  // it* before any user edits or picker selections. We freeze it on the
  // first render where cardData is non-null and re-freeze whenever a brand
  // new scan starts (signaled by a change in `frontImage`). Editing or
  // picker changes mutate flow.cardData but must NOT update this snapshot —
  // it's the "detected" baseline the diff measures against.
  const [feedback, setFeedback] = useState<ScanUserAction | 'none'>('none');
  const [initialDetected, setInitialDetected] = useState<ScanFieldSnapshot | null>(null);
  const lastFrontImageRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!cardData) return;
    // New scan session = new frontImage. Reset feedback + re-snapshot
    // the detected fields. Also covers the very first mount (ref starts
    // undefined, so any frontImage triggers the snapshot path).
    if (lastFrontImageRef.current !== frontImage) {
      lastFrontImageRef.current = frontImage;
      setFeedback('none');
      setInitialDetected(snapshotFromCardData(cardData));
    } else if (initialDetected === null) {
      // Same session but we never managed to snapshot (e.g. cardData was
      // null on first mount). Capture now so the diff has a baseline.
      setInitialDetected(snapshotFromCardData(cardData));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardData, frontImage]);

  const scanTracking: ScanTracking | undefined = cardData
    ? {
        userAction: feedback === 'none' ? 'saved_no_feedback' : feedback,
        // Promote the analyze-time audit row instead of inserting a new one.
        // Falls back to a fresh insert server-side when null.
        _userScanId: flow.userScanId ?? undefined,
      }
    : undefined;

  // Reset the priceInfo cache whenever the underlying card data changes
  // so the hero doesn't briefly show a stale avg price for the previous
  // query while the new lookup is in flight.
  useEffect(() => {
    setPriceInfo(null);
  }, [cardData?.cardNumber, cardData?.foilType, cardData?.variant, cardData?.serialNumber, cardData?.brand, cardData?.year]);

  // If the user hit /result directly (deep link, refresh, back-button from
  // outside the app) without an analyze in memory, bounce to /scan. We
  // wait one tick first to let analyze-side state commits settle, so a
  // momentary hasResult=false on mount doesn't kick a valid scan back.
  useEffect(() => {
    console.log("[ScanResult] mount-check", { hasResult: flow.hasResult });
    if (flow.hasResult) {
      setBootChecked(true);
      return;
    }
    const t = setTimeout(() => {
      if (!flow.hasResult) {
        console.warn("[ScanResult] no result after 120ms — redirecting to /scan");
        navigate("/scan", { replace: true });
      }
      setBootChecked(true);
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.hasResult]);

  // Run the post-analyze disambiguation flow once when the result first
  // lands. Re-runs whenever the caller swaps cardData out (e.g. after a
  // collection/parallel pick or a user edit that changes the serial).
  useEffect(() => {
    if (!cardData) return;
    // Resetting both flags first avoids flashing stale eBay results while
    // we decide which prompt (if any) to show. We deliberately keep
    // showParallelPicker as-is when a decision has been recorded: tapping
    // Yes opens the picker AND updates cardData, which re-runs this
    // effect — so clearing the picker flag here would close it on the
    // same tick as opening it.
    setShowPriceResults(false);
    // If the user already answered Yes/No for this card, don't reset the
    // picker/confirm flags on the same tick that Yes opened the picker.
    if (!parallelDecidedRef.current) {
      setShowParallelConfirm(false);
      setShowParallelPicker(false);
    }
    setShowCollectionPicker(false);
    // Surface progress: every async branch in runPostScanFlow ends by
    // either showing a confirm/picker prompt OR flipping showPriceResults
    // — both transitions clear isCheckingParallels via the wrapped
    // setters below, so we just need to flag "true" at the start.
    setIsCheckingParallels(true);
    runPostScanFlow(cardData)
      .catch((err) => {
        // fetchParallels or any downstream helper failed — don't leave the
        // page stuck in its pre-price state. Fall through to showing eBay
        // prices with whatever OCR gave us so the user sees *something*.
        console.error("[ScanResult] Post-scan flow threw, falling back:", err);
        toast({
          title: "Couldn't look up parallels",
          description: "Showing prices for the detected card instead.",
        });
        setShowPriceResults(true);
      })
      .finally(() => {
        // Belt-and-suspenders: even if a future branch forgets to call a
        // wrapped setter, the banner won't get stuck after the flow
        // resolves.
        setIsCheckingParallels(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardData]);

  // Surface the result of a "connect-and-add" Google sheet flow on return.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("sheetAdded")) {
      toast({ title: "Saved to Google Sheet", description: "Your card was added after connecting Google." });
      params.delete("sheetAdded");
      const search = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (search ? `?${search}` : ""));
    } else if (params.has("sheetAddFailed")) {
      toast({ title: "Could not save card after connecting", description: "Please try Add to GSheet again.", variant: "destructive" });
      params.delete("sheetAddFailed");
      const search = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (search ? `?${search}` : ""));
    }
  }, [toast]);

  /**
   * Same staged disambiguation flow as the original PriceLookup:
   *  Step 0 — collection ambiguity (multiple sets share brand+year+#)
   *  Step 1 — serial limit exact match
   *  Step 2 — keyword + serial-status match
   *  Step 3 — visual detector saw foil but no keyword hit
   *  Step 4 — `parallelSuspected` fallback with no color detected
   */
  // Wrap setShowParallelConfirm so any branch in runPostScanFlow that
  // wants to open the confirm card becomes a no-op after the user has
  // already answered Yes/No. Critical because fetchParallels is async
  // and may resolve after the user has tapped.
  //
  // Returns true when the caller should STOP (confirm was shown) and
  // false when the caller should fall through (confirm was suppressed
  // because the user already decided). Without a return value, every
  // branch that calls this and returns early leaves the flow stuck —
  // showPriceResults never flips to true, and the UI sits on
  // "Looking up pricing…" forever. See Alex Vesia Rainbow→Diamante Foil
  // repro where the second pass of runPostScanFlow hit STEP 2's ">=2"
  // branch, tried to re-prompt, got suppressed, and never priced.
  const requestShowParallelConfirm = (value: boolean): boolean => {
    if (value && parallelDecidedRef.current) {
      console.log("[ScanResult] skip re-prompt, user already decided");
      // User already decided — the caller falls through to pricing, so
      // the banner is no longer relevant. Clearing here avoids leaving
      // the shimmer on while the next setShowPriceResults(true) runs.
      setIsCheckingParallels(false);
      return false;
    }
    if (value) {
      // A prompt is about to render — user can take the next action.
      // Stop the "checking" affordance immediately rather than waiting
      // for the .finally() above (which fires after the await chain).
      setIsCheckingParallels(false);
    }
    setShowParallelConfirm(value);
    return value;
  };

  const runPostScanFlow = async (data: Partial<CardFormValues>) => {
    console.log("[ScanResult] runPostScanFlow", {
      brand: data.brand,
      year: data.year,
      foilType: data.foilType,
      serialNumber: data.serialNumber,
      isNumbered: data.isNumbered,
      parallelSuspected: (data as any).parallelSuspected,
      collectionAmbiguous: (data as any)._collectionAmbiguous,
    });
    const collAmbig = (data as any)._collectionAmbiguous;
    const collCands = (data as any)._collectionCandidates as CollectionCandidate[] | undefined;
    if (collAmbig && collCands && collCands.length > 1) {
      setCollectionCandidates(collCands);
      setShowCollectionPicker(true);
      return;
    }

    // PR #162: Gemini-authority picker shortcut. When the analyze response
    // carried a `_gemini` payload (the VLM ran), trust its parallel reading
    // and route the dealer through the two-step Gemini picker instead of
    // the legacy SCP/variationsDB ladder. The picker handles both the
    // "Gemini emitted a parallel" and "Gemini said base / nothing" cases.
    const geminiPayload = (data as any)._gemini;
    if (geminiPayload && !parallelDecidedRef.current) {
      setIsCheckingParallels(false);
      setShowGeminiPicker(true);
      return;
    }

    const detected = data.foilType?.trim() || "";
    const detectedSerial = data.serialNumber?.trim() || "";
    const isNumberedCard = !!data.isNumbered || /\d+\/\d+/.test(detectedSerial);
    const parallelSuspected = !!(data as any).parallelSuspected;
    // Google Vision's rejected-but-confident colour reading, forwarded from
    // the server when FoilDB gate says "yes there's foil, but I can't confirm
    // *which* colour parallel this is". We don't trust it enough to apply as
    // `foilType`, but it's plenty to ask SCP "what Pink parallels exist for
    // this card?" which collapses a 52-option dump into a 2-option picker.
    const suggestedColor = ((data as any).suggestedColor as string | undefined)?.trim() || "";

    if (!detected && !isNumberedCard && !parallelSuspected) {
      setShowPriceResults(true);
      return;
    }

    if (data.brand && data.year) {
      const allOptions = await fetchParallels(
        data.brand,
        data.year as number,
        data.collection,
        data.set,
      );
      // Cache the full list so the No-flow's "show all parallels" branch
      // can present every option for this card. STEP 1 below filters by
      // serial when the card is serialised; that constraint is a
      // catalogue property, so even in show-all mode we keep it.
      allParallelsRef.current = detectedSerial
        ? filterBySerialNumber(allOptions, detectedSerial)
        : allOptions;

      // STEP 1 — Serial limit match.
      //
      // Note on auto-selects: we apply the picked fields via a functional
      // update (carefully avoiding triggering the effect again) by mutating
      // `data` in place BEFORE calling setCardData + show-prices. Since the
      // effect depends on `cardData`, calling setCardData triggers a rerun
      // — but the rerun will hit this same branch again with the same data
      // and land here, then fall through to setShowPriceResults. To prevent
      // an infinite loop we only call setCardData when something actually
      // changed from what the effect saw on this run.
      const applyAndPrice = (updated: Partial<CardFormValues>) => {
        const changed =
          updated.foilType !== data.foilType ||
          updated.serialNumber !== data.serialNumber ||
          updated.isNumbered !== data.isNumbered;
        if (changed) {
          flow.setCardData(updated);
          return;
        }
        setShowPriceResults(true);
      };

      if (detectedSerial) {
        const bySerial = filterBySerialNumber(allOptions, detectedSerial);
        if (bySerial.length === 1) {
          const match = bySerial[0];
          applyAndPrice({ ...data, foilType: match.variationOrParallel, serialNumber: detectedSerial, isNumbered: true });
          return;
        }
        if (bySerial.length >= 2 && detected) {
          const narrowed = filterByKeyword(bySerial, detected);
          if (narrowed.length === 1) {
            const match = narrowed[0];
            applyAndPrice({ ...data, foilType: match.variationOrParallel, serialNumber: detectedSerial, isNumbered: true });
            return;
          }
          if (narrowed.length >= 2) {
            setParallelOptions(mergePreferringPrimary(narrowed, bySerial));
            setDetectedKeyword(extractKeyword(detected));
            if (requestShowParallelConfirm(true)) return;
            // User already decided — price with what we have.
            setShowPriceResults(true);
            return;
          }
          setParallelOptions(bySerial);
          setDetectedKeyword(extractKeyword(detected));
          if (requestShowParallelConfirm(true)) return;
          setShowPriceResults(true);
          return;
        }
        if (bySerial.length >= 2) {
          setParallelOptions(bySerial);
          setDetectedKeyword("");
          if (requestShowParallelConfirm(true)) return;
          setShowPriceResults(true);
          return;
        }
      }

      // STEP 2 — SCP as the primary parallel source.
      //
      // PR #38b originally wired SCP only as a fallback when local DB
      // returned zero keyword hits. Problem: modern Topps sets have
      // many pink/gold/silver entries in the local DB, so STEP 2's
      // old keyword match would almost always find *something* and
      // short-circuit before SCP ever ran. Result: user sees stale
      // local-DB parallels instead of SCP's authoritative list.
      //
      // New behavior: if we have enough identifying context
      // (brand + year + at least one player name piece) and Holo
      // detected a color/foil, ask SCP first. Local DB becomes the
      // fallback only when SCP errors or returns empty.
      const fullName = [data.playerFirstName, data.playerLastName]
        .filter(Boolean)
        .join(" ")
        .trim();
      const canQueryScp = !!detected && !!data.brand && !!data.year && !!fullName;
      let scpHandled = false;
      if (canQueryScp) {
        try {
          const scpResult = await scpParallels.mutateAsync({
            playerName: fullName,
            year: (data.year as number | null | undefined) ?? null,
            brand: data.brand ?? null,
            collection: data.collection ?? null,
            setName: data.set ?? null,
            cardNumber: data.cardNumber ?? null,
            colorFilter: detected,
          });
          // When the server's colour-bucket filter found ZERO real
          // matches it falls back to returning the unfiltered list
          // (with filterFellBack=true) so the picker isn't empty. But
          // for the colour-detected prompt, filterFellBack=true means
          // "this card has no parallel that matches the detected
          // colour" — exactly the 1991 Donruss #322 John Franco case
          // where Holo reads a Silver tint but the set has no Silver
          // parallel in SCP's catalog. In that situation we must NOT
          // tell the dealer "Detected: Silver — is this a parallel?"
          // because the answer is structurally no. Drop into STEP 2b
          // semantics (unfiltered re-query, no detected-colour copy)
          // so the picker only fires if the card genuinely has 2+
          // parallel variants the dealer might own.
          if (!scpResult.filterFellBack) {
            if (scpResult.parallels.length === 1) {
              // SCP uniquely identified the parallel — auto-apply.
              const only = scpResult.parallels[0];
              applyAndPrice({ ...data, foilType: only.label });
              return;
            }
            if (scpResult.parallels.length >= 2) {
              // SCP returned multiple colour-matched candidates — show
              // SCP-shaped picker. SCP doesn't expose per-parallel
              // serial limits, so leave serialNumber null — the picker
              // will accept custom serials.
              const scpOptions: ParallelOption[] = scpResult.parallels.map((p) => ({
                variationOrParallel: p.label,
                serialNumber: null,
              }));
              setParallelOptions(scpOptions);
              setDetectedKeyword(extractKeyword(detected));
              if (requestShowParallelConfirm(true)) return;
              setShowPriceResults(true);
              return;
            }
          }

          // STEP 2b — SCP returned 0 with the color/tier filter applied.
          //
          // This typically means Holo's detected value is wrong for this
          // set (e.g. "Refractor" on a Topps flagship card, where no
          // Refractors exist). Don't silently price with a bad label —
          // retry SCP with NO color filter so the user sees the real
          // parallel universe for this exact card and can pick manually.
          const scpUnfiltered = await scpParallels.mutateAsync({
            playerName: fullName,
            year: (data.year as number | null | undefined) ?? null,
            brand: data.brand ?? null,
            collection: data.collection ?? null,
            setName: data.set ?? null,
            cardNumber: data.cardNumber ?? null,
            colorFilter: null,
          });
          if (scpUnfiltered.parallels.length >= 2) {
            const scpOptions: ParallelOption[] = scpUnfiltered.parallels.map((p) => ({
              variationOrParallel: p.label,
              serialNumber: null,
            }));
            setParallelOptions(scpOptions);
            // Clear the detected keyword — we're showing the full list
            // because the Holo-detected value didn't match SCP. Don't
            // pre-highlight the wrong word in the picker.
            setDetectedKeyword("");
            if (requestShowParallelConfirm(true)) return;
            setShowPriceResults(true);
            return;
          }

          // Truly no SCP parallels at all for this card — fall through.
          scpHandled = true;
        } catch (err) {
          // SCP unreachable or threw — fall through to local DB.
          console.warn("[ScanResult] SCP parallel discovery failed:", err);
        }
      }

      // STEP 3 — Local DB keyword + serialization-status match
      // (fallback when SCP errored, returned empty, or we lacked
      // enough context to query SCP).
      const byKeyword = filterByKeyword(allOptions, detected);
      const filtered = filterBySerialStatus(byKeyword, !!detectedSerial && !!data.isNumbered);
      if (filtered.length === 1) {
        const allForStatus = filterBySerialStatus(allOptions, !!detectedSerial && !!data.isNumbered);
        if (allForStatus.length <= 1) {
          const match = filtered[0];
          const updated: Partial<CardFormValues> = { ...data, foilType: match.variationOrParallel };
          if (match.serialNumber) {
            const limit = match.serialNumber.replace(/\//g, "");
            updated.serialNumber = detectedSerial && /\d+\s*\/\s*\d+/.test(detectedSerial) ? detectedSerial : `/${limit}`;
            updated.isNumbered = true;
          }
          applyAndPrice(updated);
          return;
        }
        setParallelOptions(mergePreferringPrimary(filtered, allForStatus));
        setDetectedKeyword(extractKeyword(detected));
        if (requestShowParallelConfirm(true)) return;
        setShowPriceResults(true);
        return;
      }
      if (filtered.length >= 2) {
        const allForStatus = filterBySerialStatus(allOptions, !!detectedSerial && !!data.isNumbered);
        setParallelOptions(mergePreferringPrimary(filtered, allForStatus));
        setDetectedKeyword(extractKeyword(detected));
        if (requestShowParallelConfirm(true)) return;
        setShowPriceResults(true);
        return;
      }

      // STEP 3b — detected but 0 local DB keyword hits AND either we
      // couldn't query SCP or SCP came back empty. Last-resort: show
      // every local parallel we know about so the user can pick manually.
      if (filtered.length === 0 && detected && !scpHandled) {
        const allForStatus = filterBySerialStatus(allOptions, !!detectedSerial && !!data.isNumbered);
        if (allForStatus.length >= 2) {
          setParallelOptions(allForStatus);
          setDetectedKeyword(extractKeyword(detected));
          if (requestShowParallelConfirm(true)) return;
          setShowPriceResults(true);
          return;
        }
      }

      // STEP 4 — parallelSuspected with no keyword/serial.
      //
      // Before falling back to the local-DB "everything we have" dump, give
      // SCP a shot with the Vision-suggested colour as a filter. When the
      // server attaches `suggestedColor` (e.g. "Pink Foil" from a rejected
      // FoilDB gate) we have a strong directional hint even though the
      // server declined to stamp it as the authoritative `foilType`. Asking
      // SCP for "Pink parallels of this card" collapses a 50+ option dump
      // into just the matching-colour parallels — exactly what the picker
      // should surface. If SCP returns nothing or we lack context, we fall
      // through to the pre-existing local-DB fallback.
      if (parallelSuspected && !detected && !detectedSerial) {
        const canQueryScpForSuggested =
          !!data.brand && !!data.year && !!fullName;
        let step4ScpReturnedSomething = false;
        if (canQueryScpForSuggested) {
          try {
            // First attempt: filter by Vision's suggested colour when we
            // have one. This collapses a 50+ parallel dump to the 1-2
            // plausible options for Petersen-style cards where Vision
            // reads a real colour.
            const scpSuggested = suggestedColor
              ? await scpParallels.mutateAsync({
                  playerName: fullName,
                  year: (data.year as number | null | undefined) ?? null,
                  brand: data.brand ?? null,
                  collection: data.collection ?? null,
                  setName: data.set ?? null,
                  cardNumber: data.cardNumber ?? null,
                  colorFilter: suggestedColor,
                })
              : null;

            // Same filterFellBack gate as STEP 2: when the server's
            // colour filter found ZERO real matches it returns the
            // unfiltered list with filterFellBack=true. Treat that as
            // "no real colour-matched parallel exists for this card"
            // and skip the colour-detected picker; we'll fall through
            // to the unfiltered re-query below, which clears the
            // detected keyword so we don't mislead the dealer with a
            // colour Vision guessed but the catalog doesn't support.
            if (scpSuggested && !scpSuggested.filterFellBack) {
              if (scpSuggested.parallels.length >= 2) {
                // Multiple colour-matched SCP parallels — always show
                // the picker. (We no longer auto-apply on length===1
                // here: Vision's colour reading on rainbow/holo cards
                // is unreliable enough that the dealer should always
                // get a chance to see the full colour-bucketed
                // options.)
                const scpOptions: ParallelOption[] = scpSuggested.parallels.map((p) => ({
                  variationOrParallel: p.label,
                  serialNumber: null,
                }));
                setParallelOptions(scpOptions);
                setDetectedKeyword(extractKeyword(suggestedColor));
                step4ScpReturnedSomething = true;
                if (requestShowParallelConfirm(true)) return;
                setShowPriceResults(true);
                return;
              }
              if (scpSuggested.parallels.length === 1) {
                // Single colour match — still show picker (with the
                // matched label pre-selected by virtue of being the
                // only option) so the dealer can override to "Other".
                const scpOptions: ParallelOption[] = scpSuggested.parallels.map((p) => ({
                  variationOrParallel: p.label,
                  serialNumber: null,
                }));
                setParallelOptions(scpOptions);
                setDetectedKeyword(extractKeyword(suggestedColor));
                step4ScpReturnedSomething = true;
                if (requestShowParallelConfirm(true)) return;
                setShowPriceResults(true);
                return;
              }
            }

            // Either no suggestedColor at all, or the colour filter
            // returned zero. Retry UNFILTERED so the dealer sees the
            // real parallel universe for this exact card. This is the
            // Ohtani ASG-1 path: Vision read "Green Crackle Foil" (a
            // misread of Rainbow Foil shimmer); the coloured query
            // finds 0 matches, but the unfiltered query returns all 9
            // ASG-1 parallels — exactly what the picker should show.
            const scpUnfiltered = await scpParallels.mutateAsync({
              playerName: fullName,
              year: (data.year as number | null | undefined) ?? null,
              brand: data.brand ?? null,
              collection: data.collection ?? null,
              setName: data.set ?? null,
              cardNumber: data.cardNumber ?? null,
              colorFilter: null,
            });
            if (scpUnfiltered.parallels.length >= 1) {
              const scpOptions: ParallelOption[] = scpUnfiltered.parallels.map((p) => ({
                variationOrParallel: p.label,
                serialNumber: null,
              }));
              setParallelOptions(scpOptions);
              // Clear the detected keyword — the coloured query missed,
              // so pre-highlighting Vision's (wrong) guess would mislead
              // the dealer.
              setDetectedKeyword("");
              step4ScpReturnedSomething = true;
              if (requestShowParallelConfirm(true)) return;
              setShowPriceResults(true);
              return;
            }
          } catch (err) {
            console.warn("[ScanResult] STEP 4 SCP lookup failed:", err);
          }
        }

        // Last resort: SCP unreachable or truly returned nothing for
        // this card. Fall back to the local DB so the dealer still has
        // *some* options to pick from.
        if (!step4ScpReturnedSomething) {
          const allForStatus = filterBySerialStatus(allOptions, !!detectedSerial && !!data.isNumbered);
          if (allForStatus.length >= 1) {
            setParallelOptions(allForStatus);
            setDetectedKeyword(suggestedColor ? extractKeyword(suggestedColor) : "");
            if (requestShowParallelConfirm(true)) return;
            setShowPriceResults(true);
            return;
          }
        }
      }
    }

    // 0 DB matches — use the OCR-detected value as-is.
    console.log("[ScanResult] flow fell through to setShowPriceResults(true)");
    setShowPriceResults(true);
  };

  const handleCollectionConfirm = (picked: CollectionCandidate) => {
    setShowCollectionPicker(false);
    setCollectionCandidates([]);
    if (!cardData) return;
    const next: any = {
      ...cardData,
      collection: picked.collection,
      set: picked.set || picked.collection,
      brand: picked.brand,
      year: picked.year,
      cardNumber: picked.cardNumber,
      isRookieCard: picked.isRookieCard,
    };
    const parts = (picked.playerName || "").trim().split(/\s+/);
    if (parts.length >= 2) {
      next.playerFirstName = parts[0];
      next.playerLastName = parts.slice(1).join(" ");
    } else if (parts.length === 1 && parts[0]) {
      next.playerLastName = parts[0];
    }
    delete next._collectionAmbiguous;
    delete next._collectionCandidates;
    flow.setCardData(next);
  };

  // PR #162: Gemini picker confirmation handler. The dealer either accepted
  // Gemini's parallel ("Yes"), typed a freetext value, or left it blank for
  // base. Empty string ⇒ base card. Persist onto cardData.foilType + variant
  // and flip to pricing.
  const handleGeminiPickerConfirm = (parallel: string) => {
    if (!cardData) return;
    parallelDecidedRef.current = true;
    setShowGeminiPicker(false);
    const updated: Partial<CardFormValues> = {
      ...cardData,
      foilType: parallel,
      variant: parallel,
    };
    flow.setCardData(updated);
    setShowPriceResults(true);
  };

  const handleParallelConfirm = (foilType: string, serialNumber?: string) => {
    if (!cardData) return;
    // The user explicitly picked this parallel in the sheet — treat their
    // label as ground truth for downstream eBay searches. Set BOTH foilType
    // (for back-compat with existing pricing code) AND variant (the field
    // the server-side getEbaySearchUrl prefers) so the picked name actually
    // makes it into the eBay query.
    const updated: Partial<CardFormValues> = {
      ...cardData,
      foilType,
      variant: foilType || "",
    };
    if (serialNumber) {
      const limit = serialNumber.replace(/\//g, "");
      const existing = (cardData.serialNumber || "").trim();
      updated.serialNumber = /\d+\s*\/\s*\d+/.test(existing) ? existing : `/${limit}`;
      updated.isNumbered = true;
    }
    setShowParallelPicker(false);
    // Directly price with the picked parallel (skip re-running the flow).
    flow.setCardData(updated);
    setShowPriceResults(true);
  };

  const handleParallelConfirmYes = () => {
    parallelDecidedRef.current = true;
    setShowParallelConfirm(false);
    setParallelConfirmStage("detected");
    setPickerShowAllMode(false);
    setShowParallelPicker(true);
  };

  // First No press: switch the modal to "Is this card a parallel?"
  // instead of immediately saving as base. Two-step flow keeps the user
  // in the parallel-picking context when our colour detection was wrong
  // but the card is still a parallel — previous behaviour collapsed
  // "wrong colour" and "not a parallel" into the same path and lost any
  // chance to reach the right parallel.
  const handleParallelConfirmNo = () => {
    setParallelConfirmStage("reject");
  };

  // Secondary No: confirmed not a parallel — save as base.
  const handleParallelRejectConfirmNo = () => {
    if (!cardData) return;
    parallelDecidedRef.current = true;
    setShowParallelConfirm(false);
    setShowParallelPicker(false);
    setParallelOptions([]);
    setDetectedKeyword("");
    setParallelConfirmStage("detected");
    setShowPriceResults(true);
    // Clear the OCR-detected foil so the downstream flow doesn't ask
    // again and eBay searches run against the base card.
    flow.setCardData({ ...cardData, foilType: "" });
  };

  // Secondary Yes: it IS a parallel but we got the colour wrong — open
  // the picker without a colour filter so the user can pick across all
  // available parallels for this card. Serialised-only sets stay
  // serialised-only because that's a catalogue property, not a colour
  // filter (the unfiltered list already reflects whichever serialised /
  // non-serialised universe the card lives in).
  const handleParallelRejectConfirmYes = () => {
    parallelDecidedRef.current = true;
    setShowParallelConfirm(false);
    setParallelConfirmStage("detected");
    if (allParallelsRef.current.length > 0) {
      setParallelOptions(allParallelsRef.current);
    }
    setDetectedKeyword("");
    setPickerShowAllMode(true);
    setShowParallelPicker(true);
  };

  const handleScanAnother = () => {
    parallelDecidedRef.current = false;
    flow.reset();
    navigate("/scan");
  };

  // Persist a full edit of the card fields into the scan flow. The user
  // edits inside the Details tab's Card Info section (see DetailsTab's
  // EditInfoPanel) and on Save we:
  //   1) Log each changed field against /api/scan-corrections for future
  //      Claude prompt tuning — best-effort, never blocks the UI.
  //   2) Update scanFlow.cardData — the main effect on `cardData` kicks
  //      off runPostScanFlow again, which re-queries parallels + eBay
  //      with the corrected values. EbayPriceResults is keyed on those
  //      fields via the pricing query, so the Price tab and the hero
  //      avg-price subtitle both refresh automatically.
  const handleSaveCardInfo = (patch: Partial<CardFormValues>) => {
    if (!cardData) return;
    const before = cardData;
    // Build the merged card in one shot so the effect sees a stable
    // reference change exactly once.
    const next: Partial<CardFormValues> = { ...before, ...patch };
    const fieldsToLog: (keyof CardFormValues)[] = [
      "cardNumber", "playerFirstName", "playerLastName", "year", "brand",
      "collection", "set", "foilType", "variant", "serialNumber",
    ];
    for (const f of fieldsToLog) {
      const oldVal = (before as any)[f] ?? null;
      const newVal = (next as any)[f] ?? null;
      if (String(oldVal ?? "") !== String(newVal ?? "")) {
        try {
          fetch("/api/scan-corrections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              field: f,
              detected: oldVal,
              corrected: newVal,
              brand: next.brand,
              year: next.year,
              collection: next.collection,
              set: (next as any).set,
              playerFirstName: next.playerFirstName,
              playerLastName: next.playerLastName,
            }),
          }).catch(() => {});
        } catch {}
      }
    }
    // Reset the priceInfo so the hero subtitle doesn't flash a stale avg
    // price while the re-priced query is in flight.
    setPriceInfo(null);
    flow.setCardData(next);
  };

  if (!cardData) {
    return (
      <div className="p-6 text-sm text-slate-500">
        {bootChecked ? "No scan in memory — redirecting…" : "Loading scan result…"}
      </div>
    );
  }

  const cardDescription = [
    cardData.year,
    cardData.brand,
    cardData.collection,
    cardData.cardNumber ? `#${cardData.cardNumber}` : undefined,
    playerName(cardData),
  ]
    .filter(Boolean)
    .join(" · ");

  const tone = holoGrade ? gradeTone(holoGrade.overall) : null;

  // Formatted avg label for the hero subtitle. Only shows after the
  // active-comps lookup returns a non-zero average. PR #165: source is
  // the Active eBay listings on the Price tab, so a single "Avg" label
  // covers it — no asking/sold disambiguation when there's one source.
  const avgPriceLabel = priceInfo && priceInfo.averageValue > 0
    ? `Avg ${new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
      }).format(priceInfo.averageValue)}`
    : null;

  return (
    <div className="pb-6">
      {/* Sticky hero — grade, card, actions. Always visible. */}
      <section className="sticky top-14 z-20 bg-paper/95 backdrop-blur border-b border-card-border">
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-start gap-3">
            {tone && holoGrade ? (
              <div
                className={cn(
                  "relative shrink-0 w-20 h-20 rounded-2xl flex flex-col items-center justify-center ring-1 foil-shimmer grade-halo",
                  tone.bg,
                  tone.ring,
                )}
              >
                <span className={cn("font-display font-bold text-3xl leading-none tabular-nums", tone.text)}>
                  {holoGrade.overall}
                </span>
                <span className="text-[10px] text-slate-500 mt-1 font-medium uppercase tracking-wider">
                  {(holoGrade.label || "").replace(/~/g, "")}
                </span>
              </div>
            ) : (
              <div className="shrink-0 w-20 h-20 rounded-2xl flex items-center justify-center bg-slate-100 text-slate-400 ring-1 ring-card-border">
                <ScanSearch className="w-6 h-6" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              {/* Meta line: Year + Brand + Card # (read-only here; the
                  user edits every field through the Edit info panel in
                  the Details tab). */}
              <div className="text-[11px] text-slate-500 uppercase tracking-wider font-medium flex items-center gap-1 flex-wrap">
                <span>
                  {formatSeasonYear(cardData.year, cardData.sport) ?? cardData.year ?? ""} {cardData.brand}
                </span>
                <span className="text-slate-400">·</span>
                <span>#{cardData.cardNumber || "?"}</span>
              </div>
              <h1 className="font-display text-xl font-semibold tracking-tight leading-tight truncate text-ink">
                {playerName(cardData) || "Unidentified card"}
              </h1>
              {avgPriceLabel && (
                <p
                  className="text-xs text-slate-600 font-medium mt-0.5 truncate tabular-nums"
                  data-testid="text-hero-avg-price"
                >
                  {avgPriceLabel}
                </p>
              )}
              {cardData.foilType && (
                <p className="text-xs text-foil-violet font-medium mt-0.5 truncate">
                  {cardData.foilType}
                  {cardData.serialNumber && (
                    <span className="text-slate-500 font-normal"> {cardData.serialNumber}</span>
                  )}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-start justify-end gap-2 mt-3">
            <button
              onClick={handleScanAnother}
              className="h-10 px-4 rounded-xl bg-slate-100 text-ink text-sm font-medium flex items-center gap-1.5 hover-elevate"
              data-testid="button-scan-another"
            >
              <ScanLine className="w-4 h-4" /> Scan another
            </button>
            <AddToSheetButton
              compact
              cardData={cardData}
              averageValue={priceInfo?.averageValue ?? 0}
              searchUrl={priceInfo?.searchUrl || undefined}
              frontImage={frontImage}
              backImage={backImage}
              scanTracking={scanTracking}
              initialDetected={initialDetected ?? undefined}
            />
          </div>
        </div>
        {/* Subtle in-progress shimmer pinned to the bottom edge of the
            sticky hero. Even users who don't scroll past the hero see
            motion that signals "still processing" before the parallel
            prompt appears. Vanishes the moment a confirm/picker opens
            or pricing renders. */}
        {isCheckingParallels &&
          !showPriceResults &&
          !showParallelConfirm &&
          !showParallelPicker &&
          !showCollectionPicker && (
            <div
              className="h-0.5 w-full bg-gradient-to-r from-transparent via-foil-violet to-transparent animate-pulse"
              aria-hidden="true"
              data-testid="hero-checking-shimmer"
            />
          )}
      </section>

      {/* Parallel-confirm prompt (rendered inline so the user can dismiss
          false-positive foil detections without opening the picker).
          Two stages:
            1. "detected"  — "Detected: <colour>. Is this a parallel?"
            2. "reject"    — after No, "Is this card a parallel?" with
                            [Yes, show all parallels] / [No, save as base]
          The reject stage prevents the previous behaviour of conflating
          "wrong colour" with "not a parallel" — a user with a real
          parallel and a mis-detected colour now has a path to the right
          one without scanning the card again. */}
      {showParallelConfirm && parallelConfirmStage === "detected" && (
        <div className="px-4 pt-4">
          <div className="rounded-2xl border border-card-border bg-card p-4 space-y-3">
            <h2 className="font-display text-base font-semibold text-ink flex items-center gap-2">
              <ScanSearch className="w-4 h-4" /> Potential parallel detected
            </h2>
            {cardDescription && <p className="text-sm text-slate-500">{cardDescription}</p>}
            {detectedKeyword && (
              <p className="text-sm text-ink">
                Detected: <span className="font-medium">{detectedKeyword}</span>
              </p>
            )}
            <p className="text-sm text-ink">Is this a parallel?</p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={handleParallelConfirmYes}
                className="h-11 rounded-xl bg-foil text-white font-semibold"
                data-testid="button-parallel-yes"
              >
                Yes
              </button>
              <button
                onClick={handleParallelConfirmNo}
                className="h-11 rounded-xl bg-slate-100 text-ink font-semibold"
                data-testid="button-parallel-no"
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}
      {showParallelConfirm && parallelConfirmStage === "reject" && (
        <div className="px-4 pt-4">
          <div className="rounded-2xl border border-card-border bg-card p-4 space-y-3">
            <h2 className="font-display text-base font-semibold text-ink flex items-center gap-2">
              <ScanSearch className="w-4 h-4" /> Is this card a parallel?
            </h2>
            {cardDescription && <p className="text-sm text-slate-500">{cardDescription}</p>}
            <p className="text-sm text-ink">
              We may have picked the wrong colour. Pick from all parallels
              for this card, or save as base.
            </p>
            <div className="grid grid-cols-1 gap-2">
              <button
                onClick={handleParallelRejectConfirmYes}
                className="h-11 rounded-xl bg-foil text-white font-semibold"
                data-testid="button-parallel-reject-yes"
              >
                Yes, show all parallels
              </button>
              <button
                onClick={handleParallelRejectConfirmNo}
                className="h-11 rounded-xl bg-slate-100 text-ink font-semibold"
                data-testid="button-parallel-reject-no"
              >
                No, save as base
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PR #162 debug overlay: `?debug=1` reveals the raw Gemini JSON the
          server emitted, so we can sanity-check Gemini's parallel/year/brand
          reading against what's on the card without diffing the scan log. */}
      <GeminiDebugPanel cardData={cardData} />

      {/* Picker sheets — controlled here, triggered by post-scan flow */}
      <GeminiParallelPickerSheet
        open={showGeminiPicker}
        geminiParallel={
          (((cardData as any)._gemini?.parallel?.name as string | null | undefined) ?? null)
        }
        cardDescription={cardDescription}
        queryParts={{
          year: cardData.year ?? null,
          brand: cardData.brand ?? null,
          set: (cardData.set as string | undefined) ?? cardData.collection ?? null,
          cardNumber: cardData.cardNumber ?? null,
          player: playerName(cardData) || null,
          parallel: cardData.foilType ?? null,
        }}
        onConfirm={handleGeminiPickerConfirm}
      />
      <ParallelPickerSheet
        open={showParallelPicker}
        detectedLabel={detectedKeyword}
        cardDescription={cardDescription}
        options={parallelOptions}
        onConfirm={handleParallelConfirm}
        showAllMode={pickerShowAllMode}
      />
      <CollectionPickerSheet
        open={showCollectionPicker}
        cardDescription={cardDescription}
        candidates={collectionCandidates}
        onConfirm={handleCollectionConfirm}
      />

      {/* Tabs — three tabs:
            1. Details            (card info + scanned images)
            2. Grade              (Holo grade card only)
            3. Prices / Listings  (graded-tier breakdown + eBay comps)
          Grade is kept separate from pricing so the user can focus on
          the predicted grade + reasoning without the listing noise. */}
      <Tabs defaultValue="details" className="pt-3">
        <TabsList className="mx-4 grid grid-cols-3 bg-slate-100/60">
          <TabsTrigger value="details" data-testid="tab-details">Details</TabsTrigger>
          <TabsTrigger value="grade" data-testid="tab-grade">Grade</TabsTrigger>
          <TabsTrigger value="price" data-testid="tab-price">
            Price
          </TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="mt-4 space-y-3">
          <DetailsTab
            cardData={cardData}
            frontImage={frontImage}
            backImage={backImage}
            onSaveCardInfo={handleSaveCardInfo}
            feedback={feedback}
            onConfirm={() => setFeedback('confirmed')}
            onDecline={() => setFeedback('declined_edited')}
          />
        </TabsContent>

        <TabsContent value="grade" className="mt-4 space-y-4 px-4">
          {holoGrade ? (
            <HoloGradeCard grade={holoGrade} />
          ) : (
            <GradeTabEmptyState />
          )}
        </TabsContent>

        {/*
          forceMount keeps the Price tab content mounted even when it isn't
          the active tab. This is what lets EbayPriceResults kick off its
          eBay fetch as soon as /result loads — without forceMount, Radix
          Tabs unmounts inactive content, so the pricing request wouldn't
          fire until the user tapped the Price tab and they'd see
          "Looking up pricing…" every time they switched over.
          Radix adds the native `hidden` attribute when inactive, so the
          panel stays invisible on Details/Grade but its effects still run.
        */}
        <TabsContent
          value="price"
          forceMount
          className="mt-4 space-y-4 px-4 data-[state=inactive]:hidden"
        >
          {/* SCP / SportsCardsPro catalog strip renders UNCONDITIONALLY.
              Previously this lived inside <GradedPriceBreakdown>, which
              meant SCP was hidden whenever the eBay graded search failed
              or returned null — the user reported seeing "nothing above
              Active Listings" for exactly that reason. CatalogPriceStrip
              has its own internal miss/skeleton handling (returns null on
              SCP miss, so dealers with no SCP coverage see nothing but
              no errors), so it's safe to render without a gate. */}
          <CatalogPriceStrip
            cardData={cardData}
            predictedPsaGrade={
              // Priority: user-entered PSA grade > Holo overall rounded
              // to the nearest integer (8.5 → 9). Highlight only; SCP
              // still renders all catalog tiers when null.
              cardData.psaGrade ??
              (holoGrade?.overall != null && Number.isFinite(holoGrade.overall)
                ? Math.round(holoGrade.overall)
                : null)
            }
            speculativeCatalog={(cardData as any).speculativeCatalog ?? null}
          />
          {(holoGrade || cardData.psaGrade != null) && (
            <GradedPriceBreakdown
              cardData={cardData}
              holoOverall={holoGrade?.overall ?? null}
              userPsaGrade={cardData.psaGrade ?? null}
            />
          )}
          {/* Async parallel-discovery progress. The card-info hero renders
              instantly while runPostScanFlow performs two HTTP round-trips
              (fetchParallels → SCP /catalog/parallels) before deciding
              whether to prompt or price. Without this banner users
              reasonably assumed processing was finished and were
              surprised when the parallel prompt appeared seconds later. */}
          {isCheckingParallels &&
            !showPriceResults &&
            !showParallelConfirm &&
            !showParallelPicker &&
            !showCollectionPicker && (
              <div
                className="rounded-2xl border border-card-border bg-card p-4 flex items-center gap-3 text-sm text-slate-600"
                role="status"
                aria-live="polite"
                data-testid="banner-checking-parallels"
              >
                <Loader2 className="w-4 h-4 animate-spin text-foil-violet shrink-0" />
                <span>Checking for parallels…</span>
              </div>
            )}
          {showPriceResults ? (
            // PR #165: Active eBay listings come from /api/ebay/comps
            // (re-mounted ebayPickerSearch module), keyed off final
            // Gemini fields + the parallel the user picked in the
            // terminal picker. EbayActiveComps owns the listings list
            // AND bubbles the average up to the persistent hero header
            // via setPriceInfo. EbayPriceResults' active-listings path
            // (legacy /api/ebay-search) is no longer mounted here —
            // having two stacked Active sections is what masked the
            // listings in the first place — but the module is left on
            // disk because GradedPriceBreakdown still uses its
            // graded-tier helpers indirectly.
            <EbayActiveComps
              cardData={cardData}
              onAverage={({ average, query }) =>
                setPriceInfo({
                  averageValue: average,
                  // Active-only data source — the hero header label is
                  // just "Avg" now, but we keep the dataType field so
                  // the existing AddToSheet payload doesn't shift shape.
                  dataType: 'current',
                  searchUrl: query
                    ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_BIN=1`
                    : null,
                })
              }
            />
          ) : (
            <div className="rounded-2xl border border-card-border bg-card p-4 text-sm text-slate-500">
              {showParallelConfirm || showParallelPicker || showCollectionPicker
                ? "Answer the prompt above to load pricing."
                : isCheckingParallels
                  /* Suppress the generic "Looking up pricing…" copy while
                     the dedicated checking-parallels banner is visible —
                     two stacked spinners read as redundant. */
                  ? " "
                  : "Looking up pricing…"}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* -------------------- Details tab -------------------- */

function DetailsTab({
  cardData,
  frontImage,
  backImage,
  onSaveCardInfo,
  feedback,
  onConfirm,
  onDecline,
}: {
  cardData: Partial<CardFormValues>;
  frontImage: string;
  backImage: string;
  onSaveCardInfo: (patch: Partial<CardFormValues>) => void;
  /**
   * Current scan-feedback state, owned by the parent so it survives tab
   * switches and travels with the AddToSheetButton's append payload.
   */
  feedback: ScanUserAction | 'none';
  /** Mark the scan as confirmed (👍). Closes the edit panel if open. */
  onConfirm: () => void;
  /** Mark the scan as declined and open the edit panel (👎). */
  onDecline: () => void;
}) {
  const [editing, setEditing] = useState(false);

  // Derived flags so the buttons can show a clear pressed/active state
  // even though the state itself lives in the parent.
  const isConfirmed = feedback === 'confirmed';
  const isDeclined = feedback === 'declined_edited';

  // 👍 handler: close the edit panel if it's open (treat as "nevermind, it's
  // right after all") and tell the parent to flip feedback to confirmed.
  const handleConfirmClick = () => {
    if (editing) setEditing(false);
    onConfirm();
  };

  // 👎 handler: open the edit panel and tell the parent the user wants to
  // correct fields. Tapping 👎 again while already in edit mode is a no-op
  // (the panel is already open and feedback is already 'declined_edited').
  const handleDeclineClick = () => {
    if (!editing) setEditing(true);
    onDecline();
  };

  // Local draft state mirrors the scan flow cardData while the panel is
  // open. Reset from cardData every time the panel opens so cancelling
  // throws the draft away and a re-open always starts from the latest
  // ground truth (e.g. after a parallel picker update).
  const [draft, setDraft] = useState<Partial<CardFormValues>>(cardData);
  useEffect(() => {
    if (editing) setDraft(cardData);
  }, [editing, cardData]);

  const rows: [string, string][] = [
    ["Player", playerName(cardData) || "—"],
    ["Year", formatSeasonYear(cardData.year, cardData.sport) ?? "—"],
    ["Brand", cardData.brand || "—"],
    // Set appears above Collection so the ordering matches the edit form
    // and reads top-down from "where in the product line" → "which box".
    ["Set", cardData.set || "—"],
    ["Collection", cardData.collection || "—"],
    ["Card #", cardData.cardNumber || "—"],
    // CMP code is a manufacturer reference number (e.g. "CMP100358") printed
    // in the fine print on the back of recent cards. Surfaced here so dealers
    // can build out a CMP → set/parallel mapping. Already syncs to the
    // Google Sheet ("CMP code" column) regardless of whether it's shown
    // in the UI.
    ["CMP code", (cardData as any).cmpNumber || "—"],
    ["Parallel", cardData.foilType || "Base"],
    ["Serial", cardData.serialNumber || "—"],
    ["PSA grade", cardData.psaGrade != null ? `PSA ${cardData.psaGrade}` : "—"],
    ["Rookie", cardData.isRookieCard ? "Yes" : "No"],
  ];

  const saveEdits = () => {
    // Coerce year back to a number (the input binds to a string value).
    const yearNum = draft.year != null && String(draft.year).length > 0
      ? Number(draft.year)
      : undefined;
    const patch: Partial<CardFormValues> = {
      ...draft,
      year: Number.isFinite(yearNum as number) ? (yearNum as number) : cardData.year,
    };
    onSaveCardInfo(patch);
    setEditing(false);
  };

  return (
    <div className="px-4 space-y-3">
      {(frontImage || backImage) && (
        <div className="rounded-2xl bg-card border border-card-border p-4">
          <h2 className="text-sm font-semibold text-ink mb-3">Scanned images</h2>
          <div className="grid grid-cols-2 gap-3">
            {[
              { src: frontImage, label: "Front" },
              { src: backImage, label: "Back" },
            ]
              .filter((i) => !!i.src)
              .map((i) => (
                <div
                  key={i.label}
                  className="aspect-[3/4] rounded-xl overflow-hidden bg-slate-100 relative"
                >
                  <img
                    src={i.src}
                    alt={i.label}
                    className="w-full h-full object-cover"
                  />
                  <span className="absolute bottom-2 left-2 text-[10px] text-white bg-black/50 rounded px-1.5 py-0.5 flex items-center gap-1">
                    <Camera className="w-3 h-3" />
                    {i.label}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="rounded-2xl bg-card border border-card-border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-card-border">
          <h2 className="text-sm font-semibold text-ink">Card info</h2>
          {!editing ? (
            // Default state: 👍 Confirm / 👎 Edit pair. The selected option
            // gets a filled background so the user has a clear visual that
            // their feedback is registered — this is feedback-only state;
            // saving still happens via Add to Sheet in the sticky hero.
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleConfirmClick}
                aria-pressed={isConfirmed}
                title="Looks right—all fields verified"
                className={cn(
                  "inline-flex items-center gap-1 h-8 px-2.5 rounded-lg text-xs font-medium transition-colors",
                  isConfirmed
                    ? "bg-foil-violet text-white hover:brightness-110"
                    : "text-foil-violet hover:bg-foil-violet/10",
                )}
                data-testid="button-confirm-info"
              >
                <ThumbsUp className="w-3.5 h-3.5" /> Confirm
              </button>
              <button
                type="button"
                onClick={handleDeclineClick}
                aria-pressed={isDeclined}
                title="Something's off—let me edit"
                className={cn(
                  "inline-flex items-center gap-1 h-8 px-2.5 rounded-lg text-xs font-medium transition-colors",
                  isDeclined
                    ? "bg-slate-700 text-white hover:brightness-110"
                    : "text-slate-600 hover:bg-slate-100",
                )}
                data-testid="button-decline-info"
              >
                <ThumbsDown className="w-3.5 h-3.5" /> Edit
              </button>
            </div>
          ) : (
            // Edit mode: same Cancel + Save pair as before. Clicking Save
            // commits the draft via onSaveCardInfo; the parent's feedback
            // state is already 'declined_edited' (set when 👎 opened the
            // panel), so the next Add-to-Sheet call carries that tag.
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="h-8 px-2.5 rounded-lg text-xs font-medium text-slate-500 hover:bg-slate-100 transition-colors"
                data-testid="button-cancel-edit-info"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveEdits}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg text-xs font-semibold bg-foil-violet text-white hover:brightness-110"
                data-testid="button-save-edit-info"
              >
                <Check className="w-3.5 h-3.5" /> Save
              </button>
            </div>
          )}
        </div>

        {editing ? (
          // Inline edit grid — full-fidelity form that mutates scan flow
          // state in place. On save, the parent's handleSaveCardInfo pushes
          // the patch into cardData which re-triggers runPostScanFlow and
          // re-queries eBay pricing with the corrected fields. We do NOT
          // use the heavy EditCardModal here because that modal is wired
          // to /api/cards (persisted-card editing) and would POST a DB
          // write mid-scan, which we don't want for ephemeral scan edits.
          <div className="p-4 space-y-3">
            <EditField
              label="First name"
              value={draft.playerFirstName || ""}
              onChange={(v) => setDraft((d) => ({ ...d, playerFirstName: v }))}
              testId="edit-player-first"
            />
            <EditField
              label="Last name"
              value={draft.playerLastName || ""}
              onChange={(v) => setDraft((d) => ({ ...d, playerLastName: v }))}
              testId="edit-player-last"
            />
            <div className="grid grid-cols-2 gap-3">
              <EditField
                label="Year"
                value={draft.year != null ? String(draft.year) : ""}
                onChange={(v) => setDraft((d) => ({ ...d, year: v as any }))}
                inputMode="numeric"
                testId="edit-year"
              />
              <EditField
                label="Brand"
                value={draft.brand || ""}
                onChange={(v) => setDraft((d) => ({ ...d, brand: v }))}
                testId="edit-brand"
              />
            </div>
            {/* Set above Collection — matches the display-row ordering and
                the EditCardModal form so the UI is consistent everywhere. */}
            <EditField
              label="Set"
              value={(draft as any).set || ""}
              onChange={(v) => setDraft((d) => ({ ...d, set: v } as any))}
              testId="edit-set"
            />
            <EditField
              label="Collection"
              value={draft.collection || ""}
              onChange={(v) => setDraft((d) => ({ ...d, collection: v }))}
              testId="edit-collection"
            />
            <div className="grid grid-cols-2 gap-3">
              <EditField
                label="Card #"
                value={draft.cardNumber || ""}
                onChange={(v) => setDraft((d) => ({ ...d, cardNumber: v }))}
                testId="edit-card-number"
              />
              <EditField
                label="Serial"
                value={draft.serialNumber || ""}
                onChange={(v) => setDraft((d) => ({ ...d, serialNumber: v }))}
                placeholder="e.g. 42/99"
                testId="edit-serial"
              />
            </div>
            <EditField
              label="Parallel"
              value={draft.foilType || ""}
              onChange={(v) => setDraft((d) => ({ ...d, foilType: v, variant: v }))}
              placeholder="e.g. Silver Prizm, Rainbow Foil"
              testId="edit-parallel"
            />
            <PsaGradeSelect
              value={draft.psaGrade ?? null}
              onChange={(psa) => setDraft((d) => ({ ...d, psaGrade: psa }))}
            />
            <label className="flex items-center gap-2 pt-1 text-sm text-ink">
              <input
                type="checkbox"
                checked={!!draft.isRookieCard}
                onChange={(e) => setDraft((d) => ({ ...d, isRookieCard: e.target.checked }))}
                className="w-4 h-4 rounded border-card-border text-foil-violet focus:ring-foil-violet"
                data-testid="edit-rookie"
              />
              Rookie card
            </label>
            <p className="text-[11px] text-slate-500 pt-1">
              Saving refreshes pricing and the eBay search with your edits.
            </p>
          </div>
        ) : (
          <dl className="divide-y divide-card-border">
            {rows.map(([k, v]) => (
              <div
                key={k}
                className="flex items-center justify-between px-4 py-2.5 text-sm"
              >
                <dt className="text-slate-500">{k}</dt>
                <dd className="font-medium text-ink text-right truncate max-w-[60%]">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

/**
 * Minimal labeled input used inside the Edit info panel. Kept local to
 * ScanResult because this form is bespoke (scan-flow state, no server
 * round-trip) and doesn't share semantics with the persisted-card
 * EditCardModal used elsewhere.
 */
function EditField({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputMode?: "text" | "numeric" | "decimal";
  testId?: string;
}) {
  return (
    <div>
      <label className="text-[11px] text-slate-500 uppercase tracking-wide font-medium">
        {label}
      </label>
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full h-10 rounded-xl bg-background border border-card-border px-3 text-sm outline-none focus:ring-2 focus:ring-foil-violet/30"
        data-testid={testId}
      />
    </div>
  );
}

/**
 * Empty state shown on the Grade tab when the scan didn't produce a Holo
 * grade. There are two ways to land here:
 *
 *   1. Auto-grading is disabled in Account settings (users.preferences.autoGrade
 *      is false — the default). The server intentionally skipped the Claude
 *      call. We show a friendly explanation with an inline toggle so the user
 *      doesn't have to navigate away to turn it on.
 *
 *   2. Auto-grading IS enabled but Holo failed for some other reason — missing
 *      ANTHROPIC_API_KEY on the server, a Claude error, or no front image was
 *      provided. We keep the neutral "no grade returned" message here.
 *
 * Flipping the toggle applies on the next scan; we don't retroactively grade
 * the card we're already on (no front-image buffer on the client after /result,
 * and it would need a new server endpoint).
 */
function GradeTabEmptyState() {
  const { preferences, update, isUpdating, isLoading } = usePreferences();
  const autoGradeOff = !preferences.autoGrade;

  if (isLoading) {
    // Lightweight skeleton so we don't flash the "enable" CTA for signed-in
    // users whose preferences are still fetching on first tab entry.
    return (
      <div
        className="rounded-2xl border border-card-border bg-card p-4 text-sm text-slate-500"
        data-testid="grade-empty-loading"
      >
        Loading grade…
      </div>
    );
  }

  if (autoGradeOff) {
    return (
      <div
        className="rounded-2xl border border-card-border bg-card p-5"
        data-testid="grade-empty-disabled"
      >
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-foil-violet/10 flex items-center justify-center text-foil-violet shrink-0">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">Automatic grading is off</p>
            <p className="text-[12px] text-slate-500 mt-1 leading-relaxed">
              Turn it on to get an AI condition grade (centering, corners,
              edges, surface) on every scan. Each scan will take a little
              longer.
            </p>
            <div className="mt-4 flex items-center justify-between rounded-xl border border-card-border bg-background px-3 py-2">
              <span className="text-[13px] font-medium">
                Grade cards automatically
              </span>
              <Switch
                checked={preferences.autoGrade}
                onCheckedChange={(checked) => update({ autoGrade: checked })}
                disabled={isUpdating}
                aria-label="Grade cards automatically"
                data-testid="switch-auto-grade-empty"
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              Applies to future scans. Your current card won't be re-graded.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Auto-grading is on but no grade came back — Holo misfire / missing front image.
  return (
    <div
      className="rounded-2xl border border-card-border bg-card p-4 text-sm text-slate-500"
      data-testid="grade-empty-unavailable"
    >
      No grade returned for this scan. Try re-scanning with a clear front
      image.
    </div>
  );
}

/* -------------------- Gemini debug viewer (?debug=1) -------------------- */

// Renders a collapsible panel showing the raw Gemini VLM JSON for the
// current scan when the URL has `?debug=1`. Off by default so production
// dealers never see it. Used to verify Gemini's emitted year/brand/
// parallel against what landed on the saved card.
function GeminiDebugPanel({ cardData }: { cardData: Partial<CardFormValues> }) {
  const [open, setOpen] = useState(false);
  const debugEnabled =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("debug") === "1";
  if (!debugEnabled) return null;
  const gemini = (cardData as any)._gemini ?? null;
  return (
    <div className="px-4 pt-3" data-testid="gemini-debug-panel">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-slate-500 underline"
        data-testid="gemini-debug-toggle"
      >
        {open ? "Hide" : "Show"} raw Gemini JSON
      </button>
      {open && (
        <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-slate-50 p-3 text-[11px] leading-snug text-slate-700">
          {gemini ? JSON.stringify(gemini, null, 2) : "(no Gemini payload on this scan)"}
        </pre>
      )}
    </div>
  );
}
