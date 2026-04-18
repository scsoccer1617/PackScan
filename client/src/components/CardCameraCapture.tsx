import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { X, Image as ImageIcon, RotateCcw, Check } from 'lucide-react';

interface CardCameraCaptureProps {
  open: boolean;
  title?: string;
  onCapture: (dataUrl: string) => void;
  onClose: () => void;
}

const CARD_ASPECT = 2.5 / 3.5;

// Shared MediaStream cached at module scope so reopening the camera (e.g.
// front → back capture chain) reuses the same hardware stream and the
// browser never has to re-prompt for permission within a session.
let sharedStream: MediaStream | null = null;
let sharedStreamReleaseTimer: number | null = null;

function isStreamLive(stream: MediaStream | null): stream is MediaStream {
  if (!stream) return false;
  const tracks = stream.getVideoTracks();
  return tracks.length > 0 && tracks.every(t => t.readyState === 'live');
}

function releaseSharedStreamSoon() {
  if (sharedStreamReleaseTimer !== null) {
    window.clearTimeout(sharedStreamReleaseTimer);
  }
  // Hold the stream for a couple of minutes so the user can take front and
  // back without hitting another camera-init delay. After that we stop the
  // tracks to release the camera light/hardware.
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
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const capturedRef = useRef(false);

  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [focusing, setFocusing] = useState(false);

  const detachStream = useCallback(() => {
    // Keep the shared stream alive — just detach it from the <video> so the
    // next open re-attaches without another getUserMedia call (which is what
    // makes some browsers re-prompt for permission).
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    streamRef.current = null;
    if (isStreamLive(sharedStream)) {
      releaseSharedStreamSoon();
    }
  }, []);

  const startStream = useCallback(async () => {
    setError(null);
    capturedRef.current = false;
    cancelSharedStreamRelease();

    // Reuse the cached stream if it's still live — avoids the OS prompt and
    // the "Starting camera…" delay between front and back capture.
    if (isStreamLive(sharedStream)) {
      streamRef.current = sharedStream;
      if (videoRef.current) {
        videoRef.current.srcObject = sharedStream;
        await videoRef.current.play().catch(() => {});
      }
      return;
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
      sharedStream = stream;
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch (err: any) {
      console.error('Camera error:', err);
      setError(
        err?.name === 'NotAllowedError'
          ? 'We need camera access to scan your card. Tap the camera icon in your browser’s address bar to allow it, or use “Library” to upload a photo instead.'
          : 'We couldn’t turn on your camera. Try “Library” to upload a photo of your card instead.'
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
    setPreview(dataUrl);
  }, [computeOverlayRectInVideo]);

  useEffect(() => {
    if (!open) {
      detachStream();
      setPreview(null);
      return;
    }
    startStream();
    return () => {
      detachStream();
    };
  }, [open, startStream, detachStream]);

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
    if (preview) {
      onCapture(preview);
      setPreview(null);
    }
  };

  const handleRetake = () => {
    setPreview(null);
    capturedRef.current = false;
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
                className="absolute inset-0 rounded-md"
                style={{
                  borderWidth: 2,
                  borderStyle: 'solid',
                  borderColor: 'rgba(255,255,255,0.4)',
                }}
              />
              <CornerBracket pos="tl" />
              <CornerBracket pos="tr" />
              <CornerBracket pos="bl" />
              <CornerBracket pos="br" />
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

function CornerBracket({ pos }: { pos: 'tl' | 'tr' | 'bl' | 'br' }) {
  const base = 'absolute h-7 w-7 border-emerald-400';
  const map: Record<typeof pos, string> = {
    tl: 'top-0 left-0 border-t-4 border-l-4 rounded-tl-md',
    tr: 'top-0 right-0 border-t-4 border-r-4 rounded-tr-md',
    bl: 'bottom-0 left-0 border-b-4 border-l-4 rounded-bl-md',
    br: 'bottom-0 right-0 border-b-4 border-r-4 rounded-br-md',
  };
  return <div className={`${base} ${map[pos]}`} />;
}
