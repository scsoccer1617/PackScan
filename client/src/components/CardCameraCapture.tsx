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
import {
  scoreImageData,
  pickSharpest,
  SHARPNESS_SAMPLE_SIZE,
} from '@shared/sharpness';

/** Diagnostics computed from the live preview. Surfaced to the parent on
 *  capture so the analyze multipart can carry `clientLighting` and
 *  `clientBlurScore` for server-side logging / quality banners.
 *
 *  `pickedSharpness` is the variance-of-Laplacian score of the frame the
 *  3-frame burst selected — measured on the 480x480 center crop of the
 *  full video frame, distinct from `blurScore` (which is the live-preview
 *  64x64 sample at shutter-press time). The two are kept separate so the
 *  pre-shutter pill and the post-shutter banner stay apples-to-apples
 *  with their own reference points. */
export interface CaptureQuality {
  luminance: number | null;
  blurScore: number | null;
  lightingState: 'good' | 'low' | 'dark';
  blurState: 'sharp' | 'soft' | 'blurry';
  pickedSharpness: number | null;
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
// 700ms: enough for iOS Safari AE to converge to torch illumination so the
// captured frame isn't washed out. Hand-drift during this window used to
// shift the card off-center, but the frozen-preview overlay (below) eliminates
// the visual feedback loop that drove the drift — the user sees a steady
// snapshot, not a moving preview, and naturally holds still.
const AE_SETTLE_MS = 700;

// 3-frame burst settings. We grab three frames spaced BURST_INTERVAL_MS
// apart and keep whichever scores highest on variance-of-Laplacian. Three
// frames at ~150ms covers the typical hand-tremor envelope without
// noticeably stretching the shutter latency (total burst window ≈ 300ms).
// On devices that can't snapshot fast enough we fall back to whatever the
// burst produced — even one frame is fine, the burst just degrades to a
// single-frame capture in that case.
const BURST_FRAMES = 3;
const BURST_INTERVAL_MS = 150;

// AF settle wait used when we explicitly issue a single-shot focus
// request before the burst. Empirically converges in 350-450ms on iOS
// Safari and recent Android Chrome — pick the upper bound so the burst
// fires after the lens has stopped hunting. Skipped silently when the
// device doesn't expose `single-shot` focusMode (most desktop browsers,
// older Android stock browsers).
const AF_SETTLE_MS = 400;

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
  // Sharpness score of the burst-picked frame, set inside captureFrame
  // and read by handleConfirm. A ref instead of state so the value
  // doesn't trigger re-renders during the post-capture preview screen.
  const pickedSharpnessRef = useRef<number | null>(null);
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
  // True while a capture-time flash sequence is mid-flight. Drives the
  // overlay that prompts the user to keep the camera steady through the
  // brief settle wait.
  const [capturing, setCapturing] = useState(false);
  const [frozenPreviewDataUrl, setFrozenPreviewDataUrl] = useState<string | null>(null);
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
  type CropSource = {
    kind: 'image';
    image: HTMLImageElement;
    naturalWidth: number;
    naturalHeight: number;
    boost?: boolean;
  };
  const cropGuideRegion = useCallback((
    yFrac: number,
    heightFrac: number,
    source?: CropSource,
  ): string | null => {
    const container = containerRef.current;
    const guide = guideRef.current;
    if (!container || !guide) return null;

    // Source dimensions: either the live video frame OR the decoded frozen
    // snapshot taken at shutter-tap time. Cropping from the snapshot
    // eliminates the hand-drift window introduced by the AE settle wait —
    // the user's framing intent is captured the instant they tap, not 700ms
    // later. The orientation-swap and inverse-object-cover math below
    // applies identically to both sources because `snapshotFullVideoFrame`
    // preserves the video's intrinsic dim convention.
    let drawSource: CanvasImageSource;
    let vw: number;
    let vh: number;
    if (source?.kind === 'image') {
      drawSource = source.image;
      vw = source.naturalWidth;
      vh = source.naturalHeight;
    } else {
      const video = videoRef.current;
      if (!video) return null;
      drawSource = video;
      vw = video.videoWidth;
      vh = video.videoHeight;
    }
    if (!vw || !vh) return null;

    const containerRect = container.getBoundingClientRect();
    const guideRect = guide.getBoundingClientRect();
    const cw = containerRect.width;
    const ch = containerRect.height;
    if (!cw || !ch) return null;

    // iOS Safari can report videoWidth/videoHeight in sensor-native landscape
    // even when the <video> element is displayed rotated to portrait. Detect
    // the mismatch by comparing the sensor's portrait/landscape sense against
    // the on-screen container's, and swap so the rest of the inverse-object-cover
    // math operates on display-orientation dimensions. Branch is a no-op when
    // dimensions already match (the common case on Android Chrome and on
    // modern Safari that returns rotated dims).
    const sensorIsLandscape = vw > vh;
    const containerIsLandscape = cw > ch;
    if (sensorIsLandscape !== containerIsLandscape) {
      [vw, vh] = [vh, vw];
    }

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
    ctx.drawImage(drawSource, safeX, safeY, safeW, safeH, 0, 0, safeW, safeH);

    // Brightness boost for low-light snapshot crops only. Continuous-LED
    // torch can't deliver a real flash's instant luminance, so the
    // snapshot frame is captured under low ambient light. Gamma 0.55
    // lifts shadow/midtone detail that a pure linear gain would crush
    // less efficiently, then a 1.4x post-gamma gain pushes the result
    // bright enough to read on the review screen and for the VLM. Live
    // video crops (good-light path) skip this — they already look right.
    if (source?.kind === 'image' && source.boost) {
      const imageData = ctx.getImageData(0, 0, safeW, safeH);
      const data = imageData.data;
      const gamma = 0.55;
      const gain = 1.4;
      const lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) {
        const normalized = i / 255;
        const corrected = Math.pow(normalized, gamma) * gain;
        lut[i] = Math.max(0, Math.min(255, Math.round(corrected * 255)));
      }
      for (let i = 0; i < data.length; i += 4) {
        data[i] = lut[data[i]];
        data[i + 1] = lut[data[i + 1]];
        data[i + 2] = lut[data[i + 2]];
      }
      ctx.putImageData(imageData, 0, 0);
    }

    return out.toDataURL('image/jpeg', 0.95);
  }, []);

  // Snapshot the current video frame into a JPEG data URL for use as the
  // frozen-preview overlay during low-light capture. Uses the same source
  // frame the user is currently looking at (post-orientation-swap from the
  // existing object-cover inverse) so the frozen overlay matches the
  // viewfinder exactly. Returns null if refs aren't ready.
  const snapshotFullVideoFrame = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video) return null;
    let vw = video.videoWidth;
    let vh = video.videoHeight;
    if (!vw || !vh) return null;
    const canvas = document.createElement('canvas');
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, vw, vh);
    // 0.7 quality is fine — this is a transient overlay, not a saved asset.
    return canvas.toDataURL('image/jpeg', 0.7);
  }, []);

  // Snapshot a JPEG data URL AND score its sharpness on a 480x480 center
  // crop of the full frame. Returns null if the video isn't ready. Used
  // by the 3-frame burst path so each candidate frame is scored against
  // the same window the eventual saved crop will draw from.
  //
  // Why score the full-frame center rather than the on-screen guide
  // rect? The guide-cropped output is what the user keeps, but the burst
  // happens before any cropping — and the inverse-object-cover math in
  // cropGuideRegion needs a stable source image, not a transient
  // <video> element. Scoring a fixed center crop of the source frame is
  // both faster and deterministic across devices that rotate sensor
  // dimensions vs ones that don't.
  const captureAndScoreFrame = useCallback((): { dataUrl: string; score: number } | null => {
    const video = videoRef.current;
    if (!video) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = vw;
    fullCanvas.height = vh;
    const fullCtx = fullCanvas.getContext('2d');
    if (!fullCtx) return null;
    fullCtx.drawImage(video, 0, 0, vw, vh);
    // Score on a downsampled center crop. 480x480 preserves enough
    // high-frequency detail (back-of-card text edges) to discriminate
    // between sharp and blurry while keeping the per-frame compute well
    // under 10ms — three back-to-back scores during the 300ms burst
    // window without visible stalls.
    const cropSize = Math.min(vw, vh);
    const sx = (vw - cropSize) / 2;
    const sy = (vh - cropSize) / 2;
    const sample = document.createElement('canvas');
    sample.width = SHARPNESS_SAMPLE_SIZE;
    sample.height = SHARPNESS_SAMPLE_SIZE;
    const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
    if (!sampleCtx) return null;
    sampleCtx.drawImage(
      fullCanvas,
      sx, sy, cropSize, cropSize,
      0, 0, SHARPNESS_SAMPLE_SIZE, SHARPNESS_SAMPLE_SIZE,
    );
    const imageData = sampleCtx.getImageData(0, 0, SHARPNESS_SAMPLE_SIZE, SHARPNESS_SAMPLE_SIZE);
    const score = scoreImageData(imageData);
    const dataUrl = fullCanvas.toDataURL('image/jpeg', 0.7);
    return { dataUrl, score };
  }, []);

  // Decode a JPEG data URL into an HTMLImageElement so canvas drawImage can
  // use it as a source. Resolves once the image's pixel data is ready. Used
  // to crop from the frozen-preview snapshot (taken at shutter-tap time)
  // instead of the live, drifted post-AE-wait video frame.
  const decodeSnapshot = useCallback((dataUrl: string): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = dataUrl;
    });
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

    // ── AF lock attempt ─────────────────────────────────────────────
    // Best-effort single-shot AF before the burst. iOS Safari + recent
    // Android Chrome expose 'single-shot' focusMode via getCapabilities;
    // older browsers / desktops don't, in which case we leave the
    // continuous focus from startStream alone. Wrapped in try/catch
    // because some Android stock browsers throw on unknown advanced
    // constraints rather than ignoring them. Skipped in flash-on mode —
    // the AE settle wait below already gives the lens time to converge,
    // and stacking AF + AE adds visible latency without measurable
    // sharpness gain on the test devices.
    if (!turnedOnForCapture) {
      try {
        const stream = streamRef.current;
        const track = stream?.getVideoTracks()[0];
        const caps: any = track?.getCapabilities ? track.getCapabilities() : {};
        if (track && caps?.focusMode?.includes?.('single-shot')) {
          await track.applyConstraints({
            advanced: [{ focusMode: 'single-shot' } as any],
          });
          await new Promise((r) => setTimeout(r, AF_SETTLE_MS));
        }
      } catch (afErr) {
        // Log once and move on. Capture must not break for users on
        // devices that don't support the constraint.
        console.debug('[CardCameraCapture] single-shot AF unavailable', afErr);
      }
    }

    // When flash fires, we crop from the frozen snapshot (captured at
    // shutter-tap time) rather than the post-AE-wait live frame, so the
    // user's framing intent is what gets saved. Decoding the snapshot
    // happens in parallel with the AE settle wait — by the time we crop,
    // the HTMLImageElement is ready. If decode fails, we fall back to the
    // live-video crop path (today's behavior — drift but still gets a
    // shot). Non-flash captures stay synchronous and crop the live frame.
    let snapshotImage: HTMLImageElement | null = null;
    let snapshotDims: { w: number; h: number } | null = null;
    let pickedSharpness: number | null = null;

    try {
      if (turnedOnForCapture) {
        // Snapshot the framed scene BEFORE turning the torch on, then
        // display it as a full-cover overlay during the AE settle wait.
        // This removes the visual feedback loop (jitter + wash-out) that
        // was causing users' hands to drift during the longer wait.
        const snapshot = snapshotFullVideoFrame();
        if (snapshot) {
          setFrozenPreviewDataUrl(snapshot);
          try {
            snapshotImage = await decodeSnapshot(snapshot);
            snapshotDims = { w: snapshotImage.naturalWidth, h: snapshotImage.naturalHeight };
          } catch {
            // Decode failed — fall through to live-video crop below.
            snapshotImage = null;
          }
        }
        setCapturing(true);
        await applyTorch(true);
        await new Promise((r) => setTimeout(r, AE_SETTLE_MS));
      } else {
        // ── 3-frame burst (non-flash path) ──────────────────────────
        // Capture BURST_FRAMES snapshots ~150ms apart, score each, and
        // keep the sharpest. Replaces the single-frame live-video
        // crop. Hand-tremor is the dominant blur source at this
        // distance; a brief burst picks the steadiest moment from the
        // shutter-press envelope. We also use the sharpest snapshot
        // as the crop source (instead of the live video frame) so the
        // cropped output matches the scored frame exactly.
        const candidates: Array<{ dataUrl: string; score: number }> = [];
        for (let i = 0; i < BURST_FRAMES; i += 1) {
          const frame = captureAndScoreFrame();
          if (frame) candidates.push(frame);
          if (i < BURST_FRAMES - 1) {
            await new Promise((r) => setTimeout(r, BURST_INTERVAL_MS));
          }
        }
        if (candidates.length > 0) {
          const bestIdx = pickSharpest(candidates.map((c) => c.score));
          const best = candidates[bestIdx];
          pickedSharpness = best.score;
          try {
            snapshotImage = await decodeSnapshot(best.dataUrl);
            snapshotDims = { w: snapshotImage.naturalWidth, h: snapshotImage.naturalHeight };
          } catch {
            // Decode failed — fall back to live-video crop path
            // (capturedRef stays claimed, so cropGuideRegion still
            // works against videoRef).
            snapshotImage = null;
          }
        }
      }

      const cropSource = snapshotImage && snapshotDims
        ? {
            kind: 'image' as const,
            image: snapshotImage,
            naturalWidth: snapshotDims.w,
            naturalHeight: snapshotDims.h,
            // Brightness boost only on the flash path — the burst-pick
            // path runs in normal lighting and looks correct as-is.
            boost: turnedOnForCapture,
          }
        : undefined;

      if (mode === 'graded') {
        const label = cropGuideRegion(0, GRADED_LABEL_HEIGHT_FRAC, cropSource);
        const body = cropGuideRegion(
          GRADED_LABEL_HEIGHT_FRAC,
          1 - GRADED_LABEL_HEIGHT_FRAC,
          cropSource,
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
        const cropped = cropGuideRegion(0, 1, cropSource);
        if (!cropped) {
          capturedRef.current = false;
          return;
        }
        setRawImage(cropped);
      }
      // Stash the burst-picked sharpness for handleConfirm to surface to
      // the parent. Null on the flash path (no burst), in which case the
      // parent falls back to the live-preview blurScore for telemetry.
      pickedSharpnessRef.current = pickedSharpness;
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
      setCapturing(false);
      setFrozenPreviewDataUrl(null);
    }
  }, [cropGuideRegion, mode, blurScore, torchCapable, flashMode, luminance, torchOn, applyTorch, snapshotFullVideoFrame, decodeSnapshot, captureAndScoreFrame]);

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
    const quality: CaptureQuality = {
      luminance,
      blurScore,
      lightingState,
      blurState,
      pickedSharpness: pickedSharpnessRef.current,
    };
    if (mode === 'graded' && labelImage && onCaptureGraded) {
      onCaptureGraded(rawImage, labelImage);
    } else {
      onCapture(rawImage, quality);
    }
    setRawImage(null);
    setLabelImage(null);
    setBlurConfirm(false);
    pickedSharpnessRef.current = null;
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
  // arbitrary framing. We still score sharpness on the loaded bitmap so
  // the parent can surface the same blurry-photo warning banner that
  // camera captures get — this is the only signal available for library
  // uploads (no live preview, no burst).
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
      // Score the loaded bitmap on a 480x480 center crop. Best-effort —
      // any failure (decode error, missing canvas ctx) leaves the
      // sharpness ref null and the parent treats it as "no signal".
      const img = new Image();
      img.onload = () => {
        try {
          const cropSize = Math.min(img.naturalWidth, img.naturalHeight);
          if (cropSize < 3) return;
          const sx = (img.naturalWidth - cropSize) / 2;
          const sy = (img.naturalHeight - cropSize) / 2;
          const sample = document.createElement('canvas');
          sample.width = SHARPNESS_SAMPLE_SIZE;
          sample.height = SHARPNESS_SAMPLE_SIZE;
          const ctx = sample.getContext('2d', { willReadFrequently: true });
          if (!ctx) return;
          ctx.drawImage(
            img,
            sx, sy, cropSize, cropSize,
            0, 0, SHARPNESS_SAMPLE_SIZE, SHARPNESS_SAMPLE_SIZE,
          );
          const data = ctx.getImageData(0, 0, SHARPNESS_SAMPLE_SIZE, SHARPNESS_SAMPLE_SIZE);
          pickedSharpnessRef.current = scoreImageData(data);
        } catch {
          pickedSharpnessRef.current = null;
        }
      };
      img.src = dataUrl;
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

        {frozenPreviewDataUrl && !inPreview && (
          <img
            src={frozenPreviewDataUrl}
            alt=""
            aria-hidden
            className="absolute inset-0 w-full h-full object-cover z-20 pointer-events-none"
          />
        )}

        {capturing && !inPreview && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 pointer-events-none">
            <div className="bg-white/90 text-slate-900 px-4 py-2 rounded-full text-sm font-medium shadow-lg">
              Hold still…
            </div>
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
