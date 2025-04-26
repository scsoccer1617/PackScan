import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertCircle, Check, Edit2, Pencil } from 'lucide-react';
import { CardFormValues } from "@shared/schema";

interface OCRResultsProps {
  loading: boolean;
  error: string | null;
  data: Partial<CardFormValues> | null;
  onApply: (data: Partial<CardFormValues>) => void;
  onCancel: () => void;
}

export default function OCRResults({ loading, error, data, onApply, onCancel }: OCRResultsProps) {
  const [editMode, setEditMode] = useState(false);
  const [editedData, setEditedData] = useState<Partial<CardFormValues>>({});

  // When OCR data changes, update our local state
  useEffect(() => {
    if (data) {
      setEditedData(data);
    }
  }, [data]);

  // Handle input changes
  const handleInputChange = (field: keyof CardFormValues, value: string | number) => {
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
  
  return (
    <Card className="w-full mt-4 border border-slate-200">
      <CardHeader className="pb-2">
        <div className="flex justify-between items-center">
          <CardTitle className="text-lg flex items-center">
            <Check className="h-5 w-5 mr-2 text-green-600" />
            Card Information Found
          </CardTitle>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => setEditMode(!editMode)} 
            className="h-8 px-2"
          >
            <Pencil className="h-4 w-4 mr-1" />
            {editMode ? "View" : "Edit"}
          </Button>
        </div>
        <CardDescription>
          {editMode 
            ? "Edit any incorrect details before applying" 
            : "We identified the following details from your card image"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {editMode ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
              <Input
                id="brand"
                value={editedData.brand || ''}
                onChange={(e) => handleInputChange('brand', e.target.value)}
                placeholder="Card Brand"
              />
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

            {/* Fourth row - Variant and Serial Number (if present) */}
            {(data.variant || data.serialNumber) && (
              <>
                {data.variant && (
                  <div className="space-y-2">
                    <Label htmlFor="variant">Variant</Label>
                    <Input
                      id="variant"
                      value={editedData.variant || ''}
                      onChange={(e) => handleInputChange('variant', e.target.value)}
                      placeholder="Card Variant"
                    />
                  </div>
                )}
                {data.serialNumber && (
                  <div className="space-y-2">
                    <Label htmlFor="serialNumber">Serial Number</Label>
                    <Input
                      id="serialNumber"
                      value={editedData.serialNumber || ''}
                      onChange={(e) => handleInputChange('serialNumber', e.target.value)}
                      placeholder="Serial Number"
                    />
                  </div>
                )}
              </>
            )}

            {/* Fifth row - Condition */}
            <div className="space-y-2">
              <Label htmlFor="condition">Condition</Label>
              <Input
                id="condition"
                value={editedData.condition || ''}
                onChange={(e) => handleInputChange('condition', e.target.value)}
                placeholder="Card Condition"
              />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {data.sport && (
              <div className="col-span-2">
                <span className="font-medium">Sport:</span> {data.sport}
              </div>
            )}
            
            {(data.playerFirstName || data.playerLastName) && (
              <div className="col-span-2">
                <span className="font-medium">Player:</span> {data.playerFirstName} {data.playerLastName}
              </div>
            )}
            
            {data.brand && (
              <div>
                <span className="font-medium">Brand:</span> {data.brand}
              </div>
            )}
            
            {data.collection && (
              <div>
                <span className="font-medium">Collection:</span> {data.collection}
              </div>
            )}
            
            {data.cardNumber && (
              <div>
                <span className="font-medium">Card #:</span> {data.cardNumber}
              </div>
            )}
            
            {data.year && data.year > 0 && (
              <div>
                <span className="font-medium">Year:</span> {data.year}
              </div>
            )}
            
            {data.variant && (
              <div>
                <span className="font-medium">Variant:</span> {data.variant}
              </div>
            )}
            
            {data.serialNumber && (
              <div>
                <span className="font-medium">Serial #:</span> {data.serialNumber}
              </div>
            )}
            
            {data.condition && (
              <div>
                <span className="font-medium">Condition:</span> {data.condition}
              </div>
            )}
          </div>
        )}
      </CardContent>
      <CardFooter className="flex justify-between">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onApply(editMode ? editedData : data)}>
          Apply These Details
        </Button>
      </CardFooter>
    </Card>
  );
}