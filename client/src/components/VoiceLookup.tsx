// Voice Lookup — hands-free card identification on /scan.
//
// UX:
//  1. User taps the mic button while holding a card they recognize.
//  2. MediaRecorder captures up to MAX_SECONDS of audio; elapsed time shows
//     in the button label.
//  3. On stop (manual tap OR hitting the cap), we POST the audio blob to
//     /api/voice-lookup/extract which returns { transcript, fields }.
//  4. The VoiceConfirmSheet opens with editable fields. On confirm, the
//     parent receives the ExtractedCardFields and wires them into the
//     ScanFlow context just like a normal analyze payload would.
//
// Why not Web Speech API? iOS Safari's support is unreliable and its
// card-domain accuracy is poor ("Sandglitter", "Diamante", "H1" are common
// misreads). Recording → Gemini 2.5 Flash audio input is one call, native
// audio support, and returns structured JSON directly.
//
// Storage note: we stick to React state and never touch localStorage /
// sessionStorage (PackScan ships inside a sandboxed Capacitor webview in
// some builds where those APIs are blocked).

import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PsaGradeSelect from "@/components/PsaGradeSelect";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/** Max recording length — dealers speak fast, 20s is plenty for one card. */
const MAX_SECONDS = 20;

export interface ExtractedCardFields {
  sport: string | null;
  year: number | null;
  brand: string | null;
  collection: string | null;
  setName: string | null;
  playerName: string | null;
  cardNumber: string | null;
  parallel: string | null;
  serialNumber: string | null;
  /** Integer 1–10 when the user explicitly said "PSA N", else null. */
  psaGrade: number | null;
  notes: string | null;
}

interface ExtractResponse {
  success: boolean;
  transcript?: string;
  fields?: ExtractedCardFields;
  reason?: string;
  message?: string;
}

interface VoiceLookupProps {
  /** Called when the user confirms the extracted fields in the sheet.
   *  `voiceScanId` (when present) identifies a server-side speculative SCP
   *  lookup fired during extract — the parent uses it to retrieve the
   *  cached result and seed cardData.speculativeCatalog before navigating
   *  to /result, mirroring F-3b for image scans. */
  onConfirm: (fields: ExtractedCardFields, voiceScanId: string | null) => void;
  /** Optional — disable the button while a sibling action is running. */
  disabled?: boolean;
}

/** Mint a short opaque id for the voice speculative SCP lookup. Mirrors
 *  mintScanId in pages/Scan.tsx so both flows use the same id shape. */
function mintVoiceScanId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `voice-${crypto.randomUUID()}`;
  }
  return `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Fire-and-forget speculative SCP kickoff. Never awaited by the caller —
 *  a network hiccup here must not block the confirm sheet opening. */
async function fireVoicePreliminary(
  voiceScanId: string,
  fields: ExtractedCardFields,
): Promise<void> {
  try {
    await fetch('/api/voice-lookup/preliminary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceScanId, fields }),
    });
  } catch (err) {
    console.warn('[VoiceLookup] preliminary kickoff failed (non-blocking):', err);
  }
}

// Pick a MediaRecorder mimeType that both iOS Safari and desktop Chrome can
// encode. Gemini accepts both webm/opus and mp4/aac via native audio input.
function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus", // Chrome / Firefox / Android
    "audio/webm",
    "audio/mp4", // iOS Safari (AAC)
    "audio/ogg;codecs=opus",
  ];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* isTypeSupported can throw on very old browsers */
    }
  }
  return "";
}

export default function VoiceLookup({ onConfirm, disabled }: VoiceLookupProps) {
  const { toast } = useToast();

  // ── Recording state ────────────────────────────────────────────────────
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [uploading, setUploading] = useState(false);

  // Active recorder + stream refs so both the manual "stop" tap AND the
  // auto-stop timer can tear down cleanly without stepping on each other.
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Confirm sheet state ────────────────────────────────────────────────
  const [sheetOpen, setSheetOpen] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [draft, setDraft] = useState<ExtractedCardFields | null>(null);
  // Voice speculative SCP id — minted + fired once per successful extract;
  // handed to the parent on confirm so /result can seed speculativeCatalog.
  // Reset to null whenever the sheet closes or a new recording starts.
  const [voiceScanId, setVoiceScanId] = useState<string | null>(null);

  // ── Cleanup on unmount (component removed mid-recording) ──────────────
  useEffect(() => {
    return () => {
      cleanupRecording();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanupRecording() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const stream = mediaStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    mediaRecorderRef.current = null;
  }

  async function handleStart() {
    if (recording || uploading) return;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast({
        title: "Microphone not available",
        description: "Your browser doesn't expose microphone access here.",
        variant: "destructive",
      });
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn("[VoiceLookup] mic permission denied:", err);
      toast({
        title: "Microphone permission needed",
        description: "Allow microphone access, then tap the mic again.",
        variant: "destructive",
      });
      return;
    }

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (err) {
      console.warn("[VoiceLookup] MediaRecorder init failed:", err);
      stream.getTracks().forEach((t) => t.stop());
      toast({
        title: "Recording not supported",
        description: "This browser couldn't start a recording.",
        variant: "destructive",
      });
      return;
    }

    chunksRef.current = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    recorder.onstop = () => {
      const effectiveType = recorder.mimeType || mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: effectiveType });
      cleanupRecording();
      setRecording(false);
      void uploadAudio(blob);
    };

    mediaStreamRef.current = stream;
    mediaRecorderRef.current = recorder;
    recorder.start();

    setRecording(true);
    setElapsed(0);

    // Tick the elapsed counter so the button label shows progress.
    tickRef.current = setInterval(() => {
      setElapsed((n) => n + 1);
    }, 1000);

    // Hard cap so a user who taps and walks away doesn't stream forever.
    timeoutRef.current = setTimeout(() => {
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
    }, MAX_SECONDS * 1000);
  }

  function handleStop() {
    const r = mediaRecorderRef.current;
    if (r && r.state === "recording") {
      r.stop(); // the onstop handler does the rest
    } else {
      cleanupRecording();
      setRecording(false);
    }
  }

  async function uploadAudio(blob: Blob) {
    if (blob.size === 0) {
      toast({
        title: "No audio captured",
        description: "Try again and hold the mic button a little longer.",
        variant: "destructive",
      });
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      // Extension matches mimeType for server-side clarity; Gemini ignores it.
      const ext = blob.type.includes("mp4")
        ? "m4a"
        : blob.type.includes("ogg")
          ? "ogg"
          : "webm";
      form.append("audio", blob, `voice.${ext}`);

      const response = await fetch("/api/voice-lookup/extract", {
        method: "POST",
        body: form,
      });
      const body: ExtractResponse = await response.json().catch(() => ({ success: false }));

      if (!body.success || !body.fields) {
        // Map server reason → a more informative toast title so a missing
        // API key / empty recording / rate-limit all read differently
        // instead of all showing "Voice lookup failed".
        const titleByReason: Record<string, string> = {
          not_configured: "Voice lookup not set up",
          audio_too_short: "Recording too short",
          no_speech: "No speech detected",
          audio_invalid: "Audio format not supported",
          file_too_large: "Recording too long",
          missing_audio: "No audio captured",
          api_error: "Voice lookup failed",
          internal_error: "Voice lookup failed",
        };
        const title = titleByReason[body.reason || ""] || "Voice lookup failed";
        console.warn("[VoiceLookup] server error", { reason: body.reason, message: body.message });
        toast({
          title,
          description: body.message || "Try again and speak clearly.",
          variant: "destructive",
          duration: 8000,
        });
        return;
      }

      setTranscript(body.transcript || "");
      setDraft(body.fields);
      setSheetOpen(true);

      // Fire speculative SCP in parallel with the confirm sheet rendering.
      // By the time the user reviews + taps Confirm (typically 3–6s), the
      // background lookup on the server has usually resolved, so /result
      // can render SCP pricing immediately without a second round trip.
      const newId = mintVoiceScanId();
      setVoiceScanId(newId);
      void fireVoicePreliminary(newId, body.fields);
    } catch (err) {
      console.error("[VoiceLookup] upload failed:", err);
      toast({
        title: "Voice lookup failed",
        description: "Network error. Please try again.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  }

  function updateDraft<K extends keyof ExtractedCardFields>(
    key: K,
    value: ExtractedCardFields[K],
  ) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function handleConfirm() {
    if (!draft) return;
    // Minimum viable identity: we need at least a player name OR (year + brand)
    // to have any chance of an SCP/eBay match. Warn but don't block — the
    // dealer may know the call will still work.
    if (!draft.playerName && !(draft.year && draft.brand)) {
      toast({
        title: "Not much to go on",
        description:
          "We didn't catch a player or a year + brand — results may be limited.",
      });
    }
    setSheetOpen(false);
    onConfirm(draft, voiceScanId);
    // Drop the id so if the user records another card in the same session
    // we don't accidentally forward a stale speculative from the previous
    // scan. A new recording mints a fresh id inside the extract handler.
    setVoiceScanId(null);
  }

  // ── Render ──────────────────────────────────────────────────────────────
  const buttonDisabled = disabled || uploading;
  const secondsLeft = Math.max(0, MAX_SECONDS - elapsed);

  return (
    <>
      <button
        type="button"
        onClick={recording ? handleStop : handleStart}
        disabled={buttonDisabled}
        className={cn(
          "w-full h-12 rounded-2xl font-display font-semibold text-sm flex items-center justify-center gap-2 transition border",
          recording
            ? "bg-red-500 text-white border-red-500"
            : uploading
              ? "bg-slate-100 text-slate-500 border-slate-200 cursor-wait"
              : "bg-white text-ink border-slate-300 hover:border-slate-400",
        )}
        data-testid="button-voice-lookup"
      >
        {uploading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Transcribing…
          </>
        ) : recording ? (
          <>
            <Square className="w-4 h-4 fill-white" />
            Stop ({secondsLeft}s)
          </>
        ) : (
          <>
            <Mic className="w-4 h-4" />
            Describe a card
          </>
        )}
      </button>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl max-h-[90vh] overflow-y-auto">
          <SheetHeader className="text-left">
            <SheetTitle>Confirm the card</SheetTitle>
            <SheetDescription>
              Edit any field before we price it.
            </SheetDescription>
          </SheetHeader>

          {transcript && (
            <div className="mt-3 px-3 py-2 rounded-lg bg-slate-50 text-xs text-slate-600">
              <span className="font-semibold text-slate-700">You said:</span>{" "}
              &ldquo;{transcript}&rdquo;
            </div>
          )}

          {draft && (
            <div className="mt-4 space-y-3">
              <FieldRow
                label="Player"
                value={draft.playerName}
                onChange={(v) => updateDraft("playerName", v)}
                placeholder="e.g. Nolan Arenado"
                testId="voice-field-player"
              />
              <div className="grid grid-cols-2 gap-3">
                <FieldRow
                  label="Year"
                  value={draft.year?.toString() ?? null}
                  onChange={(v) => {
                    const n = v ? parseInt(v, 10) : NaN;
                    updateDraft("year", Number.isFinite(n) ? n : null);
                  }}
                  placeholder="2025"
                  inputMode="numeric"
                  testId="voice-field-year"
                />
                <FieldRow
                  label="Brand"
                  value={draft.brand}
                  onChange={(v) => updateDraft("brand", v)}
                  placeholder="Topps"
                  testId="voice-field-brand"
                />
              </div>
              <FieldRow
                label="Set / Collection"
                value={draft.collection}
                onChange={(v) => updateDraft("collection", v)}
                placeholder="Series One"
                testId="voice-field-collection"
              />
              <div className="grid grid-cols-2 gap-3">
                <FieldRow
                  label="Card #"
                  value={draft.cardNumber}
                  onChange={(v) => updateDraft("cardNumber", v)}
                  placeholder="193"
                  testId="voice-field-card-number"
                />
                <FieldRow
                  label="Serial"
                  value={draft.serialNumber}
                  onChange={(v) => updateDraft("serialNumber", v)}
                  placeholder="12/99"
                  testId="voice-field-serial"
                />
              </div>
              <FieldRow
                label="Parallel"
                value={draft.parallel}
                onChange={(v) => updateDraft("parallel", v)}
                placeholder="Pink Green Polka Dots"
                testId="voice-field-parallel"
              />
              <PsaGradeSelect
                value={draft.psaGrade}
                onChange={(psa) => updateDraft("psaGrade", psa)}
              />
            </div>
          )}

          <SheetFooter className="mt-5 flex-row gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setSheetOpen(false)}
              className="flex-1"
              data-testid="button-voice-cancel"
            >
              <X className="w-4 h-4 mr-1.5" />
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleConfirm}
              className="flex-1 bg-foil text-white hover:bg-foil/90"
              data-testid="button-voice-confirm"
            >
              <Check className="w-4 h-4 mr-1.5" />
              Look up
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

// ── Small helper row ───────────────────────────────────────────────────────
interface FieldRowProps {
  label: string;
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: "text" | "numeric";
  testId: string;
}

function FieldRow({ label, value, onChange, placeholder, inputMode, testId }: FieldRowProps) {
  return (
    <div>
      <Label className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">
        {label}
      </Label>
      <Input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        // Lighter + italic placeholder so example text ("e.g. Nolan
        // Arenado", "Topps", "2025") reads as a hint, not as real data
        // already filled in by the voice extractor.
        className="mt-1 placeholder:text-slate-400 placeholder:font-normal placeholder:italic"
        data-testid={testId}
      />
    </div>
  );
}
