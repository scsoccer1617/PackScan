import { Button } from "@/components/ui/button";
import { ScanSearch, Camera, Plus } from "lucide-react";

interface ImagePreviewProps {
  frontImage: string;
  backImage: string;
  onCaptureRequest: (side: 'front' | 'back') => void;
  onAnalyzeRequest?: () => void;
}

export default function ImagePreview({ 
  frontImage, 
  backImage, 
  onCaptureRequest,
  onAnalyzeRequest
}: ImagePreviewProps) {
  return (
    <div className="mb-4">
      <div className="grid grid-cols-2 gap-4 mb-3">
        <div className="flex flex-col">
          <div 
            className={`relative rounded-lg border-2 ${frontImage ? 'border-slate-300' : 'border-dashed border-slate-400'} bg-slate-50 h-36 flex flex-col items-center justify-center overflow-hidden`}
          >
            {frontImage ? (
              <img src={frontImage} alt="Card front preview" className="object-cover w-full h-full" />
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
            className="mt-2 w-full"
            onClick={() => onCaptureRequest('front')}
          >
            {frontImage ? "Replace Image" : <><Plus className="h-4 w-4 mr-1" /> Front Image</>}
          </Button>
        </div>
        
        <div className="flex flex-col">
          <div 
            className={`relative rounded-lg border-2 ${backImage ? 'border-slate-300' : 'border-dashed border-slate-400'} bg-slate-50 h-36 flex flex-col items-center justify-center overflow-hidden`}
          >
            {backImage ? (
              <img src={backImage} alt="Card back preview" className="object-cover w-full h-full" />
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
            className="mt-2 w-full"
            onClick={() => onCaptureRequest('back')}
          >
            {backImage ? "Replace Image" : <><Plus className="h-4 w-4 mr-1" /> Back Image</>}
          </Button>
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
