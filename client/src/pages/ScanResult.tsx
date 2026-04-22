// Scan result page — /result
//
// Reads the cardData + holoGrade produced by /scan from the ScanFlow
// context and drives the rest of the flow: collection picker, parallel
// picker, HoloGrade display, graded price breakdown, eBay comps, and
// Add-to-GSheet. Redirects back to /scan if the user lands here cold
// with no result in memory.
//
// Tabs follow the redesigned mobile IA:
//   1. Details   (default — card info + scanned images)
//   2. Grade & Pricing  (HoloGrade + graded price breakdown combined)
//   3. Listings  (eBay comps)

import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useScanFlow } from "@/hooks/use-scan-flow";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import EbayPriceResults from "@/components/EbayPriceResults";
import { HoloGradeCard } from "@/components/HoloGradeCard";
import GradedPriceBreakdown from "@/components/GradedPriceBreakdown";
import ParallelPickerSheet, {
  type ParallelOption,
} from "@/components/ParallelPickerSheet";
import CollectionPickerSheet, {
  type CollectionCandidate,
} from "@/components/CollectionPickerSheet";
import { Camera, ScanLine, ScanSearch } from "lucide-react";
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

export default function ScanResult() {
  const [, navigate] = useLocation();
  const flow = useScanFlow();
  const { toast } = useToast();

  // Picker + processing state is owned locally — it's only meaningful
  // while this page is mounted.
  const [showParallelPicker, setShowParallelPicker] = useState(false);
  const [showParallelConfirm, setShowParallelConfirm] = useState(false);
  const [parallelOptions, setParallelOptions] = useState<ParallelOption[]>([]);
  const [detectedKeyword, setDetectedKeyword] = useState("");
  const [showCollectionPicker, setShowCollectionPicker] = useState(false);
  const [collectionCandidates, setCollectionCandidates] = useState<CollectionCandidate[]>([]);
  const [showPriceResults, setShowPriceResults] = useState(false);

  // Tracks whether we already gave the user a moment to let the analyze
  // payload commit into context before considering a redirect. Avoids a
  // race where /result mounts on the same microtask that set the data,
  // briefly sees hasResult=false, and bounces back to /scan.
  const [bootChecked, setBootChecked] = useState(false);

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
    runPostScanFlow(cardData).catch((err) => {
      // fetchParallels or any downstream helper failed — don't leave the
      // page stuck in its pre-price state. Fall through to showing eBay
      // prices with whatever OCR gave us so the user sees *something*.
      console.error("[ScanResult] Post-scan flow threw, falling back:", err);
      toast({
        title: "Couldn't look up parallels",
        description: "Showing prices for the detected card instead.",
      });
      setShowPriceResults(true);
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
  const requestShowParallelConfirm = (value: boolean) => {
    if (value && parallelDecidedRef.current) {
      console.log("[ScanResult] skip re-prompt, user already decided");
      return;
    }
    setShowParallelConfirm(value);
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

    const detected = data.foilType?.trim() || "";
    const detectedSerial = data.serialNumber?.trim() || "";
    const isNumberedCard = !!data.isNumbered || /\d+\/\d+/.test(detectedSerial);
    const parallelSuspected = !!(data as any).parallelSuspected;

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
            requestShowParallelConfirm(true);
            return;
          }
          setParallelOptions(bySerial);
          setDetectedKeyword(extractKeyword(detected));
          requestShowParallelConfirm(true);
          return;
        }
        if (bySerial.length >= 2) {
          setParallelOptions(bySerial);
          setDetectedKeyword("");
          requestShowParallelConfirm(true);
          return;
        }
      }

      // STEP 2 — Keyword + serialization-status match.
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
        requestShowParallelConfirm(true);
        return;
      }
      if (filtered.length >= 2) {
        const allForStatus = filterBySerialStatus(allOptions, !!detectedSerial && !!data.isNumbered);
        setParallelOptions(mergePreferringPrimary(filtered, allForStatus));
        setDetectedKeyword(extractKeyword(detected));
        requestShowParallelConfirm(true);
        return;
      }

      // STEP 3 — detected but 0 DB keyword hits. Show full list if there is one.
      if (filtered.length === 0 && detected) {
        const allForStatus = filterBySerialStatus(allOptions, !!detectedSerial && !!data.isNumbered);
        if (allForStatus.length >= 2) {
          setParallelOptions(allForStatus);
          setDetectedKeyword(extractKeyword(detected));
          requestShowParallelConfirm(true);
          return;
        }
      }

      // STEP 4 — parallelSuspected with no keyword/serial.
      if (parallelSuspected && !detected && !detectedSerial) {
        const allForStatus = filterBySerialStatus(allOptions, !!detectedSerial && !!data.isNumbered);
        if (allForStatus.length >= 1) {
          setParallelOptions(allForStatus);
          setDetectedKeyword("");
          requestShowParallelConfirm(true);
          return;
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

  const handleParallelConfirm = (foilType: string, serialNumber?: string) => {
    if (!cardData) return;
    const updated: Partial<CardFormValues> = { ...cardData, foilType };
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
    setShowParallelPicker(true);
  };

  const handleParallelConfirmNo = () => {
    if (!cardData) return;
    parallelDecidedRef.current = true;
    setShowParallelConfirm(false);
    setShowParallelPicker(false);
    setParallelOptions([]);
    setDetectedKeyword("");
    setShowPriceResults(true);
    // Clear the OCR-detected foil so the downstream flow doesn't ask
    // again and eBay searches run against the base card.
    flow.setCardData({ ...cardData, foilType: "" });
  };

  const handleScanAnother = () => {
    parallelDecidedRef.current = false;
    flow.reset();
    navigate("/scan");
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
              <p className="text-[11px] text-slate-500 uppercase tracking-wider font-medium">
                {cardData.year} {cardData.brand}
                {cardData.cardNumber ? ` · #${cardData.cardNumber}` : ""}
              </p>
              <h1 className="font-display text-xl font-semibold tracking-tight leading-tight truncate text-ink">
                {playerName(cardData) || "Unidentified card"}
              </h1>
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
          <div className="flex gap-2 mt-3">
            <button
              onClick={handleScanAnother}
              className="h-10 px-4 rounded-xl bg-slate-100 text-ink text-sm font-medium flex items-center gap-1.5 hover-elevate ml-auto"
              data-testid="button-scan-another"
            >
              <ScanLine className="w-4 h-4" /> Scan another
            </button>
          </div>
        </div>
      </section>

      {/* Parallel-confirm prompt (rendered inline so the user can dismiss
          false-positive foil detections without opening the picker). */}
      {showParallelConfirm && (
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

      {/* Picker sheets — controlled here, triggered by post-scan flow */}
      <ParallelPickerSheet
        open={showParallelPicker}
        detectedLabel={detectedKeyword}
        cardDescription={cardDescription}
        options={parallelOptions}
        onConfirm={handleParallelConfirm}
      />
      <CollectionPickerSheet
        open={showCollectionPicker}
        cardDescription={cardDescription}
        candidates={collectionCandidates}
        onConfirm={handleCollectionConfirm}
      />

      {/* Tabs — default to Grade & Pricing so the user sees the payoff of
          the scan immediately (grade + comps). Details is a reference view
          for verifying OCR identified the card correctly. */}
      <Tabs defaultValue="grade-pricing" className="pt-3">
        <TabsList className="mx-4 grid grid-cols-3 bg-slate-100/60">
          <TabsTrigger value="details" data-testid="tab-details">Details</TabsTrigger>
          <TabsTrigger value="grade-pricing" data-testid="tab-grade-pricing">
            Grade &amp; Pricing
          </TabsTrigger>
          <TabsTrigger value="listings" data-testid="tab-listings">Listings</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="mt-4 space-y-3">
          <DetailsTab
            cardData={cardData}
            frontImage={frontImage}
            backImage={backImage}
          />
        </TabsContent>

        <TabsContent value="grade-pricing" className="mt-4 space-y-4 px-4">
          {holoGrade && <HoloGradeCard grade={holoGrade} />}
          {holoGrade && (
            <GradedPriceBreakdown
              cardData={cardData}
              holoOverall={holoGrade.overall}
            />
          )}
          {showPriceResults ? (
            <EbayPriceResults
              cardData={cardData}
              frontImage={frontImage}
              backImage={backImage}
              onCardDataUpdate={(updatedData) => {
                // Re-run the disambiguation flow when the serial limit
                // changed (e.g. user typed "041/150" OCR missed); otherwise
                // just save the edits and re-price in place.
                flow.setCardData(updatedData);
              }}
            />
          ) : (
            <div className="rounded-2xl border border-card-border bg-card p-4 text-sm text-slate-500">
              {showParallelConfirm || showParallelPicker || showCollectionPicker
                ? "Answer the prompt above to load pricing."
                : "Looking up pricing…"}
            </div>
          )}
          {!holoGrade && (
            <p className="text-xs text-slate-500 text-center">
              No Holo grade returned for this scan.
            </p>
          )}
        </TabsContent>

        <TabsContent value="listings" className="mt-4 space-y-3 px-4">
          {showPriceResults ? (
            <EbayPriceResults
              cardData={cardData}
              frontImage={frontImage}
              backImage={backImage}
              onCardDataUpdate={(updatedData) => {
                flow.setCardData(updatedData);
              }}
            />
          ) : (
            <p className="text-sm text-slate-500">
              Complete the prompts above to load pricing.
            </p>
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
}: {
  cardData: Partial<CardFormValues>;
  frontImage: string;
  backImage: string;
}) {
  const rows: [string, string][] = [
    ["Player", playerName(cardData) || "—"],
    ["Year", cardData.year ? String(cardData.year) : "—"],
    ["Brand", cardData.brand || "—"],
    ["Collection", cardData.collection || "—"],
    ["Set", cardData.set || "—"],
    ["Card #", cardData.cardNumber || "—"],
    ["Parallel", cardData.foilType || "Base"],
    ["Serial", cardData.serialNumber || "—"],
    ["Rookie", cardData.isRookieCard ? "Yes" : "No"],
  ];

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
        <div className="px-4 py-3 border-b border-card-border">
          <h2 className="text-sm font-semibold text-ink">Card info</h2>
        </div>
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
      </div>
    </div>
  );
}
