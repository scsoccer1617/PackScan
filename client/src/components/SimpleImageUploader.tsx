import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Camera, Upload } from 'lucide-react';
import CardCameraCapture from './CardCameraCapture';

export type ImageSource = 'camera' | 'file';

interface SimpleImageUploaderProps {
  onImageCaptured: (imageData: string, source: ImageSource) => void;
  label: string;
  existingImage?: string;
  cameraTitle?: string;
  /**
   * When this number changes, the camera modal opens automatically.
   * Used by the parent to chain front → back capture.
   */
  openCameraSignal?: number;
  /**
   * Optional explicit label for the retake button (shown once a photo has
   * been captured). Falls back to a derived "Retake <label>" string. Prefer
   * passing an explicit short phrase (e.g. "Rescan Front") so the full
   * label fits inside the narrow 2-column /scan slot without truncating.
   */
  retakeLabel?: string;
}

export default function SimpleImageUploader({
  onImageCaptured,
  label,
  existingImage,
  cameraTitle,
  openCameraSignal,
  retakeLabel,
}: SimpleImageUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const lastSignalRef = useRef<number | undefined>(openCameraSignal);

  useEffect(() => {
    if (openCameraSignal === undefined) return;
    if (lastSignalRef.current !== openCameraSignal) {
      lastSignalRef.current = openCameraSignal;
      setCameraOpen(true);
    }
  }, [openCameraSignal]);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const imageData = e.target?.result as string;
      onImageCaptured(imageData, 'file');
    };
    reader.readAsDataURL(file);
  };

  const replaceLabel = label.replace(/^Upload\s+/i, '').replace(/\s+image$/i, '');

  return (
    <div className="mb-4">
      <div
        className={`relative border-2 ${
          existingImage ? 'border-slate-300' : 'border-dashed border-slate-400'
        } rounded-lg bg-slate-50 aspect-[3/4] flex items-center justify-center overflow-hidden`}
      >
        {existingImage ? (
          // `object-cover` so the 2.5:3.5 cropped card fills the
          // 3:4 thumbnail box. PR #164 made capture crop tight to the
          // guide, so the source image is already just the card —
          // cover here only nudges aspect (~5%), no fingers/background
          // to hide.
          <img
            src={existingImage}
            alt={`${label} preview`}
            className="object-cover w-full h-full"
          />
        ) : (
          <div className="flex flex-col items-center justify-center p-4">
            <Camera className="h-8 w-8 text-slate-400" />
          </div>
        )}
      </div>

      {/* Stacked vertically so the full labels fit inside the narrow
          /scan 2-column slot (each uploader only has ~half the viewport).
          Previously these were side-by-side and truncated to "Ta..." /
          "Ph..." on typical phone widths. */}
      <div className="mt-2 flex flex-col gap-2">
        <Button
          type="button"
          onClick={() => setCameraOpen(true)}
          variant="default"
          size="sm"
          className="w-full bg-slate-800 hover:bg-slate-900 active:bg-black text-white"
        >
          <Camera className="h-4 w-4 mr-1.5 shrink-0" />
          <span className="truncate">
            {existingImage
              ? (retakeLabel ?? `Retake ${replaceLabel}`)
              : 'Take Photo'}
          </span>
        </Button>
        <Button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          variant="outline"
          size="sm"
          className="w-full"
        >
          <Upload className="h-4 w-4 mr-1.5 shrink-0" />
          <span className="truncate">Photo Library</span>
        </Button>
      </div>

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelect}
        accept="image/jpeg,image/png,image/heic,image/heif,image/webp"
        className="hidden"
      />

      <CardCameraCapture
        open={cameraOpen}
        title={cameraTitle || label}
        onCapture={(dataUrl) => {
          onImageCaptured(dataUrl, 'camera');
          setCameraOpen(false);
        }}
        onClose={() => setCameraOpen(false)}
      />
    </div>
  );
}
