import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Camera, X, Image as ImageIcon, RotateCcw, Check } from 'lucide-react';

interface CardCameraCaptureProps {
  open: boolean;
  title?: string;
  onCapture: (dataUrl: string) => void;
  onClose: () => void;
}

const CARD_ASPECT = 2.5 / 3.5;

const STABILITY_THRESHOLD = 14;
const STABILITY_FRAMES_REQUIRED = 5;
const STABILITY_WARMUP_MS = 1400;
const SAMPLE_INTERVAL_MS = 120;
const SAMPLE_W = 96;
const SAMPLE_H = Math.round(SAMPLE_W / CARD_ASPECT);
// Minimum mean absolute horizontal-neighbour difference, computed on
// the grayscale crop. Higher = more in-focus edges. Empirically a
// well-focused card sits around 15-30; a blurry one is < 6.
const SHARPNESS_THRESHOLD = 8;

export default function CardCameraCapture({
  open,
  title = 'Take Photo',
  onCapture,
  onClose,
}: CardCameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevSampleRef = useRef<Uint8ClampedArray | null>(null);
  const stableCountRef = useRef(0);
  const sampleTimerRef = useRef<number | null>(null);
  const warmupAtRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const capturedRef = useRef(false);

  const [error, setError] = useState<string | null>(null);
  const [stability, setStability] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [focusing, setFocusing] = useState(false);
  const focusTapRef = useRef<{ x: number; y: number } | null>(null);

  const stopStream = useCallback(() => {
    if (sampleTimerRef.current !== null) {
      window.clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    prevSampleRef.current = null;
    stableCountRef.current = 0;
    setStability(0);
  }, []);

  const startStream = useCallback(async () => {
    setError(null);
    setStarting(true);
    capturedRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      warmupAtRef.current = performance.now() + STABILITY_WARMUP_MS;
    } catch (err: any) {
      console.error('Camera error:', err);
      setError(
        err?.name === 'NotAllowedError'
          ? 'Camera permission denied. Allow camera access or use "Upload from library".'
          : 'Could not access camera. You can still upload from your library.'
      );
    } finally {
      setStarting(false);
    }
  }, []);

  const computeOverlayRectInVideo = useCallback(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!video || !container || !overlay) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const scale = Math.max(cw / vw, ch / vh);
    const displayedW = vw * scale;
    const displayedH = vh * scale;
    const offsetX = (displayedW - cw) / 2;
    const offsetY = (displayedH - ch) / 2;
    const rect = overlay.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    const rectX = rect.left - cRect.left;
    const rectY = rect.top - cRect.top;
    const rectW = rect.width;
    const rectH = rect.height;
    const srcX = Math.max(0, (rectX + offsetX) / scale);
    const srcY = Math.max(0, (rectY + offsetY) / scale);
    const srcW = Math.min(vw - srcX, rectW / scale);
    const srcH = Math.min(vh - srcY, rectH / scale);
    return { srcX, srcY, srcW, srcH };
  }, []);

  const captureFrame = useCallback(() => {
    if (capturedRef.current) return;
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const rect = computeOverlayRectInVideo();
    if (!rect) return;
    const out = document.createElement('canvas');
    out.width = Math.round(rect.srcW);
    out.height = Math.round(rect.srcH);
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(
      video,
      rect.srcX, rect.srcY, rect.srcW, rect.srcH,
      0, 0, out.width, out.height
    );
    const dataUrl = out.toDataURL('image/jpeg', 0.95);
    capturedRef.current = true;
    if (sampleTimerRef.current !== null) {
      window.clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = null;
    }
    setPreview(dataUrl);
  }, [computeOverlayRectInVideo]);

  const sampleStability = useCallback(() => {
    if (capturedRef.current) return;
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const rect = computeOverlayRectInVideo();
    if (!rect) return;
    if (!sampleCanvasRef.current) {
      sampleCanvasRef.current = document.createElement('canvas');
      sampleCanvasRef.current.width = SAMPLE_W;
      sampleCanvasRef.current.height = SAMPLE_H;
    }
    const c = sampleCanvasRef.current;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(
      video,
      rect.srcX, rect.srcY, rect.srcW, rect.srcH,
      0, 0, SAMPLE_W, SAMPLE_H
    );
    const data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;

    // Compute sharpness on this frame: mean absolute horizontal-neighbour
    // difference of the grayscale crop. Camera autofocus produces a
    // characteristic ramp from low → high values as it locks focus.
    let sharpSum = 0;
    let sharpCount = 0;
    for (let y = 0; y < SAMPLE_H; y++) {
      for (let x = 1; x < SAMPLE_W; x++) {
        const i = (y * SAMPLE_W + x) * 4;
        const ip = i - 4;
        const g = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const gp = (data[ip] + data[ip + 1] + data[ip + 2]) / 3;
        sharpSum += Math.abs(g - gp);
        sharpCount++;
      }
    }
    const sharpness = sharpCount ? sharpSum / sharpCount : 0;
    const isSharp = sharpness >= SHARPNESS_THRESHOLD;

    const prev = prevSampleRef.current;
    if (prev && prev.length === data.length) {
      let diffSum = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const g1 = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const g2 = (prev[i] + prev[i + 1] + prev[i + 2]) / 3;
        diffSum += Math.abs(g1 - g2);
        count++;
      }
      const meanDiff = diffSum / count;
      const isWarm = performance.now() >= warmupAtRef.current;
      if (isWarm && meanDiff < STABILITY_THRESHOLD && isSharp) {
        stableCountRef.current += 1;
      } else {
        stableCountRef.current = 0;
      }
      setStability(Math.min(1, stableCountRef.current / STABILITY_FRAMES_REQUIRED));
      if (stableCountRef.current >= STABILITY_FRAMES_REQUIRED) {
        captureFrame();
      }
    }
    prevSampleRef.current = new Uint8ClampedArray(data);
  }, [computeOverlayRectInVideo, captureFrame]);

  useEffect(() => {
    if (!open) {
      stopStream();
      setPreview(null);
      return;
    }
    startStream();
    return () => {
      stopStream();
    };
  }, [open, startStream, stopStream]);

  useEffect(() => {
    if (!open || preview || error) return;
    sampleTimerRef.current = window.setInterval(sampleStability, SAMPLE_INTERVAL_MS);
    return () => {
      if (sampleTimerRef.current !== null) {
        window.clearInterval(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
    };
  }, [open, preview, error, sampleStability]);

  // When the user hits "Retake", the <video> element is unmounted (it's
  // hidden while preview is shown) and re-mounted with no srcObject. Re-
  // attach the existing live stream so the viewfinder doesn't go black.
  useEffect(() => {
    if (!open || preview) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (video && stream && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }
  }, [open, preview]);

  const handleTapFocus = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    const stream = streamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const caps: any = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.focusMode || !caps.focusMode.includes('single-shot')) {
      // Best-effort focus nudge: brief pause + resume often re-triggers AF
      // on iOS Safari (which doesn't support pointsOfInterest yet).
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
    focusTapRef.current = { x, y };
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
    // Reset stability counter so a focus shift doesn't trigger an
    // immediate auto-capture on a half-focused frame.
    stableCountRef.current = 0;
    setStability(0);
    warmupAtRef.current = performance.now() + 600;
  }, []);

  const handleConfirm = () => {
    if (preview) {
      onCapture(preview);
      setPreview(null);
    }
  };

  const handleRetake = () => {
    setPreview(null);
    capturedRef.current = false;
    stableCountRef.current = 0;
    setStability(0);
    warmupAtRef.current = performance.now() + STABILITY_WARMUP_MS;
  };

  const handleLibrary = () => {
    fileInputRef.current?.click();
  };

  const handleLibraryFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string;
      onCapture(dataUrl);
    };
    reader.readAsDataURL(file);
  };

  if (!open) return null;

  const stabilityPct = Math.round(stability * 100);

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
            stopStream();
            setPreview(null);
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
        onClick={!preview ? handleTapFocus : undefined}
      >
        {!preview && (
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
        {preview && (
          <img
            src={preview}
            alt="Captured"
            className="absolute inset-0 w-full h-full object-contain bg-black"
          />
        )}

        {!preview && (
          <div
            className="absolute left-0 right-0 top-2 text-center text-white text-xs px-4 z-10 drop-shadow pointer-events-none"
          >
            {focusing
              ? 'Focusing…'
              : stabilityPct >= 100
                ? 'Capturing…'
                : stabilityPct > 30
                  ? 'Hold steady…'
                  : 'Align card inside the brackets · tap to focus'}
          </div>
        )}

        {!preview && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div
              ref={overlayRef}
              className="relative"
              style={{
                width: 'min(78vw, calc((100vh - 240px) * (2.5 / 3.5)))',
                aspectRatio: '2.5 / 3.5',
              }}
            >
              <div
                className="absolute inset-0 rounded-md transition-colors duration-150"
                style={{
                  borderWidth: 2,
                  borderStyle: 'solid',
                  borderColor: stability > 0.5
                    ? 'rgba(52, 211, 153, 0.9)'
                    : 'rgba(255,255,255,0.4)',
                  boxShadow: stability >= 1
                    ? '0 0 0 4px rgba(52,211,153,0.6)'
                    : 'none',
                }}
              />
              <CornerBracket pos="tl" active={stability > 0.3} />
              <CornerBracket pos="tr" active={stability > 0.3} />
              <CornerBracket pos="bl" active={stability > 0.3} />
              <CornerBracket pos="br" active={stability > 0.3} />
              <div
                className="absolute left-0 right-0 -bottom-4 h-1.5 bg-emerald-400 rounded-full transition-[width] duration-150 shadow-[0_0_6px_rgba(52,211,153,0.8)]"
                style={{ width: `${stabilityPct}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-x-4 top-4 bg-red-600/90 text-white text-sm rounded-md px-3 py-2">
            {error}
          </div>
        )}
        {starting && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-white/70 text-sm">
            Starting camera…
          </div>
        )}
      </div>

      <div className="bg-black/80 px-4 py-4 flex items-center justify-around z-10">
        {!preview ? (
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
              {error
                ? 'Use Library'
                : stabilityPct >= 100
                  ? 'Capturing…'
                  : stabilityPct > 0
                    ? `Hold steady ${stabilityPct}%`
                    : 'Auto-capture ready'}
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
              className="bg-emerald-500 hover:bg-emerald-600 text-white"
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

function CornerBracket({ pos, active }: { pos: 'tl' | 'tr' | 'bl' | 'br'; active?: boolean }) {
  const color = active ? 'border-emerald-300' : 'border-emerald-400';
  const base = `absolute h-7 w-7 transition-all duration-150 ${color} ${active ? 'scale-110' : ''}`;
  const map: Record<typeof pos, string> = {
    tl: 'top-0 left-0 border-t-4 border-l-4 rounded-tl-md',
    tr: 'top-0 right-0 border-t-4 border-r-4 rounded-tr-md',
    bl: 'bottom-0 left-0 border-b-4 border-l-4 rounded-bl-md',
    br: 'bottom-0 right-0 border-b-4 border-r-4 rounded-br-md',
  };
  return <div className={`${base} ${map[pos]}`} />;
}
