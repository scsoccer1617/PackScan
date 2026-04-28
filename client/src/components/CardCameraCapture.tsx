// Free-capture camera with a faint 2.5:3.5 aiming guide.
//
// UX (per PR F-1j — simplification):
// - Shooter sees a full-bleed camera stream with a faint 2.5:3.5 outline
//   centered over it. The outline is purely an aiming guide — tap-to-focus
//   still works anywhere.
// - On shutter tap, we capture the full video frame, then crop it to the
//   exact on-screen region the guide was covering. What you see in the guide
//   is what you get in the saved photo.
// - No auto-crop pipeline, no VLM quad detection, no OpenCV. The whole
//   flow is deterministic and offline-friendly.
//
// This replaces the detection stack from PRs #49-58. The VLM + OpenCV.js
// approach never became reliable enough on mobile Safari, and field scans
// kept either hanging or mis-cropping. A user-aligned crop against a
// fixed guide ratio is strictly better for dealer bulk scanning: it's
// fast, predictable, and offline.

import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { X, Image as ImageIcon, RotateCcw, Check } from 'lucide-react';

interface CardCameraCaptureProps {
  open: boolean;
  title?: string;
  onCapture: (dataUrl: string) => void;
  onClose: () => void;
}

// Guide geometry — kept in sync between the SVG overlay and the capture
// crop math. Values are fractions of the container's width and height.
// `WIDTH_FRAC` is derived at runtime because the CSS uses
// `min(72%, calc(60vh * 2.5/3.5))`, so we measure the rendered guide box
// directly rather than re-implementing that math in JS.
const GUIDE_ASPECT = 2.5 / 3.5;

// PR #164: crop matches the visible guide rect exactly — no padding.
// PR #163 used 8% breathing room, which left fingers/sleeve/table visible
// on the review, analyzing, and result thumbnails. The user's mental
// model is "what's inside the white scan frame is what gets saved"; any
// padding violates that. Users that miss the alignment can Retake.
const CROP_PADDING_FRAC = 0;

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
  const guideRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const capturedRef = useRef(false);

  const [error, setError] = useState<string | null>(null);
  const [rawImage, setRawImage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [focusing, setFocusing] = useState(false);
  const watchdogRef = useRef<number | null>(null);
  const startAttemptRef = useRef(0);

  const detachStream = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    streamRef.current = null;
    releaseSharedStreamSoon();
  }, []);

  const armWatchdog = useCallback((attempt: number) => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
    }
    watchdogRef.current = window.setTimeout(() => {
      if (startAttemptRef.current === attempt && !streamRef.current) {
        console.warn('[CardCameraCapture] camera start watchdog fired');
        setError('Camera is taking too long to start. Tap to retry.');
        setStarting(false);
        killSharedStream();
      }
    }, 10000);
  }, []);

  const startStream = useCallback(async () => {
    if (streamRef.current && isStreamLive(streamRef.current)) return;
    setStarting(true);
    setError(null);
    const attempt = ++startAttemptRef.current;
    armWatchdog(attempt);
    cancelSharedStreamRelease();

    try {
      let stream = sharedStream;
      if (!isStreamLive(stream)) {
        killSharedStream();
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        sharedStream = stream;
      }

      if (startAttemptRef.current !== attempt) {
        // A later start attempt superseded us.
        return;
      }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try {
          await videoRef.current.play();
        } catch {}
      }

      // Try to bias the focus to continuous autofocus if the hardware
      // supports it. We don't block on this.
      try {
        const track = stream.getVideoTracks()[0];
        const caps: any = track?.getCapabilities ? track.getCapabilities() : {};
        if (caps.focusMode?.includes('continuous')) {
          await track.applyConstraints({
            advanced: [{ focusMode: 'continuous' } as any],
          });
        }
      } catch {}

      if (watchdogRef.current !== null) {
        window.clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
    } catch (err: any) {
      console.error('[CardCameraCapture] getUserMedia failed', err);
      if (err?.name === 'NotAllowedError') {
        setError('Camera permission denied. Tap Library to upload instead.');
      } else if (err?.name === 'NotFoundError') {
        setError('No camera found on this device.');
      } else {
        setError('Could not start the camera. Tap to retry.');
      }
    } finally {
      setStarting(false);
    }
  }, [armWatchdog]);

  // Crop the captured video frame to the on-screen guide rectangle.
  //
  // The <video> element uses `object-cover`, which centers and crops the
  // source to fill the container without letterboxing. The guide overlay
  // is positioned in *container* coordinates. To crop the source image to
  // the guide rect we have to invert object-cover: figure out what region
  // of the video source corresponds to the container box, then map the
  // guide's container-relative rect into source pixel space.
  const captureGuideCrop = useCallback((): string | null => {
    const video = videoRef.current;
    const container = containerRef.current;
    const guide = guideRef.current;
    if (!video || !container || !guide) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const containerRect = container.getBoundingClientRect();
    const guideRect = guide.getBoundingClientRect();
    const cw = containerRect.width;
    const ch = containerRect.height;
    if (!cw || !ch) return null;

    // --- Invert object-cover: compute the source rect that the container
    // displays. object-cover scales the source uniformly to fully cover
    // the container, cropping whichever dimension is "extra".
    const videoAspect = vw / vh;
    const containerAspect = cw / ch;
    let srcX = 0;
    let srcY = 0;
    let srcW = vw;
    let srcH = vh;
    if (videoAspect > containerAspect) {
      // Video is wider than container — horizontal slice cropped on both sides.
      srcW = vh * containerAspect;
      srcX = (vw - srcW) / 2;
    } else {
      // Video is taller than container — vertical slice cropped top/bottom.
      srcH = vw / containerAspect;
      srcY = (vh - srcH) / 2;
    }

    // --- Map the guide's container-relative rect into source pixel space,
    // then pad outward by CROP_PADDING_FRAC on each side so the saved
    // photo has a little breathing room around the guide outline. The
    // padding is applied in container coordinates first, then mapped to
    // source pixels, so padding stays visually consistent regardless of
    // the video-vs-container aspect mismatch.
    const padX = guideRect.width * CROP_PADDING_FRAC;
    const padY = guideRect.height * CROP_PADDING_FRAC;
    const paddedLeft = guideRect.left - containerRect.left - padX;
    const paddedTop = guideRect.top - containerRect.top - padY;
    const paddedWidth = guideRect.width + padX * 2;
    const paddedHeight = guideRect.height + padY * 2;

    const gLeftFrac = paddedLeft / cw;
    const gTopFrac = paddedTop / ch;
    const gWidthFrac = paddedWidth / cw;
    const gHeightFrac = paddedHeight / ch;

    const cropX = Math.round(srcX + gLeftFrac * srcW);
    const cropY = Math.round(srcY + gTopFrac * srcH);
    const cropW = Math.round(gWidthFrac * srcW);
    const cropH = Math.round(gHeightFrac * srcH);

    // Guard against off-by-one edge cases.
    const safeX = Math.max(0, Math.min(vw - 1, cropX));
    const safeY = Math.max(0, Math.min(vh - 1, cropY));
    const safeW = Math.max(1, Math.min(vw - safeX, cropW));
    const safeH = Math.max(1, Math.min(vh - safeY, cropH));

    const out = document.createElement('canvas');
    out.width = safeW;
    out.height = safeH;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, safeX, safeY, safeW, safeH, 0, 0, safeW, safeH);
    return out.toDataURL('image/jpeg', 0.95);
  }, []);

  const captureFrame = useCallback(() => {
    if (capturedRef.current) return;
    const cropped = captureGuideCrop();
    if (!cropped) return;
    capturedRef.current = true;
    setRawImage(cropped);
  }, [captureGuideCrop]);

  useEffect(() => {
    if (!open) {
      detachStream();
      setRawImage(null);
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

  const handleConfirm = () => {
    if (!rawImage) return;
    onCapture(rawImage);
    setRawImage(null);
  };

  const handleRetake = () => {
    setRawImage(null);
    capturedRef.current = false;
  };

  const handleLibrary = () => {
    fileInputRef.current?.click();
  };

  // Library uploads skip the guide crop — we have no camera geometry to
  // work against, so the photo is used as-is. Analyzer already handles
  // arbitrary framing.
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
    };
    reader.readAsDataURL(file);
  };

  if (!open) return null;

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
            detachStream();
            setRawImage(null);
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
        {inPreview && rawImage && (
          <img
            src={rawImage}
            alt="Captured"
            className="absolute inset-0 w-full h-full object-contain bg-black"
          />
        )}

        {/* Faint 2.5:3.5 aiming guide. This also defines the crop region
            that the shutter will capture — `guideRef` is read at capture
            time to compute the source-pixel rect. `pointer-events-none`
            so tap-to-focus still works anywhere in the viewfinder.
            PR #163: a ~70% black overlay dims everything outside the guide
            so the user's eye is pulled to the card region. The dim is
            implemented as four panels flanking a centered transparent
            cutout sized identically to the guide — same min/calc formula
            on both — so the cutout tracks the guide on any viewport. */}
        {!inPreview && (
          <div className="absolute inset-0 z-10 pointer-events-none">
            <div className="absolute inset-0 grid place-items-center">
              <div
                aria-hidden
                className="relative"
                style={{
                  width: 'min(72%, calc(60vh * 2.5 / 3.5))',
                  aspectRatio: `${GUIDE_ASPECT}`,
                  // Massive box-shadow paints the dim everywhere the
                  // element doesn't cover. spread is large enough to
                  // reach past any reasonable viewport without us having
                  // to layout four separate panel divs and keep them in
                  // sync with the guide on resize.
                  boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.7)',
                  borderRadius: '0.375rem',
                }}
              />
            </div>
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                ref={guideRef}
                className="relative"
                style={{
                  width: 'min(72%, calc(60vh * 2.5 / 3.5))',
                  aspectRatio: `${GUIDE_ASPECT}`,
                }}
              >
                {/* Soft full outline — low-opacity so it reads as a guide,
                    not a frame. */}
                <div className="absolute inset-0 rounded-md border border-white/35" />
                {/* Corner ticks — brighter at the corners so the aiming zone
                    registers at a glance even against busy backgrounds. */}
                <div className="absolute -top-px -left-px w-5 h-5 border-t-2 border-l-2 border-white/80 rounded-tl-md" />
                <div className="absolute -top-px -right-px w-5 h-5 border-t-2 border-r-2 border-white/80 rounded-tr-md" />
                <div className="absolute -bottom-px -left-px w-5 h-5 border-b-2 border-l-2 border-white/80 rounded-bl-md" />
                <div className="absolute -bottom-px -right-px w-5 h-5 border-b-2 border-r-2 border-white/80 rounded-br-md" />
              </div>
            </div>
          </div>
        )}

        {!inPreview && (
          <div
            className="absolute left-0 right-0 top-2 text-center text-white text-xs px-4 z-10 drop-shadow pointer-events-none"
          >
            {focusing
              ? 'Focusing…'
              : 'Align card inside the guide · tap to focus'}
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
