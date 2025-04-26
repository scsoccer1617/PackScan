import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { 
  ScanSearch, 
  Camera, 
  Plus, 
  Upload, 
  ImageIcon, 
  ChevronDown 
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="mb-4">
      <div className="grid grid-cols-2 gap-4 mb-3">
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
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button 
                type="button" 
                variant={frontImage ? "outline" : "default"}
                size="sm" 
                className="mt-2 w-full bg-slate-500 hover:bg-slate-600 text-white"
              >
                {frontImage ? "Replace Front Image" : <><Plus className="h-4 w-4 mr-1" /> Front Image</>}
                <ChevronDown className="h-4 w-4 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-52">
              <DropdownMenuItem onClick={() => onCaptureRequest('front')}>
                <Camera className="h-4 w-4 mr-2" />
                Take Photo
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => frontFileInputRef.current?.click()}>
                <ImageIcon className="h-4 w-4 mr-2" />
                Photo Library
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => frontFileInputRef.current?.click()}>
                <Upload className="h-4 w-4 mr-2" />
                Upload File
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          
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
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button 
                type="button" 
                variant={backImage ? "outline" : "default"}
                size="sm" 
                className="mt-2 w-full bg-slate-500 hover:bg-slate-600 text-white"
              >
                {backImage ? "Replace Back Image" : <><Plus className="h-4 w-4 mr-1" /> Back Image</>}
                <ChevronDown className="h-4 w-4 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-52">
              <DropdownMenuItem onClick={() => onCaptureRequest('back')}>
                <Camera className="h-4 w-4 mr-2" />
                Take Photo
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => backFileInputRef.current?.click()}>
                <ImageIcon className="h-4 w-4 mr-2" />
                Photo Library
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => backFileInputRef.current?.click()}>
                <Upload className="h-4 w-4 mr-2" />
                Upload File
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          
          <input 
            type="file"
            ref={backFileInputRef}
            onChange={(e) => handleFileInputChange('back', e)}
            accept="image/*"
            className="hidden"
          />
        </div>
      </div>
      
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
