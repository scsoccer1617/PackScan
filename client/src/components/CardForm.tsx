import { useState, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { CardFormValues, cardSchema } from "@shared/schema";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useOCR } from "@/hooks/use-ocr";
import CameraCapture from "./CameraCapture";
import OCRResults from "./OCRResults";
import { ScanSearch, Camera, ImageIcon, Upload, Plus } from "lucide-react";

const sportOptions = [
  "Baseball",
  "Football",
  "Basketball",
  "Hockey",
  "Soccer",
  "Other"
];

const brandOptions = [
  "Topps",
  "Upper Deck",
  "Panini",
  "Bowman",
  "Fleer",
  "Donruss",
  "Other"
];

const conditionOptions = [
  { value: "PSA 10", label: "PSA 10 (Gem Mint)", valueRange: "$250-350" },
  { value: "PSA 9", label: "PSA 9 (Mint)", valueRange: "$180-220" },
  { value: "PSA 8", label: "PSA 8 (Near Mint-Mint)", valueRange: "$120-150" },
  { value: "PSA 7", label: "PSA 7 (Near Mint)", valueRange: "$80-100" },
  { value: "PSA 6", label: "PSA 6 (Excellent-Near Mint)", valueRange: "$60-75" },
  { value: "PSA 5", label: "PSA 5 (Excellent)", valueRange: "$40-55" },
  { value: "PSA 4", label: "PSA 4 (Very Good-Excellent)", valueRange: "$25-35" },
  { value: "PSA 3", label: "PSA 3 (Very Good)", valueRange: "$15-20" },
  { value: "PSA 2", label: "PSA 2 (Good)", valueRange: "$10-15" },
  { value: "PSA 1", label: "PSA 1 (Poor)", valueRange: "$5-10" },
];

export default function CardForm() {
  const { toast } = useToast();
  const [captureMode, setCaptureMode] = useState<'none' | 'front' | 'back'>('none');
  const [frontImage, setFrontImage] = useState<string>('');
  const [backImage, setBackImage] = useState<string>('');
  const [selectedCondition, setSelectedCondition] = useState<string>("PSA 9");
  const [valueRange, setValueRange] = useState<string>("$180-220");
  const [showOCR, setShowOCR] = useState<boolean>(false);
  const { loading, error, data, analyzeImage } = useOCR();

  // Form setup
  const form = useForm<CardFormValues>({
    resolver: zodResolver(cardSchema),
    defaultValues: {
      sport: "",
      playerFirstName: "",
      playerLastName: "",
      brand: "",
      collection: "",
      cardNumber: "",
      year: new Date().getFullYear(),
      variant: "",
      serialNumber: "",
      condition: "PSA 9",
      estimatedValue: 200,
    },
  });

  // Submit card data to API
  const addCardMutation = useMutation({
    mutationFn: async (data: CardFormValues) => {
      const formData = new FormData();
      
      // Convert base64 image to Blob if present
      if (frontImage) {
        const frontBlob = await fetch(frontImage).then(r => r.blob());
        formData.append('frontImage', frontBlob, 'front.jpg');
      }
      
      if (backImage) {
        const backBlob = await fetch(backImage).then(r => r.blob());
        formData.append('backImage', backBlob, 'back.jpg');
      }
      
      // Append all other data
      formData.append('data', JSON.stringify(data));
      
      const response = await fetch('/api/cards', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      
      if (!response.ok) {
        throw new Error('Failed to save card');
      }
      
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Card saved successfully",
        description: "Your card has been added to your collection",
      });
      resetForm();
    },
    onError: (error) => {
      toast({
        title: "Failed to save card",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleImageCapture = (imageData: string) => {
    if (captureMode === 'front') {
      setFrontImage(imageData);
    } else if (captureMode === 'back') {
      setBackImage(imageData);
    }
    setCaptureMode('none');
  };
  
  const handleDirectFileUpload = (side: 'front' | 'back', imageData: string) => {
    if (side === 'front') {
      setFrontImage(imageData);
    } else {
      setBackImage(imageData);
    }
  };

  const handleSubmit = (data: CardFormValues) => {
    // Add image data to form submission
    const cardData = {
      ...data,
      frontImage,
      backImage,
    };
    
    addCardMutation.mutate(cardData);
  };

  const resetForm = () => {
    form.reset();
    setFrontImage('');
    setBackImage('');
    setSelectedCondition("PSA 9");
    setValueRange("$180-220");
  };

  const handleConditionChange = (value: string) => {
    const condition = conditionOptions.find(option => option.value === value);
    if (condition) {
      setSelectedCondition(value);
      setValueRange(condition.valueRange);
      form.setValue('condition', value);
      // Set an estimated value from the middle of the range
      const valueRangeStr = condition.valueRange.replace('$', '').split('-');
      if (valueRangeStr.length === 2) {
        const minValue = parseInt(valueRangeStr[0]);
        const maxValue = parseInt(valueRangeStr[1]);
        const estimatedValue = Math.round((minValue + maxValue) / 2);
        form.setValue('estimatedValue', estimatedValue);
      }
    }
  };

  const toggleCaptureMode = (side: 'front' | 'back') => {
    setCaptureMode(side);
  };
  
  const handleAnalyzeRequest = async () => {
    if (!frontImage) {
      toast({
        title: "Image required",
        description: "Please capture a front image of your card first",
        variant: "destructive"
      });
      return;
    }
    
    // Analyze the image and auto-fill the form
    try {
      // We're passing the form to the analyzeImage function to auto-fill
      await analyzeImage(frontImage, form);
    } catch (err) {
      // Error handling is done in the hook
      setShowOCR(true);
    }
  };
  
  const handleApplyOCRResults = (ocrData: Partial<CardFormValues>) => {
    // Apply OCR data to form
    if (ocrData.sport) form.setValue('sport', ocrData.sport);
    if (ocrData.playerFirstName) form.setValue('playerFirstName', ocrData.playerFirstName);
    if (ocrData.playerLastName) form.setValue('playerLastName', ocrData.playerLastName);
    if (ocrData.brand) form.setValue('brand', ocrData.brand);
    if (ocrData.collection) form.setValue('collection', ocrData.collection);
    if (ocrData.cardNumber) form.setValue('cardNumber', ocrData.cardNumber);
    if (ocrData.year && ocrData.year > 0) form.setValue('year', ocrData.year);
    if (ocrData.variant) form.setValue('variant', ocrData.variant);
    if (ocrData.serialNumber) form.setValue('serialNumber', ocrData.serialNumber);
    if (ocrData.condition) {
      handleConditionChange(ocrData.condition);
    }
    
    toast({
      title: "Card details applied",
      description: "OCR results have been applied to the form"
    });
    
    setShowOCR(false);
  };
  
  const handleCancelOCR = () => {
    setShowOCR(false);
  };

  if (captureMode !== 'none') {
    return (
      <div className="p-4">
        <h2 className="font-semibold text-lg mb-2">Capture {captureMode === 'front' ? 'Front' : 'Back'} Image</h2>
        <CameraCapture 
          onImageCapture={handleImageCapture} 
          side={captureMode}
        />
        <Button 
          variant="outline" 
          className="w-full mt-4"
          onClick={() => setCaptureMode('none')}
        >
          Cancel
        </Button>
      </div>
    );
  }

  const frontFileInputRef = useRef<HTMLInputElement>(null);
  const backFileInputRef = useRef<HTMLInputElement>(null);
  const [activeImageMenu, setActiveImageMenu] = useState<'front' | 'back' | null>(null);
  
  const handleFileSelect = (side: 'front' | 'back', event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
      const imageData = e.target?.result as string;
      if (side === 'front') {
        setFrontImage(imageData);
      } else {
        setBackImage(imageData);
      }
    };
    reader.readAsDataURL(file);
    setActiveImageMenu(null);
  };
  
  return (
    <div className="p-4">
      {/* Camera Capture Section */}
      <div className="mb-6">
        <h2 className="font-semibold text-lg mb-2">Card Images</h2>
        
        <div className="relative">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-3">
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
                onClick={() => setActiveImageMenu('front')}
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
                onClick={() => setActiveImageMenu('back')}
              >
                {backImage ? "Replace Back Image" : "Back Image"}
              </Button>
            </div>
          </div>
          
          {/* Image options menu */}
          {activeImageMenu && (
            <div className="absolute z-10 left-0 right-0 mt-1 rounded-md shadow-lg overflow-hidden">
              <div className="bg-slate-700">
                <button
                  className="flex items-center w-full px-4 py-3 text-white hover:bg-slate-600 border-b border-slate-800"
                  onClick={() => {
                    const fileInput = activeImageMenu === 'front' ? frontFileInputRef.current : backFileInputRef.current;
                    if (fileInput) {
                      fileInput.removeAttribute('capture');
                      fileInput.click();
                    }
                    setActiveImageMenu(null);
                  }}
                >
                  <ImageIcon className="h-5 w-5 mr-3" />
                  <span>Photo Library</span>
                </button>
                <button
                  className="flex items-center w-full px-4 py-3 text-white hover:bg-slate-600 border-b border-slate-800"
                  onClick={() => {
                    toggleCaptureMode(activeImageMenu);
                    setActiveImageMenu(null);
                  }}
                >
                  <Camera className="h-5 w-5 mr-3" />
                  <span>Take Photo</span>
                </button>
                <button
                  className="flex items-center w-full px-4 py-3 text-white hover:bg-slate-600"
                  onClick={() => {
                    const fileInput = activeImageMenu === 'front' ? frontFileInputRef.current : backFileInputRef.current;
                    if (fileInput) {
                      fileInput.removeAttribute('capture');
                      fileInput.click();
                    }
                    setActiveImageMenu(null);
                  }}
                >
                  <Upload className="h-5 w-5 mr-3" />
                  <span>Choose File</span>
                </button>
              </div>
              
              {/* Backdrop to close the menu when clicking outside */}
              <div 
                className="fixed inset-0 z-0" 
                onClick={() => setActiveImageMenu(null)}
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
        
        {frontImage && (
          <Button 
            type="button" 
            variant="secondary" 
            size="sm" 
            className="w-full mt-2"
            onClick={handleAnalyzeRequest}
          >
            <ScanSearch className="h-4 w-4 mr-2" />
            Analyze Card with OCR
          </Button>
        )}
        
        {showOCR && (
          <OCRResults 
            loading={loading} 
            error={error} 
            data={data} 
            onApply={handleApplyOCRResults} 
            onCancel={handleCancelOCR}
          />
        )}
        
        <p className="text-xs text-slate-500">Capture both front and back of your card for complete documentation.</p>
      </div>
      
      {/* Card Information Form */}
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleSubmit)}>
          <h2 className="font-semibold text-lg mb-3">Card Details</h2>
          
          {/* Sport Selection */}
          <div className="mb-4">
            <FormField
              control={form.control}
              name="sport"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-slate-700">Sport *</FormLabel>
                  <div className="flex flex-wrap gap-2">
                    {sportOptions.map((sport) => (
                      <Button
                        key={sport}
                        type="button"
                        variant="ghost"
                        className={`px-3 py-2 rounded-full text-sm font-medium ${
                          field.value === sport
                            ? 'bg-primary-100 text-primary-800'
                            : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                        }`}
                        onClick={() => form.setValue('sport', sport)}
                      >
                        {sport}
                      </Button>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          
          {/* Player Information */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <FormField
              control={form.control}
              name="playerFirstName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-slate-700">First Name *</FormLabel>
                  <FormControl>
                    <Input 
                      placeholder="Mike" 
                      {...field} 
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="playerLastName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-slate-700">Last Name *</FormLabel>
                  <FormControl>
                    <Input 
                      placeholder="Trout" 
                      {...field} 
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          
          {/* Card Brand */}
          <div className="mb-4">
            <FormField
              control={form.control}
              name="brand"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-slate-700">Brand *</FormLabel>
                  <Select 
                    onValueChange={field.onChange} 
                    value={field.value}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                        <SelectValue placeholder="Select brand" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {brandOptions.map((brand) => (
                        <SelectItem key={brand} value={brand}>{brand}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          
          {/* Collection */}
          <div className="mb-4">
            <FormField
              control={form.control}
              name="collection"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-slate-700">Collection</FormLabel>
                  <FormControl>
                    <Input 
                      placeholder="Series Two" 
                      {...field} 
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          
          {/* Card Details - Number and Year */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <FormField
              control={form.control}
              name="cardNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-slate-700">Card Number *</FormLabel>
                  <FormControl>
                    <Input 
                      placeholder="27" 
                      {...field} 
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="year"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-slate-700">Year *</FormLabel>
                  <FormControl>
                    <Input 
                      type="number" 
                      placeholder="2022" 
                      {...field}
                      value={field.value?.toString() || ''}
                      onChange={(e) => field.onChange(parseInt(e.target.value) || '')}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          
          {/* Variant */}
          <div className="mb-4">
            <FormField
              control={form.control}
              name="variant"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-slate-700">Variant</FormLabel>
                  <FormControl>
                    <Input 
                      placeholder="Base, Aqua Foil, etc." 
                      {...field} 
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          
          {/* Serial Number */}
          <div className="mb-6">
            <FormField
              control={form.control}
              name="serialNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-slate-700">Serial Number</FormLabel>
                  <FormControl>
                    <Input 
                      placeholder="" 
                      {...field} 
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    />
                  </FormControl>
                  <FormMessage />
                  <p className="text-xs text-slate-500 mt-1">If your card has a serial number printed on it</p>
                </FormItem>
              )}
            />
          </div>
          
          {/* Condition Rating */}
          <div className="mb-6">
            <FormLabel className="block text-sm font-medium text-slate-700 mb-1">Condition</FormLabel>
            <div className="flex items-center justify-between bg-slate-50 rounded-lg p-3">
              <div className="flex flex-col">
                <div className="flex items-baseline">
                  <span className="text-xl font-bold">{selectedCondition}</span>
                  <span className="ml-1 text-sm text-slate-500">
                    ({selectedCondition === "PSA 10" ? "Gem Mint" : 
                      selectedCondition === "PSA 9" ? "Mint" : 
                      selectedCondition === "PSA 8" ? "Near Mint-Mint" : 
                      selectedCondition === "PSA 7" ? "Near Mint" : 
                      selectedCondition === "PSA 6" ? "Excellent-Near Mint" : 
                      selectedCondition === "PSA 5" ? "Excellent" : 
                      selectedCondition === "PSA 4" ? "Very Good-Excellent" : 
                      selectedCondition === "PSA 3" ? "Very Good" : 
                      selectedCondition === "PSA 2" ? "Good" : "Poor"})
                  </span>
                </div>
                <div className="text-sm text-slate-600">Est. Value: <span className="font-medium text-secondary-600">{valueRange}</span></div>
              </div>
              <Select onValueChange={handleConditionChange} defaultValue={selectedCondition}>
                <SelectTrigger className="w-24 h-8 text-sm text-primary-600 font-medium bg-transparent border-none focus:ring-0">
                  <span>Change</span>
                </SelectTrigger>
                <SelectContent>
                  {conditionOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          
          {/* Submit Button - Enhanced with visual cues and feedback */}
          <div className="mt-8 space-y-4">
            <div className="relative">
              <div className="absolute -inset-1 bg-gradient-to-r from-primary-500 to-primary-700 opacity-70 blur rounded-xl"></div>
              <Button
                type="submit"
                className="relative w-full bg-gradient-to-r from-primary-600 to-primary-700 text-white font-bold py-5 px-6 rounded-lg hover:from-primary-700 hover:to-primary-800 shadow-lg flex items-center justify-center text-lg transition-all duration-200 ease-in-out hover:scale-[1.02]"
                disabled={addCardMutation.isPending}
              >
                {addCardMutation.isPending ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-3 h-6 w-6 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Saving to Collection...
                  </>
                ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                    </svg>
                    SAVE TO MY COLLECTION
                  </>
                )}
              </Button>
            </div>
            
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                className="text-slate-600"
                onClick={resetForm}
                disabled={addCardMutation.isPending}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Reset Form
              </Button>
            </div>
          </div>
        </form>
      </Form>
    </div>
  );
}
