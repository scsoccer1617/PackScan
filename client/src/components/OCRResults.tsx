import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Loader2, AlertCircle, Check, ThumbsUp, ThumbsDown, Database } from 'lucide-react';
import { CardFormValues } from "@shared/schema";
import { UseFormReturn } from "react-hook-form";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface OCRResultsProps {
  loading: boolean;
  error: string | null;
  data: Partial<CardFormValues> & { confirmedSource?: boolean };
  onApply: (data: Partial<CardFormValues>) => void;
  onCancel: () => void;
  form?: UseFormReturn<CardFormValues>;
}

export default function OCRResults({ loading, error, data: initialData, onApply, onCancel, form }: OCRResultsProps) {
  const [editMode, setEditMode] = useState(false);
  const [data, setData] = useState<Partial<CardFormValues> & { confirmedSource?: boolean }>({});
  const [editedData, setEditedData] = useState<Partial<CardFormValues>>({});
  const [confirmSaving, setConfirmSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (initialData) {
      setData(initialData);
      setEditedData(initialData);
    }
  }, [initialData]);

  const handleInputChange = (field: keyof CardFormValues, value: string | number | boolean) => {
    setEditedData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  if (loading) {
    return (
      <Card className="w-full mt-4 border border-slate-200">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg flex items-center">
            <Loader2 className="h-5 w-5 mr-2 animate-spin" />
            Analyzing Card Image
          </CardTitle>
          <CardDescription>
            Using Google Cloud Vision AI to analyze your card...
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-16 flex items-center justify-center">
            <p className="text-slate-500">This may take a few seconds. Google's powerful AI is extracting the details from your card image.</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  
  if (error) {
    return (
      <Alert variant="destructive" className="mt-4">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error Analyzing Image</AlertTitle>
        <AlertDescription>
          <div>
            <p>{error}</p>
            
            {error.includes('Vision API') || error.includes('Google Cloud') || error.includes('API') ? (
              <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-md">
                <p className="font-medium">API Configuration Issue</p>
                <p className="text-sm text-gray-700 mt-1">There appears to be an issue with the Google Cloud Vision API configuration.</p>
                <p className="text-sm text-gray-700 mt-1">Please follow the instructions to enable the API in your Google Cloud Console.</p>
              </div>
            ) : (
              <>
                <p className="mt-2">This could be due to:</p>
                <ul className="list-disc pl-5 mt-1 space-y-1">
                  <li>Poor image quality or lighting</li>
                  <li>Text on card not clearly visible</li>
                  <li>Card at an angle making text recognition difficult</li>
                </ul>
              </>
            )}
            
            <p className="mt-2">You can try again with a clearer image or manually enter the card details.</p>
          </div>
        </AlertDescription>
        <div className="mt-4">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </Alert>
    );
  }
  
  if (!data) {
    return null;
  }
  
  const applyAndUseDirectly = async () => {
    if (form) {
      const dataToApply = editMode ? editedData : data;
      Object.entries(dataToApply).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          form.setValue(key as any, value);
        }
      });
      
      try {
        await form.handleSubmit((values) => {
          console.log("Form submitted with values:", values);
        })();
      } catch (error) {
        console.error("Error saving OCR results:", error);
      }
      
      setData(editedData);
      setEditMode(false);
    } else {
      onApply(editMode ? editedData : data);
    }
  };

  const handleConfirmCard = async () => {
    setConfirmSaving(true);
    try {
      const dataToConfirm = editMode ? editedData : data;
      await apiRequest({
        url: '/api/confirmed-cards',
        method: 'POST',
        body: {
          sport: dataToConfirm.sport || 'Baseball',
          playerFirstName: dataToConfirm.playerFirstName,
          playerLastName: dataToConfirm.playerLastName,
          brand: dataToConfirm.brand,
          collection: dataToConfirm.collection || '',
          cardNumber: dataToConfirm.cardNumber,
          year: dataToConfirm.year,
          variant: dataToConfirm.variant || '',
          serialNumber: dataToConfirm.serialNumber || '',
          isRookieCard: dataToConfirm.isRookieCard || false,
          isAutographed: dataToConfirm.isAutographed || false,
          isNumbered: dataToConfirm.isNumbered || false,
        },
      });

      setConfirmed(true);
      toast({
        title: "Card Confirmed",
        description: "This card's info has been saved to the database for future lookups.",
      });
    } catch (error) {
      console.error('Error confirming card:', error);
      toast({
        title: "Error",
        description: "Could not save confirmed card data. Please try again.",
        variant: "destructive",
      });
    } finally {
      setConfirmSaving(false);
    }
  };

  const handleThumbsDown = () => {
    setEditMode(true);
  };

  const toggleEditMode = () => {
    setEditMode(!editMode);
  };

  return (
    <Card className="w-full mt-4 border border-slate-200">
      <CardHeader className="pb-2">
        <div className="flex justify-between items-center">
          <CardTitle className="text-lg flex items-center">
            {data.confirmedSource ? (
              <>
                <Database className="h-5 w-5 mr-2 text-blue-600" />
                Card Found in Database
              </>
            ) : (
              <>
                <Check className="h-5 w-5 mr-2 text-green-600" />
                Card Information Found
              </>
            )}
          </CardTitle>
        </div>
        <CardDescription>
          {editMode 
            ? "Edit any incorrect details, then confirm to save" 
            : data.confirmedSource
              ? "This card was identified from previously confirmed data"
              : "Is this information correct?"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {editMode ? (
          <div className="form-grid">
            <div className="space-y-2 col-span-1 md:col-span-2">
              <Label htmlFor="sport">Sport</Label>
              <Select
                value={editedData.sport || 'Baseball'}
                onValueChange={(value) => handleInputChange('sport', value)}
              >
                <SelectTrigger id="sport">
                  <SelectValue placeholder="Select sport">
                    {editedData.sport || 'Baseball'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {["Baseball", "Football", "Basketball", "Hockey", "Soccer", "Other"].map((sport) => (
                    <SelectItem key={sport} value={sport}>{sport}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="playerFirstName">First Name</Label>
              <Input
                id="playerFirstName"
                value={editedData.playerFirstName || ''}
                onChange={(e) => handleInputChange('playerFirstName', e.target.value)}
                placeholder="Player First Name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="playerLastName">Last Name</Label>
              <Input
                id="playerLastName"
                value={editedData.playerLastName || ''}
                onChange={(e) => handleInputChange('playerLastName', e.target.value)}
                placeholder="Player Last Name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="brand">Brand</Label>
              <Select
                value={editedData.brand || ''}
                onValueChange={(value) => handleInputChange('brand', value)}
              >
                <SelectTrigger id="brand">
                  <SelectValue placeholder="Select brand" />
                </SelectTrigger>
                <SelectContent>
                  {["Topps", "Panini", "Upper Deck", "Bowman", "Fleer", "Donruss", "Score", "Other"].map((brand) => (
                    <SelectItem key={brand} value={brand}>{brand}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="collection">Collection</Label>
              <Input
                id="collection"
                value={editedData.collection || ''}
                onChange={(e) => handleInputChange('collection', e.target.value)}
                placeholder="Card Collection"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="cardNumber">Card Number</Label>
              <Input
                id="cardNumber"
                value={editedData.cardNumber || ''}
                onChange={(e) => handleInputChange('cardNumber', e.target.value)}
                placeholder="Card Number"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="year">Year</Label>
              <Input
                id="year"
                type="number"
                value={editedData.year || ''}
                onChange={(e) => handleInputChange('year', parseInt(e.target.value) || '')}
                placeholder="Card Year"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="variant">Variant</Label>
              <Input
                id="variant"
                value={editedData.variant || ''}
                onChange={(e) => handleInputChange('variant', e.target.value)}
                placeholder="Card Variant"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="serialNumber">Serial Number</Label>
              <Input
                id="serialNumber"
                value={editedData.serialNumber || ''}
                onChange={(e) => handleInputChange('serialNumber', e.target.value)}
                placeholder="Serial Number (if any)"
              />
            </div>

            <div className="space-y-2 col-span-1 md:col-span-2">
              <Label htmlFor="condition">Condition</Label>
              <Select
                value={editedData.condition || ''}
                onValueChange={(value) => handleInputChange('condition', value)}
              >
                <SelectTrigger id="condition">
                  <SelectValue placeholder="Select condition" />
                </SelectTrigger>
                <SelectContent>
                  {["PSA 10", "PSA 9", "PSA 8", "PSA 7", "PSA 6", "PSA 5", "Raw-Mint", "Raw-Good", "Raw-Poor"].map((condition) => (
                    <SelectItem key={condition} value={condition}>{condition}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="col-span-2 space-y-2 mt-4">
              <Label>Card Features</Label>
              <div className="flex flex-wrap gap-6">
                <div className="flex items-center space-x-2">
                  <input 
                    type="checkbox" 
                    id="isRookieCard" 
                    checked={editedData.isRookieCard === true}
                    onChange={(e) => handleInputChange('isRookieCard', e.target.checked === true)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <Label htmlFor="isRookieCard" className="font-normal text-sm">Rookie Card</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <input 
                    type="checkbox" 
                    id="isAutographed" 
                    checked={editedData.isAutographed === true}
                    onChange={(e) => handleInputChange('isAutographed', e.target.checked === true)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <Label htmlFor="isAutographed" className="font-normal text-sm">Autographed</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <input 
                    type="checkbox" 
                    id="isNumbered" 
                    checked={editedData.isNumbered === true}
                    onChange={(e) => handleInputChange('isNumbered', e.target.checked === true)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <Label htmlFor="isNumbered" className="font-normal text-sm">Numbered</Label>
                </div>
              </div>
            </div>

            <div className="col-span-2 space-y-2 mt-2">
              <Label htmlFor="notes">Notes</Label>
              <Input
                id="notes"
                value={editedData.notes || ''}
                onChange={(e) => handleInputChange('notes', e.target.value)}
                placeholder="Any additional details about the card"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="space-y-4">
              <div className="text-lg">
                <span className="font-semibold text-slate-800">Sport: </span>
                <span className="text-slate-700">{data.sport || 'Not detected'}</span>
              </div>

              <div className="text-lg">
                <span className="font-semibold text-slate-800">Player: </span>
                <span className="text-slate-700">{data.playerFirstName || ''} {data.playerLastName || 'Not detected'}</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
                <div className="space-y-4">
                  <div className="text-lg">
                    <span className="font-semibold text-slate-800">Brand: </span>
                    <span className="text-slate-700">{data.brand || 'Not detected'}</span>
                  </div>

                  <div className="text-lg">
                    <span className="font-semibold text-slate-800">Card #: </span>
                    <span className="text-slate-700">{data.cardNumber || 'Not detected'}</span>
                  </div>

                  <div className="text-lg">
                    <span className="font-semibold text-slate-800">Variant: </span>
                    <span className="text-slate-700">{data.variant || 'Not detected'}</span>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="text-lg">
                    <span className="font-semibold text-slate-800">Collection: </span>
                    <span className="text-slate-700">{data.collection || 'Not detected'}</span>
                  </div>

                  <div className="text-lg">
                    <span className="font-semibold text-slate-800">Year: </span>
                    <span className="text-slate-700">{data.year && data.year > 0 ? data.year : 'Not detected'}</span>
                  </div>

                  <div className="text-lg">
                    <span className="font-semibold text-slate-800">Serial #: </span>
                    <span className="text-slate-700">{data.serialNumber || 'None'}</span>
                  </div>
                </div>
              </div>

              <div className="text-lg">
                <span className="font-semibold text-slate-800">Condition: </span>
                <span className="text-slate-700">{data.condition || 'Not detected'}</span>
              </div>

              <div className="mt-6">
                <div className="text-lg mb-3">
                  <span className="font-semibold text-slate-800">Card Features:</span>
                </div>
                <div className="ml-0">
                  {data.isRookieCard === true || data.isAutographed === true || data.isNumbered === true ? (
                    <div className="flex flex-wrap gap-3">
                      {data.isRookieCard === true && (
                        <span className="inline-flex items-center rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-800">
                          Rookie Card
                        </span>
                      )}
                      {data.isAutographed === true && (
                        <span className="inline-flex items-center rounded-full bg-blue-100 px-3 py-1 text-sm font-medium text-blue-800">
                          Autographed
                        </span>
                      )}
                      {data.isNumbered === true && (
                        <span className="inline-flex items-center rounded-full bg-purple-100 px-3 py-1 text-sm font-medium text-purple-800">
                          Numbered
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-slate-500 text-lg">None detected</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
      <CardFooter className="flex justify-between">
        <Button 
          variant="outline" 
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }}
        >
          Cancel
        </Button>
        {editMode ? (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setEditMode(false);
              }}
            >
              Back
            </Button>
            <Button
              type="button"
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                setData(editedData);
                setEditMode(false);
                applyAndUseDirectly();
              }}
              className="bg-green-600 hover:bg-green-500 text-white"
            >
              <Check className="h-4 w-4 mr-1" />
              Save & Re-lookup
            </Button>
          </div>
        ) : confirmed ? (
          <span className="inline-flex items-center text-green-600 font-medium">
            <Check className="h-4 w-4 mr-1" />
            Confirmed & Saved
          </span>
        ) : (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleThumbsDown();
              }}
              className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
            >
              <ThumbsDown className="h-4 w-4 mr-1" />
              Edit
            </Button>
            <Button
              type="button"
              disabled={confirmSaving}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleConfirmCard();
              }}
              className="bg-green-600 hover:bg-green-500 text-white"
            >
              {confirmSaving ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <ThumbsUp className="h-4 w-4 mr-1" />
              )}
              Confirm & Save
            </Button>
          </div>
        )}
      </CardFooter>
    </Card>
  );
}
