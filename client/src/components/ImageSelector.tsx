import { useState, useRef } from 'react';
import { Button } from "@/components/ui/button";
import {
  Camera,
  ImageIcon,
  Upload,
  X
} from "lucide-react";

interface ImageSelectorProps {
  frontImage: string;
  backImage: string;
  onFrontImageCapture: (imageData: string) => void;
  onBackImageCapture: (imageData: string) => void;
  onCameraRequest: (side: 'front' | 'back') => void;
}

export default function ImageSelector({
  frontImage,
  backImage,
  onFrontImageCapture,
  onBackImageCapture,
  onCameraRequest
}: ImageSelectorProps) {
  const [activeSide, setActiveSide] = useState<'front' | 'back' | null>(null);
  const frontFileInputRef = useRef<HTMLInputElement>(null);
  const backFileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (side: 'front' | 'back', event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const imageData = e.target?.result as string;
      if (side === 'front') {
        onFrontImageCapture(imageData);
      } else {
        onBackImageCapture(imageData);
      }
    };
    reader.readAsDataURL(file);
    setActiveSide(null);
  };

  const handlePhotoLibrary = () => {
    if (!activeSide) return;
    const fileInput = activeSide === 'front' ? frontFileInputRef.current : backFileInputRef.current;
    fileInput?.click();
  };

  const handleTakePhoto = () => {
    if (!activeSide) return;
    onCameraRequest(activeSide);
    setActiveSide(null);
  };

  return (
    <div className="relative">
      <div className="grid grid-cols-2 gap-4 mb-3">
        {/* Front Image */}
        <div className="flex flex-col">
          <div
            className={`relative rounded-lg border-2 ${frontImage ? 'border-slate-300' : 'border-dashed border-slate-400'} bg-slate-50 h-36 flex flex-col items-center justify-center overflow-hidden`}
          >
            {frontImage ? (
              <img src={frontImage} alt="Card front preview" className="object-contain w-full h-full" />
            ) : (
              <div className="flex flex-col items-center justify-center p-4">
                <Camera className="h-8 w-8 text-slate-400 mb-2" />
                <p className="text-xs text-center text-slate-500">No front image added</p>
              </div>
            )}
            <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-60 text-white text-xs py-1 px-2 font-medium">
              Front
            </div>
          </div>

          <Button
            type="button"
            variant={frontImage ? "outline" : "default"}
            size="sm"
            className="mt-2 w-full bg-slate-500 hover:bg-slate-600 text-white"
            onClick={() => setActiveSide('front')}
          >
            {frontImage ? "Replace Front Image" : "Front Image"}
          </Button>
        </div>

        {/* Back Image */}
        <div className="flex flex-col">
          <div
            className={`relative rounded-lg border-2 ${backImage ? 'border-slate-300' : 'border-dashed border-slate-400'} bg-slate-50 h-36 flex flex-col items-center justify-center overflow-hidden`}
          >
            {backImage ? (
              <img src={backImage} alt="Card back preview" className="object-contain w-full h-full" />
            ) : (
              <div className="flex flex-col items-center justify-center p-4">
                <Camera className="h-8 w-8 text-slate-400 mb-2" />
                <p className="text-xs text-center text-slate-500">No back image added</p>
              </div>
            )}
            <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-60 text-white text-xs py-1 px-2 font-medium">
              Back
            </div>
          </div>

          <Button
            type="button"
            variant={backImage ? "outline" : "default"}
            size="sm"
            className="mt-2 w-full bg-slate-500 hover:bg-slate-600 text-white"
            onClick={() => setActiveSide('back')}
          >
            {backImage ? "Replace Back Image" : "Back Image"}
          </Button>
        </div>
      </div>

      {/* Image options menu */}
      {activeSide && (
        <div className="absolute z-10 left-0 right-0 mt-1 rounded-md shadow-lg overflow-hidden">
          <div className="bg-slate-700">
            <button
              className="flex items-center w-full px-4 py-3 text-white hover:bg-slate-600 border-b border-slate-800"
              onClick={handlePhotoLibrary}
            >
              <ImageIcon className="h-5 w-5 mr-3" />
              <span>Photo Library</span>
            </button>
            <button
              className="flex items-center w-full px-4 py-3 text-white hover:bg-slate-600 border-b border-slate-800"
              onClick={handleTakePhoto}
            >
              <Camera className="h-5 w-5 mr-3" />
              <span>Take Photo</span>
            </button>
            <button
              className="flex items-center w-full px-4 py-3 text-white hover:bg-slate-600"
              onClick={handlePhotoLibrary}
            >
              <Upload className="h-5 w-5 mr-3" />
              <span>Choose File</span>
            </button>
          </div>
          
          {/* Backdrop to close the menu when clicking outside */}
          <div 
            className="fixed inset-0 z-0" 
            onClick={() => setActiveSide(null)}
          />
        </div>
      )}

      {/* Hidden file inputs */}
      <input
        type="file"
        ref={frontFileInputRef}
        onChange={(e) => handleFileSelect('front', e)}
        accept="image/*"
        className="hidden"
      />
      
      <input
        type="file"
        ref={backFileInputRef}
        onChange={(e) => handleFileSelect('back', e)}
        accept="image/*"
        className="hidden"
      />
    </div>
  );
}