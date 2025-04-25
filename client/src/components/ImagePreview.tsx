import { Button } from "@/components/ui/button";

interface ImagePreviewProps {
  frontImage: string;
  backImage: string;
  onCaptureRequest: (side: 'front' | 'back') => void;
}

export default function ImagePreview({ frontImage, backImage, onCaptureRequest }: ImagePreviewProps) {
  return (
    <div className="flex space-x-3 mb-2">
      <div 
        className="relative w-24 h-32 bg-slate-100 rounded border border-slate-300 flex items-center justify-center overflow-hidden"
        onClick={() => onCaptureRequest('front')}
      >
        {frontImage ? (
          <img src={frontImage} alt="Card front preview" className="object-cover w-full h-full" />
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        )}
        <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 text-white text-xs py-1 px-2">
          Front
        </div>
      </div>
      
      <div 
        className={`relative w-24 h-32 bg-slate-100 rounded border ${backImage ? 'border-slate-300' : 'border-dashed border-slate-300'} flex items-center justify-center overflow-hidden`}
        onClick={() => onCaptureRequest('back')}
      >
        {backImage ? (
          <img src={backImage} alt="Card back preview" className="object-cover w-full h-full" />
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        )}
        <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 text-white text-xs py-1 px-2 text-center">
          Back
        </div>
      </div>
    </div>
  );
}
