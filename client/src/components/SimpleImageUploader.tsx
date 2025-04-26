import React, { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Camera, Upload } from 'lucide-react';

interface SimpleImageUploaderProps {
  onImageCaptured: (imageData: string) => void;
  label: string;
  existingImage?: string;
}

export default function SimpleImageUploader({ 
  onImageCaptured, 
  label, 
  existingImage 
}: SimpleImageUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
      const imageData = e.target?.result as string;
      onImageCaptured(imageData);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="mb-4">
      <div className={`relative border-2 ${existingImage ? 'border-slate-300' : 'border-dashed border-slate-400'} rounded-lg bg-slate-50 h-36 flex items-center justify-center overflow-hidden`}>
        {existingImage ? (
          <img src={existingImage} alt={`${label} preview`} className="object-contain w-full h-full" />
        ) : (
          <div className="flex flex-col items-center justify-center p-4">
            <Camera className="h-8 w-8 text-slate-400 mb-2" />
            <p className="text-xs text-center text-slate-500">No {label.toLowerCase()} image added</p>
          </div>
        )}
        <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-60 text-white text-xs py-1 px-2 font-medium">
          {label}
        </div>
      </div>
      
      <div className="mt-2 flex space-x-2">
        <Button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          variant="default"
          size="sm"
          className="flex-1 bg-slate-600 hover:bg-slate-700 active:bg-slate-800 text-white"
        >
          <Upload className="h-4 w-4 mr-1" />
          {existingImage ? "Replace Image" : "Upload Image"}
        </Button>
      </div>
      
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelect}
        accept="image/*"
        className="hidden"
      />
    </div>
  );
}