import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Loader2, AlertCircle, Check, Pencil } from 'lucide-react';
import { CardFormValues } from "@shared/schema";
import { UseFormReturn } from "react-hook-form";

interface OCRResultsProps {
  loading: boolean;
  error: string | null;
  data: Partial<CardFormValues> | null;
  onApply: (data: Partial<CardFormValues>) => void;
  onCancel: () => void;
  form?: UseFormReturn<CardFormValues>;
}

export default function OCRResults({ loading, error, data, onApply, onCancel, form }: OCRResultsProps) {
  const [editMode, setEditMode] = useState(false);
  const [editedData, setEditedData] = useState<Partial<CardFormValues>>({});
  
  // Debug log to check if isRookieCard is properly set
  useEffect(() => {
    if (data) {
      console.log("OCR Results rookie card status:", data.isRookieCard);
    }
  }, [data]);

  // When OCR data changes, update our local state
  useEffect(() => {
    if (data) {
      setEditedData(data);
    }
  }, [data]);

  // Handle input changes
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
            Close
          </Button>
        </div>
      </Alert>
    );
  }
  
  if (!data) {
    return null;
  }
  
  // Function to apply OCR data and hide standard form
  const applyAndUseDirectly = () => {
    if (form) {
      // Apply all fields from edited data to the form
      const dataToApply = editMode ? editedData : data;
      Object.entries(dataToApply).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          form.setValue(key as any, value);
        }
      });
      
      // Hide OCR dialog and proceed with the form data
      onCancel();
    } else {
      // If no form is provided, just call the regular onApply
      onApply(editMode ? editedData : data);
    }
  };

  return (
    <Card className="w-full mt-4 border border-slate-200">
      <CardHeader className="pb-2">
        <div className="flex justify-between items-center">
          <CardTitle className="text-lg flex items-center">
            <Check className="h-5 w-5 mr-2 text-green-600" />
            Card Information Found
          </CardTitle>
        </div>
        <CardDescription>
          {editMode 
            ? "Edit any incorrect details before applying" 
            : "We identified the following details from your card image"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {editMode ? (
          <div className="form-grid">
            {/* Sport Dropdown */}
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

            {/* First row - Player Name */}
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

            {/* Second row - Brand and Collection */}
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

            {/* Third row - Card Number and Year */}
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

            {/* Fourth row - Variant and Serial Number */}
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

            {/* Fifth row - Condition */}
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

            {/* Card Features */}
            <div className="col-span-2 space-y-2 mt-4">
              <Label>Card Features</Label>
              <div className="flex flex-wrap gap-6">
                <div className="flex items-center space-x-2">
                  <input 
                    type="checkbox" 
                    id="isRookieCard" 
                    checked={editedData.isRookieCard === true}
                    onChange={(e) => {
                      handleInputChange('isRookieCard', e.target.checked === true);
                      console.log("OCR Rookie checkbox changed to:", e.target.checked);
                    }}
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

            {/* Notes field */}
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
          <div className="space-y-4">
            {/* Summary box at the top */}
            <div className="bg-green-50 border border-green-100 rounded-lg p-3">
              <h3 className="font-semibold text-green-800 mb-1 text-sm">Card Analysis Results</h3>
              
              <p className="text-sm text-green-700">
                {data.sport ? `${data.sport} ` : ''}
                {data.sport && (data.playerFirstName || data.playerLastName) ? '• ' : ''}
                {data.playerFirstName || data.playerLastName ? 
                  `${data.playerFirstName || ''} ${data.playerLastName || ''} • ` : ''}
                {data.year ? `${data.year} ` : ''}
                {data.brand ? `${data.brand} ` : ''}
                {data.collection ? `${data.collection} ` : ''}
                {data.cardNumber ? `#${data.cardNumber}` : ''}
              </p>
            </div>
            
            {/* Detailed results grid */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {data.sport && (
                <div className="col-span-2 py-1 border-b border-gray-100">
                  <span className="font-medium text-slate-700">Sport:</span> 
                  <span className="text-slate-900">{data.sport}</span>
                </div>
              )}
              
              <div className="col-span-2 py-1 border-b border-gray-100">
                <span className="font-medium text-slate-700">Player:</span> <span className="text-slate-900">{data.playerFirstName || ''} {data.playerLastName || ''}</span>
              </div>
              
              <div className="py-1 border-b border-gray-100">
                <span className="font-medium text-slate-700">Brand:</span> <span className="text-slate-900">{data.brand || 'Not detected'}</span>
              </div>
              
              <div className="py-1 border-b border-gray-100">
                <span className="font-medium text-slate-700">Collection:</span> <span className="text-slate-900">{data.collection || 'Not detected'}</span>
              </div>
              
              <div className="py-1 border-b border-gray-100">
                <span className="font-medium text-slate-700">Card #:</span> <span className="text-slate-900">{data.cardNumber || 'Not detected'}</span>
              </div>
              
              <div className="py-1 border-b border-gray-100">
                <span className="font-medium text-slate-700">Year:</span> <span className="text-slate-900">{data.year && data.year > 0 ? data.year : 'Not detected'}</span>
              </div>
              
              <div className="py-1 border-b border-gray-100">
                <span className="font-medium text-slate-700">Variant:</span> <span className="text-slate-900">{data.variant || 'Not detected'}</span>
              </div>
              
              <div className="py-1 border-b border-gray-100">
                <span className="font-medium text-slate-700">Serial #:</span> <span className="text-slate-900">{data.serialNumber || 'None'}</span>
              </div>
              
              <div className="col-span-2 py-1 border-b border-gray-100">
                <span className="font-medium text-slate-700">Condition:</span> <span className="text-slate-900">{data.condition || 'Not detected'}</span>
              </div>
              
              {/* Card Features */}
              <div className="col-span-2 py-2">
                <span className="font-medium text-slate-700 block mb-1">Card Features:</span>
                <div className="flex flex-wrap gap-3">
                  {data.isRookieCard === true && (
                    <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-800">
                      Rookie Card
                    </span>
                  )}
                  {data.isAutographed === true && (
                    <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-1 text-xs font-medium text-blue-800">
                      Autographed
                    </span>
                  )}
                  {data.isNumbered === true && (
                    <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-1 text-xs font-medium text-purple-800">
                      Numbered
                    </span>
                  )}
                  {data.isRookieCard !== true && data.isAutographed !== true && data.isNumbered !== true && (
                    <span className="text-gray-500 text-xs">None detected</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
      <CardFooter className="flex justify-between">
        <Button variant="outline" onClick={onCancel}>
          Close
        </Button>
        {!editMode ? (
          <Button
            onClick={() => setEditMode(true)}
            className="bg-blue-600 hover:bg-blue-500 text-white"
          >
            Edit Card Details
          </Button>
        ) : (
          <Button
            onClick={() => {
              applyAndUseDirectly();
              setEditMode(false);
            }}
            className="bg-green-600 hover:bg-green-500 text-white"
          >
            Save Changes
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}