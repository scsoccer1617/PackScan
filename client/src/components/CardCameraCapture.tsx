// Free-capture + smart-crop camera.
//
// UX goals (per PR F-1):
// - No fixed card-shaped overlay to line up against. Shooter sees a plain
//   full-frame viewfinder and taps the shutter whenever they're ready.
// - After the shutter, we run classical CV edge detection (OpenCV.js) on the
//   photo to find the actual pixels where the card ends. This is the
//   Google-Lens approach: Canny → findContours → largest quad → minAreaRect.
//   If OpenCV fails (couldn't load, no contour found), we fall back to the
//   server-side VLM quad detector, then fall back to the uncropped photo.
// - We then perspective-warp the photo to a clean rectangle client-side and
//   show that as the preview. User can Retake or Use.
// - OpenCV.js (~8MB WASM) is lazy-loaded on camera open so the runtime is
//   already warm by the time the user taps the shutter.
//
// This replaces the previous "line up inside brackets + hard-crop the overlay
// rect" flow, which was frustrating for dealers bulk-scanning a box of cards.
// It also replaces the VLM-primary detection from PRs #49-52, which kept
// failing on patterned cards in novel ways because an LLM doesn't actually
// see pixel edges — it guesses at coordinates.

import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { X, Image as ImageIcon, RotateCcw, Check, Loader2, Eye, Crop } from 'lucide-react';
import {
  cropCardFromQuad,
  detectCardQuad,
  renderQuadDebugOverlay,
  type NormalizedQuad,
} from '@/lib/cardQuadCrop';
import {
  detectCardQuadWithCV,
} from '@/lib/openCVDetect';

interface CardCameraCaptureProps {
  open: boolean;
  title?: string;
  onCapture: (dataUrl: string) => void;
  onClose: () => void;
}

// Shared MediaStream cached at module scope so reopening the camera (e.g.
// front → back capture chain) reuses the same hardware stream and the
// browser never has to re-prompt for permission within a session.
let sharedStream: MediaStream | null = null;
let sharedStreamReleaseTimer: number | null = null;

function isStreamLive(stream: MediaStream | null): stream is MediaStream {
  if (!stream) return false;
  const tracks = stream.getVideoTracks();
  return tracks.length > 0 && tracks.every(t =>
    t.readyState === 'live' && !t.muted && t.enabled
  );
}

function killSharedStream() {
  if (sharedStream) {
    try { sharedStream.getTracks().forEach(t => t.stop()); } catch {}
    sharedStream = null;
  }
  if (sharedStreamReleaseTimer !== null) {
    window.clearTimeout(sharedStreamReleaseTimer);
    sharedStreamReleaseTimer = null;
  }
}

function releaseSharedStreamSoon() {
  if (sharedStreamReleaseTimer !== null) {
    window.clearTimeout(sharedStreamReleaseTimer);
  }
  sharedStreamReleaseTimer = window.setTimeout(() => {
    if (sharedStream) {
      sharedStream.getTracks().forEach(t => t.stop());
      sharedStream = null;
    }
    sharedStreamReleaseTimer = null;
  }, 120000);
}

function cancelSharedStreamRelease() {
  if (sharedStreamReleaseTimer !== null) {
    window.clearTimeout(sharedStreamReleaseTimer);
    sharedStreamReleaseTimer = null;
  }
}

export default function CardCameraCapture({
  open,
  title = 'Take Photo',
  onCapture,
  onClose,
}: CardCameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const capturedRef = useRef(false);
  const detectAbortRef = useRef<AbortController | null>(null);

  const [error, setError] = useState<string | null>(null);
  // rawImage = full-frame photo the camera just took (or the Library file).
  // croppedImage = the warped 2.5:3.5 result. Null while detection is running.
  // debugImage = rawImage with the detected quad drawn on top. Shown when the
  //   user taps the "Show original" toggle in the preview — lets us eyeball
  //   exactly which corners Haiku picked when a crop looks wrong.
  const [rawImage, setRawImage] = useState<string | null>(null);
  const [croppedImage, setCroppedImage] = useState<string | null>(null);
  const [debugImage, setDebugImage] = useState<string | null>(null);
  const [detectReason, setDetectReason] = useState<string | null>(null);
  const [showDebugView, setShowDebugView] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectionFailed, setDetectionFailed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [focusing, setFocusing] = useState(false);
  // On-screen debug HUD rendered inside the "Finding card…" veil so we can
  // diagnose hangs on mobile (iOS Safari, no devtools). Shows the current
  // pipeline stage and the elapsed ms since detection started. Updated via
  // a ref-driven tick so re-renders don't cost us anything noticeable.
  const [detectStage, setDetectStage] = useState<string>('idle');
  const [detectElapsedMs, setDetectElapsedMs] = useState<number>(0);
  const detectStartRef = useRef<number>(0);
  const detectTickRef = useRef<number | null>(null);
  const watchdogRef = useRef<number | null>(null);
  const startAttemptRef = useRef(0);

  // OpenCV-first detection is opt-in via `?cv=1` in the URL. We briefly made
  // it the default in PR #53 but it kept causing trouble on iOS Safari — the
  // WASM calls are SYNCHRONOUS and block the main thread, which means our
  // Promise.race timeouts can't fire until findContours yields. Defaulting
  // to VLM-primary (server-side Haiku) is dramatically more reliable. The
  // OpenCV path is still wired up for dev testing and a future Web Worker
  // move, we just don't run it on the hot path by default.
  const enableOpenCV = typeof window !== 'undefined'
    && /[?&]cv=1\b/.test(window.location.search);

  const detachStream = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    streamRef.current = null;
    if (isStreamLive(sharedStream)) {
      releaseSharedStreamSoon();
    }
  }, []);

  const armWatchdog = useCallback((attempt: number) => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    watchdogRef.current = window.setTimeout(() => {
      if (startAttemptRef.current !== attempt) return;
      const v = videoRef.current;
      const renderingFrames = !!v && v.readyState >= 2 && (v.videoWidth || 0) > 0;
      if (!renderingFrames) {
        console.warn('[Camera] Watchdog: no frames after 2.5s — refreshing stream');
        killSharedStream();
        streamRef.current = null;
        startStream();
      }
    }, 2500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startStream = useCallback(async () => {
    setError(null);
    capturedRef.current = false;
    cancelSharedStreamRelease();
    const attempt = ++startAttemptRef.current;

    if (isStreamLive(sharedStream)) {
      streamRef.current = sharedStream;
      if (videoRef.current) {
        videoRef.current.srcObject = sharedStream;
        try {
          await videoRef.current.play();
        } catch (err) {
          console.warn('[Camera] play() on cached stream rejected — refreshing', err);
          killSharedStream();
          streamRef.current = null;
        }
      }
      if (isStreamLive(sharedStream)) {
        armWatchdog(attempt);
        return;
      }
    }

    setStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
        audio: false,
      });
      if (startAttemptRef.current !== attempt) {
        try { stream.getTracks().forEach(t => t.stop()); } catch {}
        return;
      }
      sharedStream = stream;
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try {
          await videoRef.current.play();
        } catch (err) {
          console.warn('[Camera] play() rejected after fresh getUserMedia', err);
        }
      }
      armWatchdog(attempt);
    } catch (err: any) {
      console.error('Camera error:', err);
      if (err?.name === 'NotAllowedError') {
        setError(null);
      } else {
        setError('We couldn’t turn on your camera. Try “Library” to upload a photo of your card instead.');
      }
    } finally {
      setStarting(false);
    }
  }, [armWatchdog]);

  // Capture the full video frame — no cropping, no overlay math. The VLM will
  // find the card inside whatever we send.
  const grabFullFrame = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const out = document.createElement('canvas');
    out.width = vw;
    out.height = vh;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, vw, vh);
    return out.toDataURL('image/jpeg', 0.95);
  }, []);

  // Run quad detection on a raw image, then warp it to a clean rectangle.
  // Sets `croppedImage` on success, or marks detection as failed (the user
  // can still accept the raw image with a single tap).
  //
  // Detection order:
  //   1. (opt-in, ?cv=1) OpenCV.js Canny+contour on-device
  //   2. Server VLM (Haiku) — the default / primary detector
  //   3. Fall back to uncropped photo + amber toast
  //
  // Hard timeouts (PR #55 + PR #57):
  //   - OpenCV detect:    4s   (only runs when ?cv=1 is set). Kept short
  //                            because synchronous WASM can block the main
  //                            thread and starve timers.
  //   - VLM detect:       8s   (fetch). Haiku usually responds in ~1-2s;
  //                            we abort at 8s if the API is slow.
  //   - Overall watchdog: 12s  Belt-and-braces. Guarantees we exit the
  //                            "Finding card…" state within 12s worst case.
  //
  // On-screen debug HUD (PR #57):
  //   Each pipeline stage updates `detectStage` and a 100ms tick updates
  //   `detectElapsedMs` so the spinner shows "VLM detect · 2.4s" in real
  //   time. Lets us diagnose field hangs without devtools.
  const runDetectAndCrop = useCallback(async (raw: string) => {
    setDetecting(true);
    setDetectionFailed(false);
    setDetectReason(null);
    setCroppedImage(null);
    setDebugImage(null);
    setShowDebugView(false);
    setDetectStage('starting');
    setDetectElapsedMs(0);
    detectStartRef.current = performance.now();

    // Start a ~10Hz ticker that drives the on-screen elapsed-ms readout in
    // the "Finding card…" veil. Cheap re-renders; we clear it as soon as
    // detection finishes one way or another.
    if (detectTickRef.current !== null) {
      window.clearInterval(detectTickRef.current);
    }
    detectTickRef.current = window.setInterval(() => {
      setDetectElapsedMs(Math.round(performance.now() - detectStartRef.current));
    }, 100);
    const stopTicker = () => {
      if (detectTickRef.current !== null) {
        window.clearInterval(detectTickRef.current);
        detectTickRef.current = null;
      }
    };

    // Cancel any in-flight detection from a prior capture.
    detectAbortRef.current?.abort();
    const ac = new AbortController();
    detectAbortRef.current = ac;

    // Overall watchdog — guarantees we exit the "Finding card…" state even
    // if every inner code path hangs (OpenCV WASM assertion, server
    // unreachable with no TCP RST, browser throttling a background tab, etc.).
    // Fires setDetecting(false) and marks detection as failed so the user
    // always has the raw photo as a fallback.
    let watchdogFired = false;
    const overallWatchdog = window.setTimeout(() => {
      watchdogFired = true;
      console.warn('[CardCameraCapture] overall detection watchdog fired after 12s — forcing fallback to raw');
      try { ac.abort(); } catch {}
      setDetectionFailed(true);
      setDetecting(false);
      setDetectReason('timeout');
      setDetectStage('timeout');
      stopTicker();
    }, 12000);

    const clearWatchdog = () => {
      window.clearTimeout(overallWatchdog);
    };

    let quad: NormalizedQuad | null = null;
    let detectSource: 'opencv' | 'vlm' | null = null;

    // --- Step 1: OpenCV.js on-device detection (opt-in, hard 4s cap) ---
    if (enableOpenCV) {
      setDetectStage('opencv');
      console.log('[CardCameraCapture] step 1: OpenCV detect (4s timeout, opt-in via ?cv=1)');
      try {
        const cvStart = performance.now();
        const cvQuad = await Promise.race<NormalizedQuad | null>([
          detectCardQuadWithCV(raw),
          new Promise<NormalizedQuad | null>((resolve) =>
            window.setTimeout(() => {
              console.warn('[CardCameraCapture] OpenCV detect timed out after 4s — falling through to VLM');
              resolve(null);
            }, 4000),
          ),
        ]);
        if (ac.signal.aborted || watchdogFired) { clearWatchdog(); stopTicker(); return; }
        if (cvQuad) {
          quad = cvQuad;
          detectSource = 'opencv';
          console.log('[CardCameraCapture] OpenCV detected quad', {
            latencyMs: Math.round(performance.now() - cvStart),
          });
        } else {
          console.log('[CardCameraCapture] OpenCV found no quad (or timed out), trying VLM');
        }
      } catch (err) {
        console.warn('[CardCameraCapture] OpenCV detect threw', err);
      }
    } else {
      console.log('[CardCameraCapture] OpenCV disabled by default (enable with ?cv=1)');
    }

    // --- Step 2: VLM detection (hard 8s cap) ---
    if (!quad && !watchdogFired) {
      setDetectStage('vlm');
      console.log('[CardCameraCapture] step 2: VLM detect (8s timeout)');
      const vlmStart = performance.now();
      const vlmTimer = window.setTimeout(() => {
        console.warn('[CardCameraCapture] VLM detect timed out after 8s — aborting fetch');
        try { ac.abort(); } catch {}
      }, 8000);
      try {
        const result = await detectCardQuad(raw, { signal: ac.signal });
        if (result.ok) {
          quad = result.quad;
          detectSource = 'vlm';
          console.log('[CardCameraCapture] VLM detected quad', {
            latencyMs: Math.round(performance.now() - vlmStart),
          });
        } else {
          console.log('[CardCameraCapture] VLM returned no quad', result.reason);
          setDetectReason(result.reason);
        }
      } catch (err) {
        if ((err as any)?.name !== 'AbortError') {
          console.warn('[CardCameraCapture] VLM detect error', err);
        }
      } finally {
        window.clearTimeout(vlmTimer);
      }
    }

    if (ac.signal.aborted || watchdogFired) { clearWatchdog(); stopTicker(); return; }

    if (!quad) {
      console.log('[CardCameraCapture] no quad — falling back to raw');
      setDetectionFailed(true);
      setDetecting(false);
      setDetectStage('failed');
      clearWatchdog();
      stopTicker();
      return;
    }
    console.log('[CardCameraCapture] using quad from', detectSource);
    setDetectStage('warping');

    try {
      // Render both the warped crop AND the debug overlay concurrently —
      // they're both pure-canvas operations and we want the debug view
      // ready instantly if the user taps "Show original".
      const [cropped, debug] = await Promise.all([
        cropCardFromQuad(raw, quad),
        renderQuadDebugOverlay(raw, quad).catch((err) => {
          console.warn('[CardCameraCapture] debug render failed', err);
          return null;
        }),
      ]);
      if (ac.signal.aborted || watchdogFired) { clearWatchdog(); stopTicker(); return; }
      setCroppedImage(cropped);
      setDebugImage(debug);
      setDetectStage('done');
      console.log('[CardCameraCapture] warp complete, preview ready');
    } catch (err) {
      console.warn('[CardCameraCapture] warp error', err);
      setDetectionFailed(true);
      setDetectStage('warp_error');
    } finally {
      setDetecting(false);
      clearWatchdog();
      stopTicker();
    }
  }, [enableOpenCV]);

  const captureFrame = useCallback(() => {
    if (capturedRef.current) return;
    const raw = grabFullFrame();
    if (!raw) return;
    capturedRef.current = true;
    setRawImage(raw);
    void runDetectAndCrop(raw);
  }, [grabFullFrame, runDetectAndCrop]);

  useEffect(() => {
    if (!open) {
      detachStream();
      setRawImage(null);
      setCroppedImage(null);
      setDebugImage(null);
      setShowDebugView(false);
      setDetectReason(null);
      setDetecting(false);
      setDetectionFailed(false);
      detectAbortRef.current?.abort();
      detectAbortRef.current = null;
      if (watchdogRef.current !== null) {
        window.clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
      return;
    }
    startStream();
    // Note: we intentionally do NOT pre-warm OpenCV.js here. Doing so ran
    // the 8MB WASM download concurrently with getUserMedia on low-power
    // mobile devices and stalled the camera at "Starting camera…" (PR #54
    // regression fix). OpenCV is now lazy-loaded on first capture instead;
    // the tradeoff is a ~500ms delay the first time the user shoots a card,
    // which is strictly better than the camera not coming up at all.
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        if (!isStreamLive(sharedStream)) killSharedStream();
        startStream();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
      if (watchdogRef.current !== null) {
        window.clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
      detachStream();
    };
  }, [open, startStream, detachStream]);

  // Re-attach the live stream when coming back from a preview to the viewfinder.
  useEffect(() => {
    if (!open || rawImage) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (video && stream && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }
  }, [open, rawImage]);

  const handleTapFocus = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    const stream = streamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const caps: any = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.focusMode || !caps.focusMode.includes('single-shot')) {
      setFocusing(true);
      try {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as any] });
      } catch {}
      window.setTimeout(() => setFocusing(false), 700);
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setFocusing(true);
    try {
      await track.applyConstraints({
        advanced: [{
          focusMode: 'single-shot',
          pointsOfInterest: [{ x, y }],
        } as any],
      });
    } catch {}
    window.setTimeout(() => setFocusing(false), 700);
  }, []);

  // "Use Photo" — prefer the auto-cropped version, fall back to raw if
  // detection failed or the user explicitly chose to use the original.
  const handleConfirm = () => {
    const final = showDebugView
      ? (rawImage ?? croppedImage)
      : (croppedImage ?? rawImage);
    if (!final) return;
    onCapture(final);
    setRawImage(null);
    setCroppedImage(null);
    setDebugImage(null);
    setShowDebugView(false);
    setDetectionFailed(false);
    setDetectReason(null);
  };

  const handleRetake = () => {
    detectAbortRef.current?.abort();
    detectAbortRef.current = null;
    setRawImage(null);
    setCroppedImage(null);
    setDebugImage(null);
    setShowDebugView(false);
    setDetectReason(null);
    setDetecting(false);
    setDetectionFailed(false);
    capturedRef.current = false;
  };

  const handleLibrary = () => {
    fileInputRef.current?.click();
  };

  // Library uploads go through the same detect+warp pipeline — keeps the
  // downstream analyzer happy whether the photo came from the camera or a
  // previously-taken library shot.
  const handleLibraryFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string;
      if (!dataUrl) return;
      capturedRef.current = true;
      setRawImage(dataUrl);
      void runDetectAndCrop(dataUrl);
    };
    reader.readAsDataURL(file);
  };

  if (!open) return null;

  // Which image the user is currently looking at in the preview pane:
  // - Default: the auto-cropped result (or the raw frame if detection failed)
  // - Toggled: the raw frame with the detected quad drawn on top (if available)
  //   or the plain raw frame (if detection failed)
  const previewImage = showDebugView
    ? (debugImage ?? rawImage)
    : (croppedImage ?? rawImage);
  const inPreview = !!rawImage;
  const canToggleDebug = !!rawImage && !detecting;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 text-white bg-black/60 z-10">
        <div className="font-medium">{title}</div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-white hover:bg-white/10"
          onClick={() => {
            detectAbortRef.current?.abort();
            detectAbortRef.current = null;
            detachStream();
            setRawImage(null);
            setCroppedImage(null);
            onClose();
          }}
          aria-label="Close camera"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div
        ref={containerRef}
        className="relative flex-1 overflow-hidden bg-black"
        onClick={!inPreview ? handleTapFocus : undefined}
      >
        {!inPreview && (
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
        {inPreview && previewImage && (
          <img
            src={previewImage}
            alt="Captured"
            className="absolute inset-0 w-full h-full object-contain bg-black"
          />
        )}

        {!inPreview && (
          <div
            className="absolute left-0 right-0 top-2 text-center text-white text-xs px-4 z-10 drop-shadow pointer-events-none"
          >
            {focusing
              ? 'Focusing…'
              : 'Fit the whole card in frame · tap to focus'}
          </div>
        )}

        {/* Loading veil while detection runs. Shows the current stage and
            an elapsed-time readout so hangs are self-diagnosing on mobile
            (no devtools on iOS). The "Use original" escape hatch appears
            after 3s so the user never has to wait to bail out. */}
        {inPreview && detecting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/55 text-white gap-2">
            <div className="flex items-center gap-2 pointer-events-none">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Finding card…</span>
            </div>
            <div className="text-[11px] text-white/70 pointer-events-none tabular-nums">
              {detectStage} · {(detectElapsedMs / 1000).toFixed(1)}s
            </div>
            {detectElapsedMs > 3000 && rawImage && (
              <button
                type="button"
                onClick={() => {
                  console.log('[CardCameraCapture] user skipped detection, using raw');
                  detectAbortRef.current?.abort();
                  setDetecting(false);
                  setDetectionFailed(true);
                  setDetectReason('skipped');
                  setDetectStage('skipped');
                }}
                className="mt-2 bg-white/15 hover:bg-white/25 text-white text-xs rounded-full px-3 py-1.5"
              >
                Use original photo
              </button>
            )}
          </div>
        )}

        {/* Non-blocking hint when auto-crop couldn't find a card. */}
        {inPreview && !detecting && detectionFailed && (
          <div className="absolute inset-x-4 top-4 bg-amber-500/95 text-black text-xs rounded-md px-3 py-2 shadow">
            Couldn't auto-crop this photo{detectReason ? ` (${detectReason})` : ''}. You can still use it, or retake.
          </div>
        )}

        {/* Debug-view toggle — lets the user flip between the cropped result
            and the raw frame with the detected quad drawn on top. Only shown
            when detection succeeded (so there's something to compare). */}
        {inPreview && !detecting && canToggleDebug && croppedImage && debugImage && (
          <button
            type="button"
            onClick={() => setShowDebugView((v) => !v)}
            className="absolute top-3 right-3 z-20 bg-black/70 hover:bg-black/85 text-white text-xs rounded-full px-3 py-1.5 flex items-center gap-1.5 shadow"
            aria-label={showDebugView ? 'Show cropped card' : 'Show original with detected edges'}
          >
            {showDebugView ? (
              <>
                <Crop className="h-3.5 w-3.5" />
                Show cropped
              </>
            ) : (
              <>
                <Eye className="h-3.5 w-3.5" />
                Show original
              </>
            )}
          </button>
        )}

        {/* Tiny status strip at the bottom of the preview area when showing
            the debug view, so it's obvious which image you're looking at. */}
        {inPreview && showDebugView && debugImage && (
          <div className="absolute inset-x-4 bottom-3 bg-black/70 text-white text-[11px] rounded-md px-3 py-1.5 text-center pointer-events-none">
            Original photo · green outline = detected card edges
          </div>
        )}

        {error && (
          <div className="absolute inset-x-4 top-4 bg-red-600/90 text-white text-sm rounded-md px-3 py-2">
            {error}
          </div>
        )}
        {starting && !error && !inPreview && (
          <div className="absolute inset-0 flex items-center justify-center text-white/70 text-sm">
            Starting camera…
          </div>
        )}
      </div>

      <div className="bg-black/80 px-4 py-4 flex items-center justify-around z-10">
        {!inPreview ? (
          <>
            <Button
              type="button"
              variant="ghost"
              className="text-white hover:bg-white/10 flex-col h-auto py-2"
              onClick={handleLibrary}
            >
              <ImageIcon className="h-6 w-6" />
              <span className="text-xs mt-1">Library</span>
            </Button>

            <button
              type="button"
              onClick={captureFrame}
              disabled={!!error || starting}
              aria-label="Capture"
              className="relative h-16 w-16 rounded-full bg-white border-4 border-white/40 active:scale-95 transition-transform disabled:opacity-40"
            >
              <span className="absolute inset-1 rounded-full bg-white" />
            </button>

            <div className="w-[72px] text-center text-[11px] text-white/70 leading-tight">
              {error ? 'Use Library' : 'Tap to capture'}
            </div>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              className="text-white hover:bg-white/10"
              onClick={handleRetake}
            >
              <RotateCcw className="h-5 w-5 mr-2" />
              Retake
            </Button>
            <Button
              type="button"
              className="bg-emerald-500 hover:bg-emerald-600 text-white disabled:opacity-50"
              onClick={handleConfirm}
              disabled={detecting}
            >
              <Check className="h-5 w-5 mr-2" />
              Use Photo
            </Button>
          </>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleLibraryFile}
      />
    </div>
  );
}
