import { useState } from "react";
import SimpleImageUploader from "@/components/SimpleImageUploader";
import { Button } from "@/components/ui/button";
import { ScanSearch } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CardFormValues, cardSchema } from "@shared/schema";
import { useOCR } from "@/hooks/use-ocr";
import { useToast } from "@/hooks/use-toast";
import OCRResults from "./OCRResults";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export default function SimpleCardForm() {
  const [frontImage, setFrontImage] = useState<string>("");
  const [backImage, setBackImage] = useState<string>("");
  const [showOCRResults, setShowOCRResults] = useState<boolean>(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const form = useForm<CardFormValues>({
    resolver: zodResolver(cardSchema),
    defaultValues: {
      sport: "Baseball",
      playerFirstName: "",
      playerLastName: "",
      brand: "Topps",
      collection: "",
      cardNumber: "",
      year: new Date().getFullYear(),
      variant: "",
      serialNumber: "",
      condition: "PSA 9",
      estimatedValue: 200,
      isRookieCard: false,
      isAutographed: false,
      isNumbered: false,
      notes: "",
    },
  });
  
  // OCR hook for analyzing card images
  const { loading: ocrLoading, error: ocrError, data: ocrData, analyzeImage } = useOCR();
  
  // Handle OCR analysis request
  const handleAnalyzeRequest = async () => {
    if (!backImage) {
      toast({
        title: "Back Image Required",
        description: "Please upload the BACK of the card for OCR analysis. Card numbers and details are typically found on the back.",
        variant: "destructive",
      });
      return;
    }
    
    try {
      // Use the back image for OCR since it contains the card number and details
      await analyzeImage(backImage, form);
      setShowOCRResults(true);
    } catch (error) {
      toast({
        title: "Analysis Failed",
        description: "Could not analyze the card image. Please try again or enter details manually.",
        variant: "destructive",
      });
    }
  };
  
  // Apply OCR results to form
  const applyOCRResults = (data: Partial<CardFormValues>) => {
    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        form.setValue(key as any, value);
      }
    });
    setShowOCRResults(false);
    
    toast({
      title: "OCR Results Applied",
      description: "Card details have been populated from the image analysis.",
    });
  };
  
  // Create card mutation
  const createCardMutation = useMutation({
    mutationFn: async (data: CardFormValues) => {
      // Convert the form data to FormData to include images
      const formData = new FormData();
      
      // Properly serialize card data as JSON string
      const cardDataJson = JSON.stringify(data);
      formData.append('data', cardDataJson);
      
      // Add images if they exist
      if (frontImage) {
        try {
          const frontBlob = await fetch(frontImage).then(r => r.blob());
          formData.append('frontImage', frontBlob, 'front.jpg');
        } catch (error) {
          console.error('Error converting front image:', error);
          throw new Error('Failed to process front image. Please try uploading a different image.');
        }
      }
      
      if (backImage) {
        try {
          const backBlob = await fetch(backImage).then(r => r.blob());
          formData.append('backImage', backBlob, 'back.jpg');
        } catch (error) {
          console.error('Error converting back image:', error);
          throw new Error('Failed to process back image. Please try uploading a different image.');
        }
      }
      
      return apiRequest<any>({
        url: '/api/cards',
        method: 'POST',
        body: formData,
        headers: {
          // Don't set Content-Type, browser will set it with proper boundary for FormData
        },
      });
    },
    onSuccess: (data) => {
      // Reset the form
      form.reset();
      setFrontImage("");
      setBackImage("");
      
      // Invalidate cards query to refresh the collection
      queryClient.invalidateQueries({ queryKey: ['/api/cards'] });
      
      // Check if Google Sheets export was successful
      if (data.googleSheetsStatus) {
        if (data.googleSheetsStatus.success) {
          toast({
            title: "Card Added Successfully",
            description: "Your card has been added to the collection and synced to Google Sheets!",
          });
        } else {
          // Card was saved to database but not to Google Sheets
          toast({
            title: "Card Added with Warning",
            description: "Card saved to collection but couldn't sync to Google Sheets. A CSV backup was created.",
            variant: "warning",
          });
          
          // Log the detailed error for troubleshooting
          console.warn("Google Sheets sync issue:", data.googleSheetsStatus.error);
        }
      } else {
        // Standard success message if no Google Sheets status info
        toast({
          title: "Card Added",
          description: "Your card has been added to the collection!",
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: "Error Adding Card",
        description: error.message || "Failed to add card. Please try again.",
        variant: "destructive",
      });
    },
  });
  
  const handleSubmit = (data: CardFormValues) => {
    if (!frontImage) {
      toast({
        title: "Front Image Required",
        description: "Please upload a front image of the card.",
        variant: "destructive",
      });
      return;
    }
    
    createCardMutation.mutate(data);
  };
  
  return (
    <div className="p-4">
      <Card className="shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-2xl font-bold text-slate-800">
            Add to Collection
          </CardTitle>
          <CardDescription>
            Capture both front and back of your card. The front will be shown in your collection while the back is needed for OCR detection of card details.
          </CardDescription>
        </CardHeader>
        
        <CardContent className="space-y-4">
          <div className="mb-6">
            <h3 className="text-lg font-medium text-slate-700 mb-2">Card Images</h3>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <SimpleImageUploader 
                  label="Front"
                  existingImage={frontImage}
                  onImageCaptured={setFrontImage}
                />
                <p className="text-xs text-slate-500 mt-1">Shows in collection</p>
              </div>
              
              <div>
                <SimpleImageUploader 
                  label="Back"
                  existingImage={backImage}
                  onImageCaptured={setBackImage}
                />
                <p className="text-xs text-slate-500 mt-1">Contains card number</p>
              </div>
            </div>
            
            {backImage && (
              <Button 
                type="button" 
                variant="secondary" 
                size="sm" 
                className="w-full mt-2"
                onClick={handleAnalyzeRequest}
                disabled={ocrLoading}
              >
                <ScanSearch className="h-4 w-4 mr-2" />
                {ocrLoading ? "Analyzing..." : "Analyze Card with OCR (uses back of card)"}
              </Button>
            )}
            
            {/* OCR Results Dialog */}
            {showOCRResults && (
              <OCRResults
                loading={ocrLoading}
                error={ocrError}
                data={ocrData}
                onApply={applyOCRResults}
                onCancel={() => setShowOCRResults(false)}
              />
            )}
          </div>
          
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="sport"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sport <span className="text-red-500">*</span></FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select sport" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {["Baseball", "Football", "Basketball", "Hockey", "Soccer", "Other"].map((sport) => (
                          <SelectItem key={sport} value={sport}>{sport}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="playerFirstName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>First Name <span className="text-red-500">*</span></FormLabel>
                      <FormControl>
                        <Input placeholder="First name" {...field} />
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
                      <FormLabel>Last Name <span className="text-red-500">*</span></FormLabel>
                      <FormControl>
                        <Input placeholder="Last name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <FormField
                control={form.control}
                name="brand"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Brand <span className="text-red-500">*</span></FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select brand" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {["Topps", "Panini", "Upper Deck", "Bowman", "Fleer", "Donruss", "Score", "Other"].map((brand) => (
                          <SelectItem key={brand} value={brand}>{brand}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="collection"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Collection</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Chrome, Series 1" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="cardNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Card Number</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 42, BP-12" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="year"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Year <span className="text-red-500">*</span></FormLabel>
                      <FormControl>
                        <Input 
                          type="number" 
                          placeholder="e.g. 2024" 
                          {...field} 
                          onChange={(e) => field.onChange(parseInt(e.target.value) || '')}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="variant"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Variant</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Refractor, Parallel" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="serialNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Serial Number</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 42/100" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="condition"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Condition <span className="text-red-500">*</span></FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select condition" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {["PSA 10", "PSA 9", "PSA 8", "PSA 7", "PSA 6", "PSA 5", "Raw-Mint", "Raw-Good", "Raw-Poor"].map((condition) => (
                            <SelectItem key={condition} value={condition}>{condition}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <div className="flex flex-col space-y-2">
                <h3 className="text-sm font-medium text-slate-700">Card Features</h3>
                <div className="grid grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="isRookieCard"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                        <FormLabel className="font-normal">Rookie Card</FormLabel>
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="isAutographed"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                        <FormLabel className="font-normal">Autographed</FormLabel>
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="isNumbered"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                        <FormLabel className="font-normal">Numbered</FormLabel>
                      </FormItem>
                    )}
                  />
                </div>
              </div>
              
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Input placeholder="Any additional details about the card" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <div className="pt-4">
                <p className="text-center text-sm mb-3 text-amber-600 font-medium">
                  ↓ Click the button below to add this card to your collection ↓
                </p>
                <Button 
                  type="submit" 
                  className="w-full bg-green-600 hover:bg-green-500 active:bg-green-700 text-white py-6 text-lg font-bold"
                  disabled={createCardMutation.isPending}
                >
                  {createCardMutation.isPending ? "Adding to Collection..." : "ADD TO COLLECTION"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}