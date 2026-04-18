import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Camera, Upload } from 'lucide-react';
import CardCameraCapture from './CardCameraCapture';

interface SimpleImageUploaderProps {
  onImageCaptured: (imageData: string) => void;
  label: string;
  existingImage?: string;
  cameraTitle?: string;
  /**
   * When this number changes, the camera modal opens automatically.
   * Used by the parent to chain front → back capture.
   */
  openCameraSignal?: number;
}

export default function SimpleImageUploader({
  onImageCaptured,
  label,
  existingImage,
  cameraTitle,
  openCameraSignal,
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
      onImageCaptured(imageData);
    };
    reader.readAsDataURL(file);
  };

  const replaceLabel = label.replace(/^Upload\s+/i, '').replace(/\s+image$/i, '');

  return (
    <div className="mb-4">
      <div
        className={`relative border-2 ${
          existingImage ? 'border-slate-300' : 'border-dashed border-slate-400'
        } rounded-lg bg-slate-50 h-36 flex items-center justify-center overflow-hidden`}
      >
        {existingImage ? (
          <img
            src={existingImage}
            alt={`${label} preview`}
            className="object-contain w-full h-full"
          />
        ) : (
          <div className="flex flex-col items-center justify-center p-4">
            <Camera className="h-8 w-8 text-slate-400" />
          </div>
        )}
      </div>

      <div className="mt-2 flex">
        <Button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          variant="outline"
          size="sm"
          className="flex-1"
        >
          <Upload className="h-4 w-4 mr-1" />
          Library
        </Button>
      </div>

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelect}
        accept="image/*"
        className="hidden"
      />

      <CardCameraCapture
        open={cameraOpen}
        title={cameraTitle || label}
        onCapture={(dataUrl) => {
          onImageCaptured(dataUrl);
          setCameraOpen(false);
        }}
        onClose={() => setCameraOpen(false)}
      />
    </div>
  );
}
