import { useRef, useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";

interface CameraCaptureProps {
  onImageCapture: (imageData: string) => void;
  side: 'front' | 'back';
}

export default function CameraCapture({ onImageCapture, side }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [hasCapture, setHasCapture] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const startCamera = async () => {
    try {
      setErrorMessage(null);
      const mediaStream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play().catch(err => {
            console.error('Error playing video:', err);
            setErrorMessage('Error starting video stream. Please refresh and try again.');
          });
        };
        setStream(mediaStream);
        setIsCameraActive(true);
      }
    } catch (error) {
      console.error('Error accessing camera:', error);
      setErrorMessage('Unable to access camera. Please check permissions and try again.');
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
      setIsCameraActive(false);
    }
  };

  const captureImage = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = canvas.toDataURL('image/jpeg');
        onImageCapture(imageData);
        setHasCapture(true);
        stopCamera();
      }
    }
  };
  
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    setErrorMessage(null);
    
    // Check file size (limit to 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setErrorMessage('File size too large. Please select an image under 5MB.');
      return;
    }
    
    // Check file type
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Please select an image file (jpg, png, etc).');
      return;
    }
    
    const reader = new FileReader();
    reader.onload = (e) => {
      const imageData = e.target?.result as string;
      
      // Create an image to get dimensions
      const img = new Image();
      img.onload = () => {
        if (canvasRef.current) {
          const canvas = canvasRef.current;
          canvas.width = img.width;
          canvas.height = img.height;
          
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0);
            const optimizedImageData = canvas.toDataURL('image/jpeg', 0.8);
            onImageCapture(optimizedImageData);
            setHasCapture(true);
          }
        }
      };
      img.src = imageData;
    };
    
    reader.onerror = () => {
      setErrorMessage('Error reading file. Please try again.');
    };
    
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    return () => {
      // Clean up when component unmounts
      stopCamera();
    };
  }, []);

  return (
    <div className="rounded-lg overflow-hidden border border-slate-300 mb-3">
      <div className="camera-container flex items-center justify-center bg-slate-200 relative" style={{ minHeight: "300px", maxHeight: "400px" }}>
        {errorMessage && (
          <div className="text-center text-red-500 p-4">
            <p>{errorMessage}</p>
          </div>
        )}
        
        {!isCameraActive && !hasCapture && !errorMessage && (
          <div className="text-center p-6">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 mx-auto text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <p className="text-slate-500 mt-2">Capture {side} of card using camera or select from your gallery</p>
            <div className="flex flex-col sm:flex-row gap-2 mt-4 justify-center">
              <Button 
                onClick={() => {
                  // Show options when Add Image is clicked
                  const selectMethod = window.confirm("Select an option:\n\n• OK - Take a picture with camera\n• Cancel - Select from gallery");
                  if (selectMethod) {
                    startCamera();
                  } else {
                    fileInputRef.current?.click();
                  }
                }}
                className="bg-primary-700 hover:bg-primary-800 text-white font-bold px-8 py-3 rounded-md shadow-md ring-2 ring-primary-300 text-base transition-all duration-200 ease-in-out transform hover:scale-105 hover:shadow-lg"
              >
                📷 Add Image
              </Button>
              <input 
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                accept="image/*"
                className="hidden"
              />
            </div>
          </div>
        )}

        {isCameraActive && (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
            style={{ height: "280px", width: "100%" }}
          />
        )}
        
        {hasCapture && (
          <canvas
            ref={canvasRef}
            className="w-full h-full object-contain"
            style={{ height: "280px", width: "100%" }}
          />
        )}
      </div>
      
      <div className="flex justify-between items-center p-3 bg-white">
        <div className="flex items-center">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-1 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <span className="text-sm font-medium">{side === 'front' ? 'Front' : 'Back'} Side</span>
        </div>
        <div>
          {!isCameraActive && !hasCapture && (
            <div className="flex gap-2">
              <Button 
                onClick={() => {
                  // Show options when Add Image is clicked
                  const selectMethod = window.confirm("Select an option:\n\n• OK - Take a picture with camera\n• Cancel - Select from gallery");
                  if (selectMethod) {
                    startCamera();
                  } else {
                    fileInputRef.current?.click();
                  }
                }}
                className="bg-primary-700 hover:bg-primary-800 text-white font-medium px-3 py-1 rounded-md shadow-sm ring-1 ring-primary-300"
                size="sm"
              >
                📷 Add Image
              </Button>
            </div>
          )}
          
          {isCameraActive && (
            <Button 
              onClick={captureImage}
              className="bg-primary-700 hover:bg-primary-800 text-white font-bold rounded-md shadow-md ring-1 ring-primary-300 animate-pulse"
            >
              📸 Capture Photo
            </Button>
          )}
          
          {hasCapture && (
            <Button 
              onClick={() => {
                setHasCapture(false);
                onImageCapture('');
              }}
              variant="outline"
              className="border-red-300 text-red-600 hover:bg-red-50 font-medium shadow-sm"
            >
              🔄 Retake Photo
            </Button>
          )}
        </div>
      </div>
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
}
