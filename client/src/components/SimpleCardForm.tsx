import { useState } from "react";
import SimpleImageUploader from "@/components/SimpleImageUploader";
import { Button } from "@/components/ui/button";
import { ScanSearch, Edit2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CardFormValues, cardSchema } from "@shared/schema";
import { useOCR } from "@/hooks/use-ocr";
import { useToast } from "@/hooks/use-toast";
import OCRResults from "./OCRResults";
import EbayValueLookup from "./EbayValueLookup";
import ServerEbayLookup from "./ServerEbayLookup";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export default function SimpleCardForm() {
  const [frontImage, setFrontImage] = useState<string>("");
  const [backImage, setBackImage] = useState<string>("");
  const [showOCRResults, setShowOCRResults] = useState<boolean>(false);
  const [showFormFields, setShowFormFields] = useState<boolean>(false);
  const [savedCardId, setSavedCardId] = useState<number | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const form = useForm<CardFormValues>({
    resolver: zodResolver(cardSchema),
    defaultValues: {
      sport: "",
      playerFirstName: "",
      playerLastName: "",
      brand: "Topps",
      collection: "",
      cardNumber: "",
      year: new Date().getFullYear(),
      variant: "",
      serialNumber: "",
      condition: "PSA 8", // Changed from PSA 9 to PSA 8 as requested
      estimatedValue: 0,
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
      setShowFormFields(false); // Hide form fields when showing OCR results
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
    // Debug log to check the incoming data
    console.log("Applying OCR results to form:", data);
    
    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        // Special handling for boolean values
        if (key === 'isRookieCard' || key === 'isAutographed' || key === 'isNumbered') {
          form.setValue(key as any, value === true);
        } else {
          form.setValue(key as any, value);
        }
      }
    });
    setShowOCRResults(false);
    setShowFormFields(true); // Show form fields with OCR data applied
    
    toast({
      title: "OCR Results Applied",
      description: "Card details have been populated from the image analysis.",
    });
  };
  
  // Create card mutation
  const createCardMutation = useMutation({
    mutationFn: async (data: CardFormValues) => {
      // Instead of FormData, let's use a direct object with image data
      const cardData = {
        ...data,
        frontImage: frontImage || undefined,
        backImage: backImage || undefined
      };
      
      // This approach works better with our routes
      return apiRequest<any>({
        url: '/api/cards',
        method: 'POST',
        body: cardData,
      });
    },
    onSuccess: (data) => {
      // Store the new card ID for eBay lookup
      if (data && data.card && data.card.id) {
        setSavedCardId(data.card.id);
        console.log("Card saved successfully with ID:", data.card.id);
      }
      
      // Always reset the form after successfully saving a card
      form.reset();
      setFrontImage("");
      setBackImage("");
      setShowFormFields(false);
      setShowOCRResults(false); // Hide OCR results
      
      // Force return to Add Card state
      
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
            variant: "default", // Using default for warning since "warning" is not a supported variant
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

  // Handle cancellation of OCR results view
  const handleOCRCancel = () => {
    // When user clicks Cancel, go back to image upload view
    setShowOCRResults(false);
    // Reset form fields visibility to default state
    setShowFormFields(false);
  };

  // Handle edit button click to show the form fields 
  const handleEditClick = () => {
    setShowFormFields(true);
  };
  
  return (
    <div className="p-4">
      <Card className="shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-2xl font-bold text-slate-800">
            Add to Collection
          </CardTitle>
          <CardDescription>
            Add a new card to your collection.
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
              </div>
              
              <div>
                <SimpleImageUploader 
                  label="Back"
                  existingImage={backImage}
                  onImageCaptured={setBackImage}
                />
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
                {ocrLoading ? "Analyzing..." : "Analyze Card with OCR"}
              </Button>
            )}
            
            {/* OCR Results Dialog */}
            {showOCRResults && (
              <>
                <OCRResults
                  loading={ocrLoading}
                  error={ocrError}
                  data={ocrData}
                  form={form}
                  onApply={applyOCRResults}
                  onCancel={handleOCRCancel}
                />
                
                {/* Show eBay lookup and value fields when OCR data is available */}
                {!ocrLoading && !ocrError && ocrData && (
                  <div className="mt-6 space-y-4 border-t border-gray-200 pt-4">
                    <h3 className="text-lg font-medium text-slate-700">Card Value</h3>
                    
                    {/* eBay Value Lookup */}
                    <div className="mb-4">
                      {/* Use client-side EbayValueLookup with current form values */}
                      <div className="mt-2 pt-2 border-gray-200">
                        <EbayValueLookup
                          playerName={`${form.watch('playerFirstName')} ${form.watch('playerLastName')}`.trim()}
                          cardNumber={form.watch('cardNumber')}
                          brand={form.watch('brand')}
                          year={form.watch('year') || new Date().getFullYear()}
                          collection={form.watch('collection')}
                          variant={form.watch('variant')}
                          condition={form.watch('condition')}
                          onValueSelect={(value) => {
                            form.setValue('estimatedValue', value);
                          }}
                        />
                      </div>
                    </div>
                    
                    {/* Estimated Value Field */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                        Estimated Value ($)
                      </label>
                      <div className="relative">
                        <Input
                          type="number"
                          placeholder="Card value in USD"
                          value={form.watch('estimatedValue') === 0 ? '' : form.watch('estimatedValue')}
                          onChange={(e) => form.setValue('estimatedValue', parseFloat(e.target.value) || 0)}
                          className="pl-7"
                        />
                        <div className="absolute inset-y-0 left-0 flex items-center pl-2 pointer-events-none">
                          <span className="text-gray-500">$</span>
                        </div>
                      </div>
                    </div>
                    
                    {/* Add to Collection button */}
                    <div className="pt-4">
                      <Button 
                        onClick={form.handleSubmit(handleSubmit)}
                        className="w-full bg-green-600 hover:bg-green-500 active:bg-green-700 text-white py-6 text-lg font-bold"
                        disabled={createCardMutation.isPending}
                      >
                        {createCardMutation.isPending ? "Adding to Collection..." : "ADD TO COLLECTION"}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          
          {/* We don't show the Edit Card Details Manually button as requested */}
          
          {/* Show form fields only when explicitly requested */}
          {!showOCRResults && showFormFields && (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
                <div className="form-grid mb-4">
                  <FormField
                    control={form.control}
                    name="sport"
                    render={({ field }) => (
                      <FormItem className="col-span-1 md:col-span-2">
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
                
                <div className="form-grid mb-4">
                  <FormField
                    control={form.control}
                    name="brand"
                    render={({ field }) => (
                      <FormItem className="col-span-1 md:col-span-2">
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
                </div>
                
                <div className="form-grid mb-4">
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
                
                <div className="form-grid mb-4">
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
                
                <div className="form-grid mb-4">
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
                
                {/* Card Features */}
                <div className="mt-2">
                  <h3 className="text-sm font-medium text-slate-700 mb-2">Card Features</h3>
                  <div className="flex flex-wrap gap-6">
                    <FormField
                      control={form.control}
                      name="isRookieCard"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={field.onChange}
                              className="h-5 w-5"
                            />
                          </FormControl>
                          <FormLabel className="font-normal text-sm ml-2">Rookie Card</FormLabel>
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
                              className="h-5 w-5"
                            />
                          </FormControl>
                          <FormLabel className="font-normal text-sm ml-2">Autographed</FormLabel>
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
                              className="h-5 w-5"
                            />
                          </FormControl>
                          <FormLabel className="font-normal text-sm ml-2">Numbered</FormLabel>
                        </FormItem>
                      )}
                    />
                  </div>
                </div>
                
                {/* Notes Field */}
                <div className="form-grid mb-4">
                  <FormField
                    control={form.control}
                    name="notes"
                    render={({ field }) => (
                      <FormItem className="col-span-1 md:col-span-2">
                        <FormLabel>Notes</FormLabel>
                        <FormControl>
                          <Input placeholder="Any additional details about the card" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                
                {/* eBay Value Lookup and Estimated Value Field */}
                <div className="form-grid mb-4">
                  <div className="col-span-1 md:col-span-2">
                    <FormLabel>Card Value</FormLabel>
                    
                    {/* eBay Value Lookup */}
                    <div className="mb-4">
                      <EbayValueLookup
                        playerName={`${form.watch('playerFirstName')} ${form.watch('playerLastName')}`.trim()}
                        cardNumber={form.watch('cardNumber')}
                        brand={form.watch('brand')}
                        year={form.watch('year') || new Date().getFullYear()}
                        collection={form.watch('collection')}
                        variant={form.watch('variant')}
                        condition={form.watch('condition')}
                        onValueSelect={(value) => {
                          form.setValue('estimatedValue', value);
                        }}
                      />
                    </div>
                  </div>
                  
                  <FormField
                    control={form.control}
                    name="estimatedValue"
                    render={({ field }) => (
                      <FormItem className="col-span-1 md:col-span-2">
                        <FormLabel>Estimated Value ($) <span className="text-red-500">*</span></FormLabel>
                        <div className="flex flex-col space-y-2">
                          <FormControl>
                            <div className="relative">
                              <Input
                                type="number"
                                placeholder="Card value in USD"
                                {...field}
                                value={field.value === 0 ? '' : field.value}
                                onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                                className="pl-7"
                              />
                              <div className="absolute inset-y-0 left-0 flex items-center pl-2 pointer-events-none">
                                <span className="text-gray-500">$</span>
                              </div>
                            </div>
                          </FormControl>
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                
                <div className="pt-4">
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}