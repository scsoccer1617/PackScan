// Free-capture + smart-crop camera.
//
// UX goals (per PR F-1):
// - No fixed card-shaped overlay to line up against. Shooter sees a plain
//   full-frame viewfinder and taps the shutter whenever they're ready.
// - After the shutter, we POST the frame to /api/vision/detect-card-quad,
//   which asks a VLM to return the card's 4 corners. We then perspective-warp
//   the photo to a clean 2.5:3.5 rectangle client-side and show that as the
//   preview. User can Retake or Use.
// - If detection fails (no card visible, parse error, timeout), we fall back
//   to the original uncropped photo and surface a small "couldn't auto-crop"
//   hint — the user can still Use the photo, which preserves the old behavior.
//
// This replaces the previous "line up inside brackets + hard-crop the overlay
// rect" flow, which was frustrating for dealers bulk-scanning a box of cards.

import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { X, Image as ImageIcon, RotateCcw, Check, Loader2 } from 'lucide-react';
import { cropCardFromQuad, detectCardQuad, type NormalizedQuad } from '@/lib/cardQuadCrop';

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
  const [rawImage, setRawImage] = useState<string | null>(null);
  const [croppedImage, setCroppedImage] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectionFailed, setDetectionFailed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [focusing, setFocusing] = useState(false);
  const watchdogRef = useRef<number | null>(null);
  const startAttemptRef = useRef(0);

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
  const runDetectAndCrop = useCallback(async (raw: string) => {
    setDetecting(true);
    setDetectionFailed(false);
    setCroppedImage(null);

    // Cancel any in-flight detection from a prior capture.
    detectAbortRef.current?.abort();
    const ac = new AbortController();
    detectAbortRef.current = ac;

    let quad: NormalizedQuad | null = null;
    try {
      quad = await detectCardQuad(raw, { signal: ac.signal });
    } catch (err) {
      if ((err as any)?.name !== 'AbortError') {
        console.warn('[CardCameraCapture] detect error', err);
      }
    }

    if (ac.signal.aborted) return;

    if (!quad) {
      setDetectionFailed(true);
      setDetecting(false);
      return;
    }

    try {
      const cropped = await cropCardFromQuad(raw, quad);
      if (ac.signal.aborted) return;
      setCroppedImage(cropped);
    } catch (err) {
      console.warn('[CardCameraCapture] warp error', err);
      setDetectionFailed(true);
    } finally {
      setDetecting(false);
    }
  }, []);

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
  // detection failed and the user still wants to proceed.
  const handleConfirm = () => {
    const final = croppedImage ?? rawImage;
    if (!final) return;
    onCapture(final);
    setRawImage(null);
    setCroppedImage(null);
    setDetectionFailed(false);
  };

  const handleRetake = () => {
    detectAbortRef.current?.abort();
    detectAbortRef.current = null;
    setRawImage(null);
    setCroppedImage(null);
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

  const previewImage = croppedImage ?? rawImage;
  const inPreview = !!rawImage;

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

        {/* Loading veil while the VLM locates the card. */}
        {inPreview && detecting && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white text-sm gap-2 pointer-events-none">
            <Loader2 className="h-5 w-5 animate-spin" />
            Finding card…
          </div>
        )}

        {/* Non-blocking hint when auto-crop couldn't find a card. */}
        {inPreview && !detecting && detectionFailed && (
          <div className="absolute inset-x-4 top-4 bg-amber-500/95 text-black text-xs rounded-md px-3 py-2 shadow">
            Couldn't auto-crop this photo. You can still use it, or retake.
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
