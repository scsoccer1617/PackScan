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
  const [activeSelector, setActiveSelector] = useState<'front' | 'back' | null>(null);
  
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
        setActiveSelector(null);
      };
      reader.readAsDataURL(file);
    }
  };
  
  const handleOptionSelect = (option: 'camera' | 'gallery' | 'file', side: 'front' | 'back') => {
    if (option === 'camera') {
      onCaptureRequest(side);
    } else {
      // Both gallery and file use the file input
      const fileInput = side === 'front' ? frontFileInputRef.current : backFileInputRef.current;
      fileInput?.click();
    }
    setActiveSelector(null);
  };

  return (
    <div className="mb-4">
      <div className="grid grid-cols-2 gap-4 mb-3">
        <div className="flex flex-col relative">
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
            onClick={() => setActiveSelector('front')}
          >
            {frontImage ? "Replace Front Image" : <><Plus className="h-4 w-4 mr-1" /> Front Image</>}
          </Button>
          
          {activeSelector === 'front' && (
            <div className="absolute top-full mt-1 left-0 right-0 z-10 rounded-md overflow-hidden shadow-lg bg-slate-800">
              <button
                className="flex items-center w-full px-3 py-2 text-white bg-slate-700 hover:bg-slate-600"
                onClick={() => handleOptionSelect('gallery', 'front')}
              >
                <ImageIcon className="h-5 w-5 mr-2" />
                <span>Photo Library</span>
              </button>
              <button
                className="flex items-center w-full px-3 py-2 text-white bg-slate-700 hover:bg-slate-600"
                onClick={() => handleOptionSelect('camera', 'front')}
              >
                <Camera className="h-5 w-5 mr-2" />
                <span>Take Photo</span>
              </button>
              <button
                className="flex items-center w-full px-3 py-2 text-white bg-slate-700 hover:bg-slate-600"
                onClick={() => handleOptionSelect('file', 'front')}
              >
                <Upload className="h-5 w-5 mr-2" />
                <span>Choose File</span>
              </button>
            </div>
          )}
          
          <input 
            type="file"
            ref={frontFileInputRef}
            onChange={(e) => handleFileInputChange('front', e)}
            accept="image/*"
            className="hidden"
          />
        </div>
        
        <div className="flex flex-col relative">
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
            onClick={() => setActiveSelector('back')}
          >
            {backImage ? "Replace Back Image" : <><Plus className="h-4 w-4 mr-1" /> Back Image</>}
          </Button>
          
          {activeSelector === 'back' && (
            <div className="absolute top-full mt-1 left-0 right-0 z-10 rounded-md overflow-hidden shadow-lg bg-slate-800">
              <button
                className="flex items-center w-full px-3 py-2 text-white bg-slate-700 hover:bg-slate-600"
                onClick={() => handleOptionSelect('gallery', 'back')}
              >
                <ImageIcon className="h-5 w-5 mr-2" />
                <span>Photo Library</span>
              </button>
              <button
                className="flex items-center w-full px-3 py-2 text-white bg-slate-700 hover:bg-slate-600"
                onClick={() => handleOptionSelect('camera', 'back')}
              >
                <Camera className="h-5 w-5 mr-2" />
                <span>Take Photo</span>
              </button>
              <button
                className="flex items-center w-full px-3 py-2 text-white bg-slate-700 hover:bg-slate-600"
                onClick={() => handleOptionSelect('file', 'back')}
              >
                <Upload className="h-5 w-5 mr-2" />
                <span>Choose File</span>
              </button>
            </div>
          )}
          
          <input 
            type="file"
            ref={backFileInputRef}
            onChange={(e) => handleFileInputChange('back', e)}
            accept="image/*"
            className="hidden"
          />
        </div>
      </div>
      
      {/* Add click away listener to close active selector when clicking elsewhere */}
      {activeSelector && (
        <div 
          className="fixed inset-0 z-0" 
          onClick={() => setActiveSelector(null)}
        />
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
