import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { 
  ScanSearch, 
  Camera, 
  Plus,
  Upload,
  ImageIcon,
  X
} from "lucide-react";

interface ImagePreviewProps {
  frontImage: string;
  backImage: string;
  onCaptureRequest: (side: 'front' | 'back') => void;
  onAnalyzeRequest?: () => void;
  onDirectImageUpload?: (side: 'front' | 'back', imageData: string) => void;
}

export default function ImagePreview({ 
  frontImage, 
  backImage, 
  onCaptureRequest,
  onAnalyzeRequest,
  onDirectImageUpload
}: ImagePreviewProps) {
  const frontFileInputRef = useRef<HTMLInputElement>(null);
  const backFileInputRef = useRef<HTMLInputElement>(null);
  const [activeSide, setActiveSide] = useState<'front' | 'back' | null>(null);
  
  const handleFileInputChange = (side: 'front' | 'back', event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const imageData = e.target?.result as string;
        // If we have the direct upload function, use it
        if (onDirectImageUpload) {
          onDirectImageUpload(side, imageData);
        } else {
          // Otherwise fall back to the capture request
          onCaptureRequest(side);
        }
        
        // Close the selector after selection
        setActiveSide(null);
      };
      reader.readAsDataURL(file);
    }
  };
  
  const handlePhotoLibrary = () => {
    if (!activeSide) return;
    const fileInput = activeSide === 'front' ? frontFileInputRef.current : backFileInputRef.current;
    fileInput?.click();
    setActiveSide(null);
  };
  
  const handleTakePhoto = () => {
    if (!activeSide) return;
    onCaptureRequest(activeSide);
    setActiveSide(null);
  };
  
  const handleChooseFile = () => {
    if (!activeSide) return;
    const fileInput = activeSide === 'front' ? frontFileInputRef.current : backFileInputRef.current;
    fileInput?.click();
    setActiveSide(null);
  };

  return (
    <div className="mb-4 relative">
      <div className="grid grid-cols-2 gap-4 mb-3">
        <div className="flex flex-col">
          <div 
            className={`relative rounded-lg border-2 ${frontImage ? 'border-slate-300' : 'border-dashed border-slate-400'} bg-slate-50 h-36 flex flex-col items-center justify-center overflow-hidden`}
          >
            {frontImage ? (
              <div className="card-image-container h-auto">
                <img src={frontImage} alt="Card front preview" className="card-image" />
              </div>
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
            {frontImage ? "Replace Front Image" : <><Plus className="h-4 w-4 mr-1" /> Front Image</>}
          </Button>
          
          <input 
            type="file"
            ref={frontFileInputRef}
            onChange={(e) => handleFileInputChange('front', e)}
            accept="image/*"
            className="hidden"
          />
        </div>
        
        <div className="flex flex-col">
          <div 
            className={`relative rounded-lg border-2 ${backImage ? 'border-slate-300' : 'border-dashed border-slate-400'} bg-slate-50 h-36 flex flex-col items-center justify-center overflow-hidden`}
          >
            {backImage ? (
              <div className="w-full h-full flex items-center justify-center overflow-hidden">
                <img src={backImage} alt="Card back preview" className="object-cover w-full h-full" />
              </div>
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
            {backImage ? "Replace Back Image" : <><Plus className="h-4 w-4 mr-1" /> Back Image</>}
          </Button>
          
          <input 
            type="file"
            ref={backFileInputRef}
            onChange={(e) => handleFileInputChange('back', e)}
            accept="image/*"
            className="hidden"
          />
        </div>
      </div>
      
      {/* Single shared image selector menu */}
      {activeSide && (
        <>
          <div className="absolute z-10 top-1/3 left-1/2 transform -translate-x-1/2 -translate-y-1/4 w-64 rounded-md overflow-hidden shadow-lg bg-slate-800">
            <button
              className="flex items-center w-full px-4 py-3 text-white bg-slate-700 hover:bg-slate-600 border-b border-slate-800"
              onClick={handlePhotoLibrary}
            >
              <ImageIcon className="h-5 w-5 mr-3" />
              <span>Photo Library</span>
            </button>
            <button
              className="flex items-center w-full px-4 py-3 text-white bg-slate-700 hover:bg-slate-600 border-b border-slate-800"
              onClick={handleTakePhoto}
            >
              <Camera className="h-5 w-5 mr-3" />
              <span>Take Photo</span>
            </button>
            <button
              className="flex items-center w-full px-4 py-3 text-white bg-slate-700 hover:bg-slate-600"
              onClick={handleChooseFile}
            >
              <Upload className="h-5 w-5 mr-3" />
              <span>Choose File</span>
            </button>
          </div>
          
          {/* Backdrop to close the menu when clicking outside */}
          <div 
            className="fixed inset-0 bg-black bg-opacity-30 z-0" 
            onClick={() => setActiveSide(null)}
          />
        </>
      )}
      
      {frontImage && onAnalyzeRequest && (
        <Button 
          type="button" 
          variant="secondary" 
          size="sm" 
          className="w-full"
          onClick={onAnalyzeRequest}
        >
          <ScanSearch className="h-4 w-4 mr-2" />
          Analyze Card with OCR
        </Button>
      )}
    </div>
  );
}
