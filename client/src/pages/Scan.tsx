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

import { useEffect, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import SimpleImageUploader from "@/components/SimpleImageUploader";
import VoiceLookup, { type ExtractedCardFields } from "@/components/VoiceLookup";
import { useToast } from "@/hooks/use-toast";
import { useScanFlow } from "@/hooks/use-scan-flow";
import { compressImage } from "@/lib/scanFlow";
import { queryClient } from "@/lib/queryClient";
import type { CardFormValues } from "@shared/schema";
import type { HoloGrade } from "@/components/HoloGradeCard";
import { ScanLine, RotateCw, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { isLikelyBlurry } from "@shared/sharpness";
import {
  ScanProgressChips,
  DEFAULT_SCAN_STAGES,
  SCAN_STAGE_LABELS,
  type ScanProgressChipStage,
  type ChipStatus,
} from "@/components/ScanProgressChips";
import { InlineParallelPicker } from "@/components/InlineParallelPicker";
import { ScanInfoHeader, type ScanInfoHeaderFields } from "@/components/ScanInfoHeader";
import StreamingParallelConfirmDialog from "@/components/StreamingParallelConfirmDialog";
import StreamingManualParallelDialog from "@/components/StreamingManualParallelDialog";
import { consumeSseStream } from "@/lib/sse";

// PR Q — payload shape attached to the streaming
// `detecting_parallel:completed` stage event so the inline picker
// can render before stages 3/4 fire.
interface InlineParallelData {
  variant: string | null;
  foilType: string | null;
  confidence: number | null;
}

// PR R Item 1 — decorate the chip list so the inline parallel picker
// renders directly under chip 2 (`detecting_parallel`) instead of
// floating above the entire chip stack. Item 3 — also format the
// chip 3 detail label from the eBay listing-count progress stream.
//
// PR T Item 1 — extends the same pattern to chip 1: the
// <ScanInfoHeader> identity card mounts as chip 1's inlineSlot
// instead of floating above the entire chip stack. Visual order:
//   [Processing] [chip 1] <ScanInfoHeader/> [chip 2] <picker/>
//   [chip 3] [chip 4]
//
// Pure function: exported for testing.
export interface DecorateProgressStagesArgs {
  stages: ScanProgressChipStage[];
  scanInfoNode: React.ReactNode;
  inlineParallelNode: React.ReactNode;
  ebayProgress: { found: number; target: number } | null;
}
export function decoratedProgressStages({
  stages,
  scanInfoNode,
  inlineParallelNode,
  ebayProgress,
}: DecorateProgressStagesArgs): ScanProgressChipStage[] {
  return stages.map((s) => {
    if (s.id === "analyzing_card") {
      // PR T Item 1 — attach the streaming card-info header under
      // chip 1 so the layout is "Processing → chip 1 → header" rather
      // than "Processing → header → chip 1". Mounts as soon as chip 1
      // exists (status: in_progress or completed) so the skeletons
      // are visible during stage-1 OCR.
      return scanInfoNode ? { ...s, inlineSlot: scanInfoNode } : s;
    }
    if (s.id === "detecting_parallel") {
      // Only attach the picker once stage 2 has actually reached at
      // least in_progress (i.e. the chip exists). If the picker node
      // is null (no inline parallel data yet), no-op.
      return inlineParallelNode
        ? { ...s, inlineSlot: inlineParallelNode }
        : s;
    }
    if (s.id === "verifying_with_ebay") {
      const detail = ebayProgressLabel(ebayProgress, s.status);
      return detail ? { ...s, detail } : s;
    }
    return s;
  });
}

// Pure helper for the chip 3 sub-label string. Exported for tests.
//   - in_progress + progress: "(found/target)"
//   - completed: "— Found N listings"
//   - waiting / pending: no detail
export function ebayProgressLabel(
  progress: { found: number; target: number } | null,
  status: ChipStatus,
): string | null {
  if (!progress) return null;
  if (status === "completed") {
    return `— Found ${progress.found} ${
      progress.found === 1 ? "listing" : "listings"
    }`;
  }
  if (status === "in_progress") {
    return `(${progress.found}/${progress.target})`;
  }
  return null;
}

// Build a one-line identity preview from the streaming header fields.
// Used as the modal description.
//
// PR S Item 2 — locked format is `Year · Brand · Set · Collection · #
// · Player` (Set + Collection are two separate fields). Empty slots
// are dropped from the joined string so the description stays tight
// when a field is missing.
export function describeFields(fields: ScanInfoHeaderFields): string {
  const parts = [
    fields.year != null ? String(fields.year).trim() : "",
    (fields.brand ?? "").toString().trim(),
    (fields.set ?? "").toString().trim(),
    (fields.collection ?? "").toString().trim(),
    fields.cardNumber
      ? String(fields.cardNumber).startsWith("#")
        ? String(fields.cardNumber)
        : `#${fields.cardNumber}`
      : "",
    (fields.player ?? "").toString().trim(),
  ].filter(Boolean);
  return parts.join(" · ");
}

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
  // GRADED mode: the slab-label crop captured alongside the front image. Used
  // as a separate multipart field on /analyze-card-dual-images so the server
  // can run a dedicated VLM pass over the printed label fields.
  const [gradingLabelImage, setGradingLabelImage] = useState<string>("");
  // Live-preview quality diagnostics from CardCameraCapture's sampler. Sent
  // alongside the analyze upload so the server can log image-quality
  // signals next to the OCR result.
  const [frontLighting, setFrontLighting] = useState<string>("");
  const [frontBlurScore, setFrontBlurScore] = useState<number | null>(null);
  // Sharpness scores from the burst-pick path (or library bitmap score).
  // Used to render a soft warning banner under each thumbnail and threaded
  // into the analyze upload as `frontSharpness` / `backSharpness` so the
  // server-side scan log carries the same number the user saw.
  const [frontSharpness, setFrontSharpness] = useState<number | null>(null);
  const [backSharpness, setBackSharpness] = useState<number | null>(null);
  const [backCameraSignal, setBackCameraSignal] = useState<number>(0);
  const [frontCameraSignal, setFrontCameraSignal] = useState<number>(0);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  // PR H + PR P — chip-stack progress for the single-card scan flow.
  // PR P changed the pre-PR-P "render 4 pending chips up front" model to
  // a progressive reveal: chips mount only as their stage's first event
  // (`in_progress`) arrives. Reset to an empty array on every analyze
  // invocation so each scan starts with no chips visible.
  const [progressStages, setProgressStages] = useState<ScanProgressChipStage[]>(
    [],
  );
  // PR Q — inline parallel picker state. Populated when the
  // streaming SSE emits `detecting_parallel:completed` with a `data`
  // payload. Reset to null on each new analyze invocation. If a
  // later stage corrects the variant identity, the parent updates
  // this state and the picker mutates in place.
  const [inlineParallel, setInlineParallel] =
    useState<InlineParallelData | null>(null);
  // PR R Item 4 — streaming card-info header populated from the
  // analyzing_card:completed event's data payload. Persists through
  // stages 2-4 so the user sees what's been identified while pricing
  // is still in flight. Reset to empty on every analyze invocation.
  const [scanInfoFields, setScanInfoFields] = useState<ScanInfoHeaderFields>({});
  // PR R Item 2 — confirm modal state. When stage 2 completes WITH a
  // parallel detected, the modal opens and stage 3's chip flips to a
  // "waiting" status. The modal stays open until the user clicks Yes
  // (keep variant) or No (revert to base / no parallel). Confirmation
  // also unblocks the chip into its normal in_progress display.
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [confirmedVariant, setConfirmedVariant] = useState<
    string | null | undefined
  >(undefined); // undefined = not yet asked, null = user said No, string = user said Yes
  const confirmedVariantRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    confirmedVariantRef.current = confirmedVariant;
  }, [confirmedVariant]);
  // PR T Item 3 — manual-entry modal that takes over from the Yes/No
  // dialog when the user clicks No. Stage 3 stays in `waiting` until
  // the user saves a value here. `manualEnteredVariant` is the raw
  // string the user typed (or "" for base) — the analyze flow uses
  // this to overwrite the final cardData.foilType/variant downstream
  // so eBay/pricing run with the user's value.
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const manualModalOpenRef = useRef(false);
  useEffect(() => {
    manualModalOpenRef.current = manualModalOpen;
  }, [manualModalOpen]);
  const [manualEnteredVariant, setManualEnteredVariant] = useState<
    string | null
  >(null);
  const manualEnteredVariantRef = useRef<string | null>(null);
  useEffect(() => {
    manualEnteredVariantRef.current = manualEnteredVariant;
  }, [manualEnteredVariant]);
  // Ref-mirror of confirmModalOpen so the SSE event handler closure
  // (created once at consumeSseStream call time) reads the latest
  // value rather than the snapshot from when the closure was made.
  const confirmModalOpenRef = useRef(false);
  useEffect(() => {
    confirmModalOpenRef.current = confirmModalOpen;
  }, [confirmModalOpen]);
  // Most-recent server-reported status for chip 3 while the modal is
  // open — held until the user confirms so we can replay it.
  const pendingChip3StatusRef = useRef<ChipStatus | null>(null);
  // PR R Item 2 — promise the analyze flow awaits before navigating to
  // /result. Mints a fresh promise every time the modal opens, resolves
  // it from the Yes/No click handlers. Block is indefinite — there is
  // no auto-accept timeout.
  const confirmResolveRef = useRef<(() => void) | null>(null);
  const waitForConfirmRef = useRef<() => Promise<void>>(async () => {
    // If no modal-open ever fired, the await is a no-op.
    return;
  });
  const armConfirmGate = () => {
    waitForConfirmRef.current = () =>
      new Promise<void>((resolve) => {
        confirmResolveRef.current = resolve;
      });
  };
  const resolveConfirmGate = () => {
    if (confirmResolveRef.current) {
      const r = confirmResolveRef.current;
      confirmResolveRef.current = null;
      r();
    }
    waitForConfirmRef.current = async () => {};
  };
  // Replay the pending server status onto chip 3 once the modal closes.
  // If no server event arrived during the wait (rare), we tick chip 3
  // into in_progress as a sensible default so the user sees motion.
  const releaseChip3Gate = () => {
    const next = pendingChip3StatusRef.current ?? "in_progress";
    pendingChip3StatusRef.current = null;
    setProgressStages((prev) => {
      const idx = prev.findIndex((s) => s.id === "verifying_with_ebay");
      if (idx < 0) {
        return [
          ...prev,
          {
            id: "verifying_with_ebay",
            label: SCAN_STAGE_LABELS.verifying_with_ebay,
            status: next,
          },
        ];
      }
      const arr = prev.slice();
      arr[idx] = { ...arr[idx], status: next };
      return arr;
    });
  };
  // PR P abort controller hook for the pre-fired comps summary. The
  // server pre-fires getCompsSummary on parallel-detected. If the user
  // clicks No, we want to abort the in-flight fetch so a fresh
  // base-card query runs (handled server-side via the same
  // AbortController plumbing PR P added). Implemented as an
  // event-stream-side flag here because the actual fetch lives on the
  // server; we surface it through a multipart field on the analyze
  // request when re-triggering would require a fresh round-trip.
  // For now (single SSE round-trip), we just record the user's choice
  // so that downstream consumers (eBay query on /result, etc.) read
  // confirmedVariant rather than inlineParallel.
  // PR R Item 3 — live eBay listing count rendered into chip 3's
  // sub-label. {found, target} streams in via verifying_with_ebay
  // progress events. After the chip flips to completed, we render
  // "Found N listings" instead of the (X/Y) form.
  const [ebayProgress, setEbayProgress] = useState<{
    found: number;
    target: number;
  } | null>(null);
  const resetProgressStages = () => {
    setProgressStages([]);
    setInlineParallel(null);
    setScanInfoFields({});
    setConfirmModalOpen(false);
    setConfirmedVariant(undefined);
    setManualModalOpen(false);
    manualModalOpenRef.current = false;
    setManualEnteredVariant(null);
    manualEnteredVariantRef.current = null;
    setEbayProgress(null);
  };
  // Apply the stage event from the server stream. If a chip with this
  // id doesn't exist yet, append a fresh one in the incoming status —
  // this is what makes the chips appear one-at-a-time as `in_progress`
  // events fire. Existing chips just get their status updated, so the
  // in_progress → completed transition reuses the same chip (and the
  // same DOM ref — important so the auto-scroll mount-time effect
  // doesn't re-fire on completion).
  const applyStageEvent = (id: string, status: ChipStatus) => {
    // PR R Item 2 — while the parallel-confirm modal is open, force
    // chip 3 to render its waiting state regardless of what the
    // server stream is reporting. The actual eBay fetch completes on
    // the server in parallel; we just hide its progress until the
    // user makes a choice. Once confirmation lands, releaseChip3Gate()
    // re-emits the latest server status.
    // PR T Item 3 — extend the gate to also cover the manual-entry
    // modal that opens when the user clicks No. Stage 3 stays in
    // `waiting` until the manual modal is dismissed too.
    if (
      id === "verifying_with_ebay" &&
      status !== "waiting" &&
      (confirmModalOpenRef.current || manualModalOpenRef.current)
    ) {
      pendingChip3StatusRef.current = status;
      status = "waiting";
    }
    setProgressStages((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = { ...next[idx], status };
        return next;
      }
      const label = SCAN_STAGE_LABELS[id] ?? id;
      return [...prev, { id, label, status }];
    });
  };
  // Legacy non-streaming fallback: on success, mint the full 4-stage
  // list in `completed` so the user still sees the work finished. This
  // path runs when the streaming sibling isn't available; chips appear
  // in one batch rather than progressively, which is acceptable for
  // the rare fallback case.
  const completeAllStages = () => {
    setProgressStages(
      DEFAULT_SCAN_STAGES.map((s) => ({ ...s, status: "completed" as const })),
    );
  };

  // PR P — auto-scroll guard. When chips mount they call
  // `scrollIntoView({ block: 'center' })` so the active chip stays
  // visible if the page has scrolled past it. The first time the user
  // takes a manual scroll action during a scan, we flip the guard and
  // suppress further auto-scrolls for the rest of THIS scan. The flag
  // is reset at the start of every analyze invocation.
  //
  // PR Q tightens this: scroll events with deltaY < SCROLL_DELTA_PX are
  // treated as noise (iOS Safari fires synthetic scroll events on
  // viewport resize / rubber-band that previously tripped the guard
  // and disabled auto-scroll for the rest of the scan).
  const [userScrolledManually, setUserScrolledManually] = useState(false);
  // Programmatic scroll flag — set true just before each
  // chip.scrollIntoView call, cleared ~800ms later (was 600ms in PR P;
  // bumped because iOS Safari's smooth-scroll animation occasionally
  // dispatches its final scroll event past the 600ms boundary).
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const lastScrollYRef = useRef<number>(0);
  const handleBeforeAutoScroll = () => {
    programmaticScrollRef.current = true;
    // Snapshot scrollY at the start of the programmatic window so the
    // delta-threshold check below has a baseline to compare against.
    if (typeof window !== "undefined") {
      lastScrollYRef.current = window.scrollY;
    }
    if (programmaticScrollTimerRef.current != null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }
    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, 800);
  };
  useEffect(() => {
    if (!analyzing) return;
    // PR Q: ignore scrolls smaller than this many pixels — iOS Safari
    // emits 1-3px synthetic scrolls on viewport resize / address-bar
    // collapse that previously tripped the guard.
    const SCROLL_DELTA_PX = 10;
    lastScrollYRef.current =
      typeof window !== "undefined" ? window.scrollY : 0;
    const flagManual = () => {
      // Wheel / touch / keyboard events ARE always user-initiated, so
      // ignore the programmaticScrollRef gate here.
      setUserScrolledManually(true);
    };
    const onScroll = () => {
      if (programmaticScrollRef.current) {
        // Keep tracking the moving baseline so the first user scroll
        // AFTER the programmatic window is measured from the chip's
        // settled position, not the pre-scroll page position.
        lastScrollYRef.current = window.scrollY;
        return;
      }
      const y = window.scrollY;
      const delta = Math.abs(y - lastScrollYRef.current);
      lastScrollYRef.current = y;
      if (delta < SCROLL_DELTA_PX) return;
      setUserScrolledManually(true);
    };
    const SCROLL_KEYS = new Set([
      "PageDown",
      "PageUp",
      "ArrowDown",
      "ArrowUp",
      "Home",
      "End",
      " ",
      "Spacebar",
    ]);
    const onKeyDown = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) setUserScrolledManually(true);
    };
    window.addEventListener("wheel", flagManual, { passive: true });
    window.addEventListener("touchmove", flagManual, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("wheel", flagManual);
      window.removeEventListener("touchmove", flagManual);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll);
      if (programmaticScrollTimerRef.current != null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
        programmaticScrollTimerRef.current = null;
      }
      programmaticScrollRef.current = false;
    };
  }, [analyzing]);

  // RAW (default) ↔ GRADED toggle. Persisted across visits so users that
  // primarily scan slabs don't have to flip the switch every time. Default
  // RAW because most users scan ungraded cards.
  const [scanMode, setScanMode] = useState<'raw' | 'graded'>(() => {
    if (typeof window === 'undefined') return 'raw';
    return window.localStorage.getItem('holo-scan-mode') === 'graded'
      ? 'graded'
      : 'raw';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('holo-scan-mode', scanMode);
  }, [scanMode]);

  // Auto-open the front camera when the user lands on /scan in image mode and
  // there's no existing front capture. One-shot — driven by a signal bump so
  // the SimpleImageUploader's existing openCameraSignal effect handles the
  // actual modal open. Skipped for voice mode and when the user is returning
  // with an already-captured front image.
  const autoOpenedFrontRef = useRef(false);
  useEffect(() => {
    if (autoOpenedFrontRef.current) return;
    if (mode !== 'image') return;
    if (frontImage) return;
    autoOpenedFrontRef.current = true;
    setFrontCameraSignal((n) => n + 1);
  }, [mode, frontImage]);

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
      // GRADED mode: send the slab-label crop as a separate multipart field
      // and tag the request mode so the server runs the grading-label
      // analyzer + cross-validates against the card-body OCR.
      if (scanMode === 'graded' && gradingLabelImage) {
        const labelBlob = await compressImage(gradingLabelImage);
        formData.append("gradingLabelImage", labelBlob, "label.jpg");
        formData.append("mode", "graded");
      }
      if (scanIdRef.current) formData.append("scanId", scanIdRef.current);
      // Diagnostic image-quality signals from the live preview. Server
      // already accepts these as optional fields and logs them next to the
      // analyze result; missing values are tolerated.
      if (frontLighting) formData.append("clientLighting", frontLighting);
      if (frontBlurScore != null && Number.isFinite(frontBlurScore)) {
        formData.append("clientBlurScore", String(Math.round(frontBlurScore)));
      }
      // Burst-picked sharpness scores. Distinct from clientBlurScore (the
      // live-preview 64x64 sample) — these come from the 480x480 sample
      // of the actual selected burst frame, so they reflect the saved
      // image rather than the viewfinder. Server logs them to the scan
      // sheet's Indicators column for retrospective tuning of the warning
      // threshold.
      if (frontSharpness != null && Number.isFinite(frontSharpness)) {
        formData.append("frontSharpness", frontSharpness.toFixed(2));
      }
      if (backSharpness != null && Number.isFinite(backSharpness)) {
        formData.append("backSharpness", backSharpness.toFixed(2));
      }
      // Mint (or reuse) a client UUID for the audit row. Letting the
      // client own the id means the server can fire-and-forget the
      // user_scans INSERT and we still know how to update it on save.
      if (!userScanIdRef.current) userScanIdRef.current = mintScanId();
      formData.append("userScanId", userScanIdRef.current);

      timing.requestSentAt = performance.now();
      console.log(
        `[holo-timing] request sent +${(timing.requestSentAt - timing.clickedAt).toFixed(0)}ms`,
      );

      // PR H — try the SSE streaming sibling first so the chip stack ticks
      // live as the server hits each milestone. On any failure (older
      // server, mid-stream disconnect, browser without ReadableStream) we
      // fall back to the legacy non-streaming route and tick all chips
      // green when its JSON response lands.
      resetProgressStages();
      // PR P — auto-scroll guard resets per-scan. The user must
      // manually scroll DURING this scan to suppress auto-scroll; a
      // prior scan's manual-scroll does not carry over.
      setUserScrolledManually(false);
      let result: any = null;
      let httpStatus = 200;
      let usedStreaming = false;
      try {
        const streamResp = await fetch(
          "/api/analyze-card-dual-images/stream",
          { method: "POST", body: formData },
        );
        httpStatus = streamResp.status;
        if (
          streamResp.ok &&
          streamResp.body &&
          typeof streamResp.body.getReader === "function" &&
          (streamResp.headers.get("content-type") || "").includes(
            "text/event-stream",
          )
        ) {
          usedStreaming = true;
          let captured: { status: number; body: any } | null = null;
          await consumeSseStream(streamResp.body, (event) => {
            if (event?.type === "stage" && typeof event.stage === "string") {
              // PR R Item 3 — progress sub-events on stage 3 update the
              // listing count in chip 3's label without flipping its
              // overall status.
              if (
                event.stage === "verifying_with_ebay" &&
                event.status === "progress" &&
                event.data &&
                typeof event.data === "object"
              ) {
                const d = event.data as { found?: number; target?: number };
                if (typeof d.found === "number" && typeof d.target === "number") {
                  setEbayProgress({ found: d.found, target: d.target });
                }
                return;
              }
              // PR U — incremental field events from stage 1's streaming
              // Gemini call. Each event carries ONE newly-completed field
              // (e.g. just { year: 2026 } or { player: "Mike Trout" }) as
              // soon as it lands in the partial JSON parse. We merge into
              // scanInfoFields so <ScanInfoHeader> renders that slot as
              // soon as we receive it. The chip stays in_progress — only
              // the `analyzing_card:completed` event flips it to done.
              if (
                event.stage === "analyzing_card" &&
                event.status === "progress" &&
                event.data &&
                typeof event.data === "object"
              ) {
                const d = event.data as Partial<ScanInfoHeaderFields>;
                setScanInfoFields((prev) => ({
                  ...prev,
                  ...(d.year !== undefined ? { year: d.year } : {}),
                  ...(d.brand !== undefined ? { brand: d.brand } : {}),
                  ...(d.set !== undefined ? { set: d.set } : {}),
                  ...(d.collection !== undefined
                    ? { collection: d.collection }
                    : {}),
                  ...(d.cardNumber !== undefined
                    ? { cardNumber: d.cardNumber }
                    : {}),
                  ...(d.player !== undefined ? { player: d.player } : {}),
                }));
                return;
              }
              applyStageEvent(event.stage, event.status as ChipStatus);
              // PR R Item 4 — stage 1 fields stream into the header.
              // PR U — this is now the SOURCE-OF-TRUTH event, ensuring all
              // fields are populated even if any per-field progress event
              // was dropped or the partial parse missed one.
              if (
                event.stage === "analyzing_card" &&
                event.status === "completed" &&
                event.data &&
                typeof event.data === "object"
              ) {
                const d = event.data as Partial<ScanInfoHeaderFields>;
                setScanInfoFields((prev) => ({
                  year: d.year ?? prev.year ?? null,
                  brand: d.brand ?? prev.brand ?? null,
                  set: d.set ?? prev.set ?? null,
                  collection: d.collection ?? prev.collection ?? null,
                  cardNumber: d.cardNumber ?? prev.cardNumber ?? null,
                  player: d.player ?? prev.player ?? null,
                }));
              }
              // PR Q — surface the inline parallel picker as soon as
              // stage 2 completes. PR R Item 2 — also fire the
              // confirm modal AND mark stage 3 as waiting if a
              // parallel was detected.
              if (
                event.stage === "detecting_parallel" &&
                event.status === "completed" &&
                event.data &&
                typeof event.data === "object"
              ) {
                const d = event.data as Partial<InlineParallelData>;
                const variantStr =
                  typeof d.variant === "string" && d.variant.length > 0
                    ? d.variant
                    : null;
                setInlineParallel({
                  variant: variantStr,
                  foilType:
                    typeof d.foilType === "string" && d.foilType.length > 0
                      ? d.foilType
                      : null,
                  confidence:
                    typeof d.confidence === "number" ? d.confidence : null,
                });
                // PR R Item 2 — only fire the modal if a parallel was
                // actually detected. Base cards skip the modal so the
                // scan flow stays uninterrupted.
                if (variantStr) {
                  armConfirmGate();
                  setConfirmModalOpen(true);
                  // Eagerly mirror into the ref so the gate-rewrite in
                  // applyStageEvent below sees `true` for the
                  // verifying_with_ebay:in_progress event the server
                  // emits microseconds later (the React effect that
                  // syncs the ref is async and would otherwise lag).
                  confirmModalOpenRef.current = true;
                  // Pre-mount chip 3 in waiting status so the chip
                  // stack renders [chip 1 ✓][chip 2 ✓][chip 3 waiting]
                  // immediately. The subsequent server
                  // verifying_with_ebay:in_progress event flips it to
                  // active — but only AFTER the user confirms (gated
                  // below in applyStageEvent's call site).
                  applyStageEvent("verifying_with_ebay", "waiting");
                }
              }
            } else if (event?.type === "result") {
              captured = {
                status: typeof event.status === "number" ? event.status : 200,
                body: event.body,
              };
            } else if (event?.type === "error") {
              throw new Error(event.message || "Stream reported error");
            }
          });
          if (captured) {
            httpStatus = (captured as any).status;
            result = (captured as any).body;
          } else {
            throw new Error("Stream ended without a result event");
          }
          // PR R Item 2 — block the navigate-to-result step until the
          // user has confirmed the parallel. The SSE stream may have
          // produced the final result event before they clicked, so
          // we await an explicit confirmation signal here. No
          // auto-accept timeout — the spec says "block indefinitely;
          // user is actively scanning."
          //
          // PR T Item 3 — the gate now resolves at the END of the
          // manual-entry modal too (when the user clicks No on the
          // Yes/No modal, the gate is held open until they save the
          // manual modal). One await covers both flows.
          if (confirmModalOpenRef.current || manualModalOpenRef.current) {
            // PR V hotfix — defensive client-side timeout. The gate
            // now resolves on every legit dismissal path (Yes / No /
            // Save / X / ESC), but if a future change introduces
            // another untracked dismissal route the user gets stuck
            // forever on a silent screen. 60s ceiling: long enough
            // that real users typing into the manual-entry input
            // never trip it, short enough that a regression doesn't
            // hang the whole flow.
            const GATE_TIMEOUT_MS = 60_000;
            const gatePromise = waitForConfirmRef.current();
            const timeoutPromise = new Promise<'__timeout__'>((resolve) =>
              setTimeout(() => resolve('__timeout__'), GATE_TIMEOUT_MS),
            );
            const winner = await Promise.race([
              gatePromise.then(() => '__resolved__' as const),
              timeoutPromise,
            ]);
            if (winner === '__timeout__') {
              console.error(
                '[holo-gate] timeout — gate never resolved, forcing base-card fallback',
              );
              // Force-release whichever modal is hung so the rest of
              // the flow proceeds with whatever data we have.
              if (confirmModalOpenRef.current) {
                setConfirmModalOpen(false);
                confirmModalOpenRef.current = false;
                setConfirmedVariant(null);
                confirmedVariantRef.current = null;
              }
              if (manualModalOpenRef.current) {
                setManualModalOpen(false);
                manualModalOpenRef.current = false;
                setManualEnteredVariant('');
                manualEnteredVariantRef.current = '';
              }
              releaseChip3Gate();
              resolveConfirmGate();
            }
          }
          // Apply the user's final decision to the result payload
          // so /result downstream (eBay re-fetch, save row) reflects
          // the parallel they chose. Three cases:
          //   - manual entry with text → write the user's string into
          //     foilType/variant.
          //   - manual entry blank, OR Yes/No modal answered No
          //     (without manual entry being reachable in the new
          //     flow) → treat as base, clear foil markers.
          //   - Yes → keep the auto-detected variant (no overwrite
          //     needed).
          if (result && result.success && result.data) {
            const manual = manualEnteredVariantRef.current;
            if (manual !== null && manual.length > 0) {
              // PR T Item 3 — user typed a parallel inline; thread it
              // onto the cardData so /result and the eBay query use
              // the user's value, not the auto-detected one.
              result.data.foilType = manual;
              result.data.variant = manual;
              result.data.isFoil = true;
            } else if (
              confirmedVariantRef.current === null ||
              manual === ""
            ) {
              // No-with-blank-manual or No-without-manual (legacy
              // path). Treat as base card.
              result.data.foilType = null;
              result.data.variant = null;
              result.data.isFoil = false;
            }
          }
        } else if (streamResp.status === 429) {
          // Quota gate hit — body is JSON, not SSE.
          httpStatus = 429;
        } else {
          // Streaming sibling missing or unsupported — fall back below.
          throw new Error(`Streaming unavailable (status ${streamResp.status})`);
        }
      } catch (streamErr) {
        console.warn(
          "[Scan] streaming analyze unavailable, falling back to legacy route:",
          streamErr,
        );
        usedStreaming = false;
        const legacy = await fetch("/api/analyze-card-dual-images", {
          method: "POST",
          body: formData,
        });
        httpStatus = legacy.status;
        if (legacy.ok) {
          result = await legacy.json();
          // No live chip events arrived — tick everything green now that
          // the legacy response has landed so the UI still tells the user
          // the work finished.
          completeAllStages();
        }
      }

      timing.responseReceivedAt = performance.now();
      console.log(
        `[holo-timing] response received +${(timing.responseReceivedAt - timing.clickedAt).toFixed(0)}ms ` +
          `(network+server: ${(timing.responseReceivedAt - timing.requestSentAt).toFixed(0)}ms)` +
          ` streaming=${usedStreaming}`,
      );
      // Beta scan cap: surface a friendly message + bail before parsing
      // the body. The server returns { error: 'limit_reached', limit, used }
      // which we don't need to display — the TopBar usage pill already
      // renders the numbers, so the toast just needs to explain *why*.
      if (httpStatus === 429) {
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
      if (!result || httpStatus < 200 || httpStatus >= 300) {
        throw new Error("Analysis failed");
      }
      console.log("[Scan] analyze response", {
        httpStatus,
        streaming: usedStreaming,
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
      // PR S Item 3 — capture the streaming-modal decision so the
      // result page knows whether to skip the legacy
      // GeminiParallelPickerSheet "Yes/No" stage entirely.
      //
      // PR T Item 3 extends this: when the user typed a parallel in
      // the inline manual-entry modal (or saved it blank for base),
      // they've already picked the value — the result page must NOT
      // re-prompt them with the legacy freetext modal. We treat
      // "manual modal answered" as equivalent to streaming-Yes for
      // dedupe purposes (skipToPricing).
      //
      //   - confirmedVariantRef.current === undefined AND no manual
      //     entry → modal never fired. Result page falls back.
      //   - confirmedVariantRef.current is a string → user said Yes.
      //     Skip the legacy modal; use confirmed parallel.
      //   - manualEnteredVariantRef.current !== null (user saved
      //     anything in the inline manual modal, including blank) →
      //     skip the legacy modal entirely.
      //   - confirmedVariantRef.current === null AND manual ref still
      //     null → No without manual entry (shouldn't happen in PR T
      //     since onNo opens the manual modal, but defensive). Fall
      //     back to legacy freetext.
      const manualAnsweredInStream =
        manualEnteredVariantRef.current !== null;
      const streamingAnswered =
        confirmedVariantRef.current !== undefined || manualAnsweredInStream;
      const streamingYes =
        manualAnsweredInStream ||
        (streamingAnswered && confirmedVariantRef.current !== null);
      // PR W: trace the eBay payload received from the server so we can
      // tell at-a-glance whether the result page will render a price +
      // URL (summary present + count > 0) or fall back to the legacy
      // mount-time fetch (summary null).
      console.log('[holo-ebay] result received:', {
        hasComps: !!result.data?.comps,
        compsActiveCount: Array.isArray(result.data?.comps?.active)
          ? result.data.comps.active.length
          : 0,
        hasSummary: !!result.data?.summary,
        summaryCount: result.data?.summary?.count ?? null,
        summaryMean: result.data?.summary?.mean ?? null,
        summaryQuery: result.data?.summary?.query ?? null,
        compsQuery: result.data?.compsQuery ?? null,
        foilType: result.data?.foilType ?? null,
      });
      setAll({
        frontImage,
        backImage,
        cardData: result.data,
        holoGrade: (result.data.holo as HoloGrade) ?? null,
        // Audit-row id from analyze; threaded into _scanTracking._userScanId
        // on save so the row is promoted in place rather than duplicated.
        userScanId: resolvedUserScanId,
        // BR-2: top-N active eBay listings the server fired in parallel with
        // combineCardResults. Null when the server skipped (incomplete
        // identity), timed out at 1500ms, or errored — EbayActiveComps then
        // falls back to its mount-time fetch.
        initialComps: result.data?.comps ?? null,
        // PR W: pre-fired CompsSummary so EbayActiveComps renders price +
        // "Browse on eBay" URL from the server-computed pool instead of
        // re-fetching through a different eBay code path on mount.
        initialSummary: result.data?.summary ?? null,
        compsQuery: result.data?.compsQuery ?? null,
        streamingConfirmAnswered: streamingAnswered,
        parallelConfirmedInStream: streamingAnswered ? streamingYes : null,
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
          {/* The page-level RAW/GRADED pill was removed in favor of the
              in-camera pill (PR #216). `scanMode` state still drives the
              camera modal's mode and is persisted to localStorage. */}
          <div className="px-4 grid grid-cols-2 gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
                Front
              </p>
              <SimpleImageUploader
                onImageCaptured={(img, source, quality) => {
                  setFrontImage(img);
                  // Re-take of the front in GRADED mode: clear the prior
                  // label crop. onGradedCaptured will repopulate it from
                  // the same shutter press.
                  if (scanMode !== 'graded') setGradingLabelImage("");
                  if (quality) {
                    setFrontLighting(quality.lightingState);
                    setFrontBlurScore(quality.blurScore);
                    setFrontSharpness(quality.pickedSharpness);
                  } else {
                    setFrontSharpness(null);
                  }
                  const scanId = mintScanId();
                  scanIdRef.current = scanId;
                  void firePreliminaryScan(scanId, img);
                  if (!backImage && source === "camera") {
                    setBackCameraSignal((n) => n + 1);
                  }
                }}
                cameraMode={scanMode}
                onCameraModeChange={setScanMode}
                onGradedCaptured={(_cardBody, label) => {
                  setGradingLabelImage(label);
                }}
                label="Capture front"
                cameraTitle={scanMode === 'graded' ? 'Front of Slab' : 'Front of Card'}
                existingImage={frontImage}
                openCameraSignal={frontCameraSignal}
                retakeLabel="Rescan Front"
                hideLibraryButton
                onCameraClose={() => {
                  // X on the auto-opened front camera with nothing
                  // captured yet routes back to Home so the user isn't
                  // left staring at an empty /scan page. If the front
                  // is already captured (e.g. retake → cancel), stay.
                  if (!frontImage) {
                    navigate("/");
                  }
                }}
              />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
                Back
              </p>
              <SimpleImageUploader
                onImageCaptured={(img, _source, quality) => {
                  setBackImage(img);
                  setBackSharpness(quality?.pickedSharpness ?? null);
                }}
                label="Capture back"
                cameraTitle="Back of Card"
                existingImage={backImage}
                openCameraSignal={backCameraSignal}
                retakeLabel="Rescan Back"
                hideLibraryButton
              />
            </div>
          </div>

          {/* Soft sharpness warning banners. Rendered under the
              corresponding thumbnail when the burst-picked frame scored
              below SHARPNESS_BLURRY_THRESHOLD. Non-blocking — Analyze
              stays enabled so users with a borderline-but-readable shot
              can proceed. The banner is the only signal the user sees
              about the back-side image quality (no live-preview
              visibility for the back side at the time of capture). */}
          {(isLikelyBlurry(frontSharpness) || isLikelyBlurry(backSharpness)) && (
            <div className="px-4 grid grid-cols-2 gap-3" data-testid="sharpness-warnings">
              <div>
                {isLikelyBlurry(frontSharpness) && (
                  <div
                    className="rounded-lg bg-amber-50 border border-amber-300 text-amber-900 px-2.5 py-2 text-[11px] leading-snug flex items-start gap-1.5"
                    data-testid="warning-front-blurry"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px text-amber-600" />
                    <span>Looks blurry — tap Rescan Front for a sharper shot.</span>
                  </div>
                )}
              </div>
              <div>
                {isLikelyBlurry(backSharpness) && (
                  <div
                    className="rounded-lg bg-amber-50 border border-amber-300 text-amber-900 px-2.5 py-2 text-[11px] leading-snug flex items-start gap-1.5"
                    data-testid="warning-back-blurry"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px text-amber-600" />
                    <span>Looks blurry — tap Rescan Back for a sharper shot.</span>
                  </div>
                )}
              </div>
            </div>
          )}

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
                  <RotateCw className="w-5 h-5 animate-spin" /> Processing
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
            {analyzing && (
              <div className="mt-4 space-y-3">
                <ScanProgressChips
                  stages={decoratedProgressStages({
                    stages: progressStages,
                    scanInfoNode: (
                      // PR T Item 1 — ScanInfoHeader now mounts as
                      // chip 1's inlineSlot so the layout reads
                      // "Processing → chip 1 → identity card → chip
                      // 2 → ...". The header remains visible while
                      // chip 1 is in_progress (showing skeletons)
                      // and stays through completion (revealing
                      // fields with the sequenced animation).
                      <ScanInfoHeader
                        fields={scanInfoFields}
                        showSkeletons
                      />
                    ),
                    inlineParallelNode: inlineParallel ? (
                      <InlineParallelPicker
                        variant={
                          // PR R Item 2 — when user clicked No, the
                          // picker flips to Base/no-parallel mode so
                          // the inline view stays in sync with the
                          // confirmed identity used downstream.
                          // PR T Item 3 — when user manually entered
                          // a parallel inline, surface it on the
                          // picker too.
                          manualEnteredVariant && manualEnteredVariant.length > 0
                            ? manualEnteredVariant
                            : confirmedVariant === null
                              ? null
                              : inlineParallel.variant
                        }
                        foilType={inlineParallel.foilType}
                        confidence={inlineParallel.confidence}
                        autoScrollEnabled={!userScrolledManually}
                        onBeforeAutoScroll={handleBeforeAutoScroll}
                      />
                    ) : null,
                    ebayProgress,
                  })}
                  autoScrollEnabled={!userScrolledManually}
                  onBeforeAutoScroll={handleBeforeAutoScroll}
                />
              </div>
            )}
          </div>
          <StreamingParallelConfirmDialog
            open={confirmModalOpen}
            geminiParallel={inlineParallel?.variant ?? null}
            cardDescription={describeFields(scanInfoFields)}
            onYes={() => {
              console.log('[holo-gate] confirm:yes — releasing chip 3');
              setConfirmedVariant(inlineParallel?.variant ?? null);
              confirmedVariantRef.current = inlineParallel?.variant ?? null;
              setConfirmModalOpen(false);
              confirmModalOpenRef.current = false;
              releaseChip3Gate();
              resolveConfirmGate();
            }}
            onNo={() => {
              console.log('[holo-gate] confirm:no — opening manual entry');
              setConfirmedVariant(null);
              confirmedVariantRef.current = null;
              setConfirmModalOpen(false);
              confirmModalOpenRef.current = false;
              // PR R Item 2 — visually flip the inline picker to
              // "Base" by clearing the variant string. The picker
              // mutates in place (same DOM node) so no flash.
              setInlineParallel((prev) =>
                prev ? { ...prev, variant: null } : prev,
              );
              // PR T Item 3 — INSTEAD of releasing chip 3 here, open
              // the inline manual-entry modal. Chip 3 stays in
              // `waiting` (the gate in applyStageEvent now also
              // covers manualModalOpen). The user types a parallel
              // (or leaves blank for base) and saves — that's when
              // chip 3 actually unblocks.
              setManualModalOpen(true);
              manualModalOpenRef.current = true;
            }}
            onDismiss={() => {
              // PR V hotfix — X-button or ESC dismissal of the
              // Yes/No dialog. Treat as "base card, no parallel" and
              // release the chip-3 gate immediately (no manual-entry
              // sidetrack — the user already chose to back out).
              // Without this, confirmModalOpen stays stale-true and
              // the analyze flow hangs forever waiting on
              // confirmResolveRef.current.
              console.warn('[holo-gate] confirm:dismissed — treating as base, releasing chip 3');
              setConfirmedVariant(null);
              confirmedVariantRef.current = null;
              setConfirmModalOpen(false);
              confirmModalOpenRef.current = false;
              setInlineParallel((prev) =>
                prev ? { ...prev, variant: null } : prev,
              );
              // Mirror onSave('') from the manual modal so downstream
              // logic treats this as an explicit base-card save and
              // skips the legacy result-page picker.
              setManualEnteredVariant('');
              manualEnteredVariantRef.current = '';
              releaseChip3Gate();
              resolveConfirmGate();
            }}
          />
          <StreamingManualParallelDialog
            open={manualModalOpen}
            cardDescription={describeFields(scanInfoFields)}
            onSave={(parallel) => {
              console.log('[holo-gate] manual:save — releasing chip 3');
              const trimmed = parallel.trim().slice(0, 100);
              setManualEnteredVariant(trimmed);
              manualEnteredVariantRef.current = trimmed;
              setManualModalOpen(false);
              manualModalOpenRef.current = false;
              // Reflect the user's value on the inline picker so the
              // chip stack visually catches up to what's about to
              // feed the eBay query.
              setInlineParallel((prev) =>
                prev
                  ? {
                      ...prev,
                      variant: trimmed.length > 0 ? trimmed : null,
                    }
                  : prev,
              );
              // Now that the user has confirmed a value, unblock
              // stage 3 + resolve the analyze flow's gate so eBay
              // can run with the correct query.
              releaseChip3Gate();
              resolveConfirmGate();
            }}
            onDismiss={() => {
              // PR V hotfix — dismissed via X / ESC. Save as base
              // (empty string) so the gate releases and downstream
              // dedupe treats this as "user already answered."
              console.warn('[holo-gate] manual:dismissed — saving as base, releasing chip 3');
              setManualEnteredVariant('');
              manualEnteredVariantRef.current = '';
              setManualModalOpen(false);
              manualModalOpenRef.current = false;
              setInlineParallel((prev) =>
                prev ? { ...prev, variant: null } : prev,
              );
              releaseChip3Gate();
              resolveConfirmGate();
            }}
          />
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
