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
import { X, Image as ImageIcon, RotateCcw, Check, Zap, ZapOff, Sparkles } from 'lucide-react';

/** Diagnostics computed from the live preview. Surfaced to the parent on
 *  capture so the analyze multipart can carry `clientLighting` and
 *  `clientBlurScore` for server-side logging / quality banners. */
export interface CaptureQuality {
  luminance: number | null;
  blurScore: number | null;
  lightingState: 'good' | 'low' | 'dark';
  blurState: 'sharp' | 'soft' | 'blurry';
}

interface CardCameraCaptureProps {
  open: boolean;
  title?: string;
  onCapture: (dataUrl: string, quality?: CaptureQuality) => void;
  onClose: () => void;
  /**
   * 'graded' splits the 2.5:3.5 guide into a top ~18% slab-label strip and a
   * bottom card-body region. On capture we crop both regions and hand them
   * back via `onCaptureGraded`. 'raw' (default) uses the existing single
   * full-guide crop and `onCapture`.
   */
  mode?: 'raw' | 'graded';
  /**
   * Required when mode='graded'. Receives (frontCardBody, slabLabel) data
   * URLs cropped from the same shutter press.
   */
  onCaptureGraded?: (cardBody: string, slabLabel: string) => void;
  /**
   * Optional. When provided, an inline RAW/GRADED pill renders in the
   * camera modal header so the user can switch modes without dismissing
   * the camera. Tapping a different mode calls `onModeChange(newMode)` —
   * the parent owns the state and re-renders us with a new `mode`. When
   * omitted, the pill is hidden and behavior is identical to today (so
   * SimpleCardForm and other single-mode callers are unaffected).
   */
  onModeChange?: (mode: 'raw' | 'graded') => void;
}

// Fraction of the 2.5:3.5 guide that the slab-label strip occupies in
// GRADED mode. PSA / BGS / SGC / CGC labels print at ~15-20% of slab
// height; 18% is a good middle so the model can read the label fields
// without including too much of the card body, and the card-body crop
// still covers the whole front including the bottom border.
const GRADED_LABEL_HEIGHT_FRAC = 0.18;

// Lighting / blur thresholds. Tuned against a small set of indoor /
// table-top dealer scans. Luminance is on the standard 0-255 range; blur
// score is variance-of-Laplacian (higher = sharper).
const LUM_LOW = 60;       // below this — yellow "low light" pill
const LUM_DARK = 30;      // below this — red "too dark" pill (auto-torch trigger)
const BLUR_SHARP = 50;    // above this — quietly OK
const BLUR_SOFT = 20;     // below 50, above 20 — yellow "soft" pill
                          // below 20 — red "blurry" pill + post-capture confirm
const QUALITY_SAMPLE_INTERVAL_MS = 500;
const QUALITY_SAMPLE_SIZE = 64; // downsample target for fast Laplacian
const AE_SETTLE_MS = 800; // torch-on → AE re-exposes for the lit scene → grab

type FlashMode = 'auto' | 'on' | 'off';
const FLASH_MODE_KEY = 'holo-flash-mode';

/**
 * Variance-of-Laplacian on a downsampled grayscale image. Higher = sharper.
 * Uses the 4-neighbor Laplacian kernel: L(x,y) = 4*p - p_up - p_down - p_left - p_right.
 * We downsample to QUALITY_SAMPLE_SIZE so this stays well under 1ms per call.
 */
function varianceOfLaplacian(imageData: ImageData): number {
  const { data, width, height } = imageData;
  const gray = new Float32Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const lap =
        4 * gray[idx] -
        gray[idx - 1] -
        gray[idx + 1] -
        gray[idx - width] -
        gray[idx + width];
      sum += lap;
      sumSq += lap * lap;
      n += 1;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function meanLuminance(imageData: ImageData): number {
  const { data } = imageData;
  let sum = 0;
  const stride = 4 * 4; // sample every 4th pixel for speed
  let n = 0;
  for (let i = 0; i < data.length; i += stride) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    n += 1;
  }
  return n > 0 ? sum / n : 0;
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
  mode = 'raw',
  onCaptureGraded,
  onModeChange,
}: CardCameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const guideRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const capturedRef = useRef(false);

  const [error, setError] = useState<string | null>(null);
  const [rawImage, setRawImage] = useState<string | null>(null);
  // Slab-label crop, only populated in GRADED mode. Held alongside rawImage
  // (which then represents the card-body crop) so Confirm can hand both
  // back to the parent in a single callback.
  const [labelImage, setLabelImage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [focusing, setFocusing] = useState(false);

  // Live preview diagnostics. Updated every QUALITY_SAMPLE_INTERVAL_MS.
  const [luminance, setLuminance] = useState<number | null>(null);
  const [blurScore, setBlurScore] = useState<number | null>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sampleTimerRef = useRef<number | null>(null);

  // Manual flash override: 'auto' (torch follows luminance), 'on' (force on),
  // 'off' (force off). Persisted to localStorage so dealers in dim spaces
  // don't have to flip it every session. Browsers that don't expose torch
  // capability silently ignore the constraint — UI still toggles state but
  // the hardware doesn't change.
  const [flashMode, setFlashMode] = useState<FlashMode>(() => {
    if (typeof window === 'undefined') return 'auto';
    const saved = window.localStorage.getItem(FLASH_MODE_KEY);
    return saved === 'on' || saved === 'off' || saved === 'auto' ? saved : 'auto';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(FLASH_MODE_KEY, flashMode);
  }, [flashMode]);
  const [torchCapable, setTorchCapable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  // Post-capture blur confirmation sheet. When true, the captured rawImage
  // looked blurry — show a "Use anyway?" prompt before handing back.
  const [blurConfirm, setBlurConfirm] = useState(false);
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
        // Torch capability is browser/hardware dependent. iOS Safari does
        // not expose `torch` at all; recent Chrome on Android does. We
        // probe getCapabilities() once per stream and gate the manual
        // flash-mode pill on the result.
        setTorchCapable(!!caps.torch);
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

  // Crop the captured video frame to a sub-rect of the on-screen guide.
  //
  // The <video> element uses `object-cover`, which centers and crops the
  // source to fill the container without letterboxing. The guide overlay
  // is positioned in *container* coordinates. To crop the source image to
  // a guide-relative rect we invert object-cover: figure out what region
  // of the video source corresponds to the container box, then map the
  // guide's container-relative rect (offset by yFrac / heightFrac) into
  // source pixel space.
  //
  // For RAW mode pass yFrac=0, heightFrac=1 to get the whole guide. For
  // GRADED mode we call this twice — once for the top label strip and
  // once for the card body underneath.
  const cropGuideRegion = useCallback((
    yFrac: number,
    heightFrac: number,
  ): string | null => {
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

    const videoAspect = vw / vh;
    const containerAspect = cw / ch;
    let srcX = 0;
    let srcY = 0;
    let srcW = vw;
    let srcH = vh;
    if (videoAspect > containerAspect) {
      srcW = vh * containerAspect;
      srcX = (vw - srcW) / 2;
    } else {
      srcH = vw / containerAspect;
      srcY = (vh - srcH) / 2;
    }

    const padX = guideRect.width * CROP_PADDING_FRAC;
    const padY = guideRect.height * CROP_PADDING_FRAC;
    const regionTop = guideRect.top + guideRect.height * yFrac;
    const regionHeight = guideRect.height * heightFrac;
    const paddedLeft = guideRect.left - containerRect.left - padX;
    const paddedTop = regionTop - containerRect.top - padY;
    const paddedWidth = guideRect.width + padX * 2;
    const paddedHeight = regionHeight + padY * 2;

    const gLeftFrac = paddedLeft / cw;
    const gTopFrac = paddedTop / ch;
    const gWidthFrac = paddedWidth / cw;
    const gHeightFrac = paddedHeight / ch;

    const cropX = Math.round(srcX + gLeftFrac * srcW);
    const cropY = Math.round(srcY + gTopFrac * srcH);
    const cropW = Math.round(gWidthFrac * srcW);
    const cropH = Math.round(gHeightFrac * srcH);

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

  // Apply the desired torch state to the current MediaStream. Best-effort:
  // browsers that don't expose `torch` ignore the constraint.
  const applyTorch = useCallback(async (on: boolean) => {
    const stream = streamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as any] });
      setTorchOn(on);
    } catch {
      // Some platforms throw on unsupported torch — leave torchOn unchanged.
    }
  }, []);

  // Reconcile torch state with the manual flashMode for ON/OFF only. AUTO
  // mode no longer drives steady-state torch from luminance — instead the
  // torch fires only at shutter time inside captureFrame (Apple-style
  // capture-time flash). Steady-state fill light made the camera's auto-
  // exposure repeatedly re-balance against its own light source, which
  // produced the oscillation reported in PR #237.
  useEffect(() => {
    if (!torchCapable) return;
    if (flashMode === 'on') {
      if (!torchOn) void applyTorch(true);
      return;
    }
    if (flashMode === 'off') {
      if (torchOn) void applyTorch(false);
      return;
    }
    // flashMode === 'auto': torch stays off during preview; capture-time
    // envelope in captureFrame handles the actual flash.
  }, [flashMode, torchCapable, torchOn, applyTorch]);

  // Live preview sampler: every QUALITY_SAMPLE_INTERVAL_MS take a 64×64 crop
  // from the center 60% of the video frame and compute mean luminance +
  // variance-of-Laplacian. Results drive the on-screen quality pills and
  // the auto-flash decision above.
  useEffect(() => {
    if (!open || rawImage) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const video = videoRef.current;
      if (!video || !video.videoWidth || !video.videoHeight) {
        sampleTimerRef.current = window.setTimeout(tick, QUALITY_SAMPLE_INTERVAL_MS);
        return;
      }
      try {
        let canvas = sampleCanvasRef.current;
        if (!canvas) {
          canvas = document.createElement('canvas');
          canvas.width = QUALITY_SAMPLE_SIZE;
          canvas.height = QUALITY_SAMPLE_SIZE;
          sampleCanvasRef.current = canvas;
        }
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const sw = vw * 0.6;
        const sh = vh * 0.6;
        const sx = (vw - sw) / 2;
        const sy = (vh - sh) / 2;
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, QUALITY_SAMPLE_SIZE, QUALITY_SAMPLE_SIZE);
        const img = ctx.getImageData(0, 0, QUALITY_SAMPLE_SIZE, QUALITY_SAMPLE_SIZE);
        setLuminance(meanLuminance(img));
        setBlurScore(varianceOfLaplacian(img));
      } catch {
        // Sampling failures are non-fatal — the pills just stay in their
        // last state.
      }
      sampleTimerRef.current = window.setTimeout(tick, QUALITY_SAMPLE_INTERVAL_MS);
    };
    sampleTimerRef.current = window.setTimeout(tick, QUALITY_SAMPLE_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (sampleTimerRef.current !== null) {
        window.clearTimeout(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
    };
  }, [open, rawImage]);

  const captureFrame = useCallback(async () => {
    if (capturedRef.current) return;
    // Claim early — blocks double-tap re-entry during the AE settle wait.
    capturedRef.current = true;

    // Decision is captured ONCE — locked even if the user toggles the
    // flash pill or luminance changes during the AE wait.
    const shouldFireFlash =
      torchCapable && (
        flashMode === 'on' ||
        (flashMode === 'auto' && luminance != null && luminance < LUM_LOW)
      );
    // 'on' mode is steady-state (torch already on), so this branch is
    // only true for auto-mode capture-time flash.
    const turnedOnForCapture = shouldFireFlash && !torchOn;

    try {
      if (turnedOnForCapture) {
        await applyTorch(true);
        await new Promise((r) => setTimeout(r, AE_SETTLE_MS));
      }

      if (mode === 'graded') {
        const label = cropGuideRegion(0, GRADED_LABEL_HEIGHT_FRAC);
        const body = cropGuideRegion(
          GRADED_LABEL_HEIGHT_FRAC,
          1 - GRADED_LABEL_HEIGHT_FRAC,
        );
        if (!label || !body) {
          // Crop failed (refs not ready / modal closed). Release the claim
          // so the user can re-tap once state recovers.
          capturedRef.current = false;
          return;
        }
        setLabelImage(label);
        setRawImage(body);
      } else {
        const cropped = cropGuideRegion(0, 1);
        if (!cropped) {
          capturedRef.current = false;
          return;
        }
        setRawImage(cropped);
      }
      // Blur post-capture re-check: when the live sampler scored below
      // BLUR_SOFT, surface the confirmation sheet on the preview screen so
      // the user can retake before committing to the analyze pipeline. Above
      // BLUR_SOFT we go straight to the standard preview.
      if (blurScore != null && blurScore < BLUR_SOFT) {
        setBlurConfirm(true);
      }
    } finally {
      if (turnedOnForCapture) {
        // Fire-and-forget: restore preview state. No await needed.
        void applyTorch(false);
      }
    }
  }, [cropGuideRegion, mode, blurScore, torchCapable, flashMode, luminance, torchOn, applyTorch]);

  useEffect(() => {
    if (!open) {
      detachStream();
      setRawImage(null);
      setLabelImage(null);
      setBlurConfirm(false);
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
    const lightingState: CaptureQuality['lightingState'] =
      luminance == null ? 'good' : luminance < LUM_DARK ? 'dark' : luminance < LUM_LOW ? 'low' : 'good';
    const blurState: CaptureQuality['blurState'] =
      blurScore == null ? 'sharp' : blurScore < BLUR_SOFT ? 'blurry' : blurScore < BLUR_SHARP ? 'soft' : 'sharp';
    const quality: CaptureQuality = { luminance, blurScore, lightingState, blurState };
    if (mode === 'graded' && labelImage && onCaptureGraded) {
      onCaptureGraded(rawImage, labelImage);
    } else {
      onCapture(rawImage, quality);
    }
    setRawImage(null);
    setLabelImage(null);
    setBlurConfirm(false);
  };

  const handleRetake = () => {
    setRawImage(null);
    setLabelImage(null);
    setBlurConfirm(false);
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
        {/* In-camera RAW/GRADED toggle. Rendered only when the parent
            provides `onModeChange` so single-mode callers (e.g.
            SimpleCardForm, the back-image uploader on /scan) are
            unaffected. Style mirrors the page-level pill on Scan.tsx so
            the two read as the same control. */}
        {onModeChange && (
          <div
            role="tablist"
            aria-label="Scan mode"
            className="inline-flex rounded-full border border-slate-200 bg-white p-0.5 text-xs font-semibold tracking-wide"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'raw'}
              onClick={() => onModeChange('raw')}
              className={`px-3 py-1.5 rounded-full transition ${
                mode === 'raw'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
              data-testid="button-camera-mode-raw"
            >
              RAW
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'graded'}
              onClick={() => onModeChange('graded')}
              className={`px-3 py-1.5 rounded-full transition ${
                mode === 'graded'
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
              data-testid="button-camera-mode-graded"
            >
              GRADED
            </button>
          </div>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-white hover:bg-white/10"
          onClick={() => {
            detachStream();
            setRawImage(null);
            setLabelImage(null);
            setBlurConfirm(false);
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
                {/* GRADED mode: dashed divider at 18% to show the slab-label
                    crop region, plus a tiny "LABEL" badge so first-time users
                    understand why the top strip is highlighted. */}
                {mode === 'graded' && (
                  <>
                    <div
                      className="absolute left-0 right-0 border-t border-dashed border-white/70"
                      style={{ top: `${GRADED_LABEL_HEIGHT_FRAC * 100}%` }}
                    />
                    <div className="absolute left-1 top-1 px-1.5 py-0.5 rounded bg-emerald-500/85 text-white text-[10px] font-semibold tracking-wide">
                      LABEL
                    </div>
                  </>
                )}
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
              : mode === 'graded'
                ? 'Align slab — label in top strip, card below'
                : 'Align card inside the guide · tap to focus'}
          </div>
        )}

        {/* Quality pills + flash toggle. Pinned top-right so they don't
            collide with the centered guide. Pills stay hidden when the
            sample is good — silence is the desired state. The flash
            toggle is always visible when the device exposes a torch
            capability so dealers can pre-arm flash on dim tables. */}
        {!inPreview && (
          <div className="absolute right-2 top-10 z-10 flex flex-col items-end gap-1.5 pointer-events-none">
            {luminance != null && luminance < LUM_LOW && (
              <span
                className={`pointer-events-none px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide ${
                  luminance < LUM_DARK ? 'bg-red-600 text-white' : 'bg-amber-500 text-white'
                }`}
                data-testid="pill-lighting"
              >
                {luminance < LUM_DARK ? 'TOO DARK' : 'LOW LIGHT'}
              </span>
            )}
            {blurScore != null && blurScore < BLUR_SHARP && (
              <span
                className={`pointer-events-none px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide ${
                  blurScore < BLUR_SOFT ? 'bg-red-600 text-white' : 'bg-amber-500 text-white'
                }`}
                data-testid="pill-blur"
              >
                {blurScore < BLUR_SOFT ? 'BLURRY' : 'HOLD STEADY'}
              </span>
            )}
            {torchCapable && (
              <button
                type="button"
                onClick={() => {
                  setFlashMode((m) => (m === 'auto' ? 'on' : m === 'on' ? 'off' : 'auto'));
                }}
                className="pointer-events-auto h-8 px-2.5 rounded-full bg-black/60 text-white text-[11px] font-semibold flex items-center gap-1 active:scale-95 transition-transform"
                aria-label={`Flash ${flashMode}`}
                data-testid="button-flash-mode"
              >
                {flashMode === 'on' ? (
                  <Zap className="h-3.5 w-3.5 fill-yellow-300 text-yellow-300" />
                ) : flashMode === 'off' ? (
                  <ZapOff className="h-3.5 w-3.5" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                <span className="uppercase">{flashMode}</span>
              </button>
            )}
          </div>
        )}

        {/* Post-capture blur confirmation. Shown over the preview when the
            live sampler caught a blurry frame at shutter time. Two paths:
            Retake (default outline) drops back into the viewfinder;
            Use Anyway commits the photo to the analyze pipeline. */}
        {inPreview && blurConfirm && (
          <div className="absolute inset-x-4 bottom-4 bg-amber-50 border border-amber-300 text-amber-900 rounded-xl px-4 py-3 z-20 shadow-lg">
            <p className="text-sm font-semibold">Photo looks blurry.</p>
            <p className="text-xs mt-0.5 text-amber-800">
              Retake for sharper text, or use anyway if the card details are legible to you.
            </p>
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
              className="text-white hover:bg-white/10 flex-col h-auto py-2 disabled:opacity-40"
              onClick={handleLibrary}
              disabled={mode === 'graded'}
              title={mode === 'graded' ? 'Library upload disabled in Graded mode — please use the camera' : undefined}
            >
              <ImageIcon className="h-6 w-6" />
              <span className="text-xs mt-1">Library</span>
            </Button>

            {/*
              One-handed scanning ergonomics: the visible button stays 64×64,
              but a transparent ::before pseudo-element extends the touch area
              by 12px on every side (effective ~88×88 tap region). Layout is
              unaffected because ::before is absolutely positioned. Kept under
              the Library button's natural spacing — `justify-around` on the
              parent gives ample clearance at phone widths so the expanded
              region doesn't overlap Library or the "Tap to capture" hint.
            */}
            <button
              type="button"
              onClick={captureFrame}
              disabled={!!error || starting}
              aria-label="Capture"
              className="relative h-16 w-16 rounded-full bg-white border-4 border-white/40 active:scale-95 transition-transform disabled:opacity-40 before:content-[''] before:absolute before:-inset-3 before:rounded-full"
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
