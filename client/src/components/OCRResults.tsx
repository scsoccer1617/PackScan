import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Loader2, AlertCircle, Check, Pencil, ThumbsUp, ThumbsDown } from 'lucide-react';
import { CardFormValues } from "@shared/schema";
import { UseFormReturn } from "react-hook-form";
import { apiRequest } from "@/lib/queryClient";
import VariantCombobox from "@/components/VariantCombobox";
import FoilTypeSelect from "@/components/FoilTypeSelect";

interface OCRResultsProps {
  loading: boolean;
  error: string | null;
  data: Partial<CardFormValues> | null;
  onApply: (data: Partial<CardFormValues>) => void;
  onCancel: () => void;
  form?: UseFormReturn<CardFormValues>;
}

export default function OCRResults({ loading, error, data: initialData, onApply, onCancel, form }: OCRResultsProps) {
  const [editMode, setEditMode] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState<'idle' | 'confirming' | 'confirmed' | 'error'>('idle');
  // Use state to manage our working copy of data that we can directly modify
  const [data, setData] = useState<Partial<CardFormValues>>({});
  const [editedData, setEditedData] = useState<Partial<CardFormValues>>({});
  // DB-driven dropdown options for the Collection + Set fields, scoped by
  // the currently-edited Brand + Year (and Collection for Set).
  const [collectionOptions, setCollectionOptions] = useState<string[]>([]);
  const [setOptions, setSetOptions] = useState<string[]>([]);

  useEffect(() => {
    if (!editMode || !editedData.brand || !editedData.year) {
      setCollectionOptions([]);
      return;
    }
    const params = new URLSearchParams({
      brand: String(editedData.brand),
      year: String(editedData.year),
    });
    if (editedData.playerLastName) params.set('playerLastName', String(editedData.playerLastName));
    fetch(`/api/card-database/collections?${params.toString()}`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setCollectionOptions(d); })
      .catch(() => setCollectionOptions([]));
  }, [editMode, editedData.brand, editedData.year, editedData.playerLastName]);

  useEffect(() => {
    if (!editMode || !editedData.brand || !editedData.year) {
      setSetOptions([]);
      return;
    }
    const params = new URLSearchParams({
      brand: String(editedData.brand),
      year: String(editedData.year),
    });
    if (editedData.collection) params.set('collection', String(editedData.collection));
    if (editedData.playerLastName) params.set('playerLastName', String(editedData.playerLastName));
    fetch(`/api/card-database/sets?${params.toString()}`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setSetOptions(d); })
      .catch(() => setSetOptions([]));
  }, [editMode, editedData.brand, editedData.year, editedData.collection, editedData.playerLastName]);
  
  // Debug log to check if isRookieCard is properly set
  useEffect(() => {
    if (data) {
      console.log("OCR Results rookie card status:", data.isRookieCard);
    }
  }, [data]);

  // When initial OCR data changes, update our local state
  useEffect(() => {
    if (initialData) {
      setData(initialData);
      setEditedData(initialData);
      setConfirmStatus('idle');
    }
  }, [initialData]);

  // Handle input changes
  const handleInputChange = (field: keyof CardFormValues, value: string | number | boolean) => {
    setEditedData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleConfirmCard = async () => {
    if (!data || confirmStatus === 'confirming' || confirmStatus === 'confirmed') return;
    setConfirmStatus('confirming');
    try {
      await apiRequest('/api/confirmed-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sport: data.sport,
          playerFirstName: data.playerFirstName,
          playerLastName: data.playerLastName,
          brand: data.brand,
          collection: data.collection || '',
          cardNumber: data.cardNumber,
          year: data.year,
          variant: data.variant || '',
          serialNumber: data.serialNumber || '',
          isRookieCard: data.isRookieCard || false,
          isAutographed: data.isAutographed || false,
          isNumbered: data.isNumbered || false,
          isFoil: data.isFoil || false,
          foilType: data.foilType || null,
        }),
      });
      setConfirmStatus('confirmed');
    } catch (err) {
      console.error('Error confirming card:', err);
      setConfirmStatus('error');
      setTimeout(() => setConfirmStatus('idle'), 3000);
    }
  };

  const handleRejectCard = () => {
    setEditMode(true);
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
  
  // Function to apply OCR data and maintain OCR results display
  const applyAndUseDirectly = async () => {
    if (form) {
      // Apply all fields from edited data to the form
      const dataToApply = editMode ? editedData : data;
      Object.entries(dataToApply).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          form.setValue(key as any, value);
        }
      });
      
      // Immediately submit the form to save changes to the database
      console.log("Automatically submitting form to save OCR results to database...");
      try {
        // Programmatically trigger form submission
        await form.handleSubmit((values) => {
          console.log("Form submitted with values:", values);
        })();
        
        console.log("OCR form data successfully saved to database");
      } catch (error) {
        console.error("Error saving OCR results to database:", error);
      }
      
      // Update the data state with the edited data to show updated values
      setData(editedData);
      // Exit edit mode but keep OCR results visible
      setEditMode(false);
    } else {
      // If no form is provided, just call the regular onApply
      onApply(editMode ? editedData : data);
    }
  };
  
  // Handle edit mode toggle without closing the OCR results
  const toggleEditMode = () => {
    setEditMode(!editMode);
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
          // Field order (per UX preference):
          //   Sport · First Name · Last Name · Year · Brand · Card # ·
          //   Set · Collection · Parallel · Serial # · Variant · Rookie Card
          // Most fields are full-width so Set is unambiguously ABOVE Collection
          // (and similarly Parallel above Serial #). First/Last Name and the
          // remaining Autographed/Numbered/Condition/Notes fields are kept
          // grouped where they were previously since the user didn't call them
          // out in the new ordering.
          <div className="form-grid">
            {/* Sport */}
            <div className="space-y-2 col-span-1 md:col-span-2">
              <Label htmlFor="sport">Sport</Label>
              <Select
                value={editedData.sport || ''}
                onValueChange={(value) => handleInputChange('sport', value)}
              >
                <SelectTrigger id="sport">
                  <SelectValue placeholder="Select sport">
                    {editedData.sport || 'Select sport'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {["Baseball", "Football", "Basketball", "Hockey", "Soccer", "Other"].map((sport) => (
                    <SelectItem key={sport} value={sport}>{sport}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* First Name + Last Name */}
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

            {/* Year */}
            <div className="space-y-2 col-span-1 md:col-span-2">
              <Label htmlFor="year">Year</Label>
              <Input
                id="year"
                type="number"
                value={editedData.year || ''}
                onChange={(e) => handleInputChange('year', parseInt(e.target.value) || '')}
                placeholder="Card Year"
              />
            </div>

            {/* Brand */}
            <div className="space-y-2 col-span-1 md:col-span-2">
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

            {/* Card Number */}
            <div className="space-y-2 col-span-1 md:col-span-2">
              <Label htmlFor="cardNumber">Card Number</Label>
              <Input
                id="cardNumber"
                value={editedData.cardNumber || ''}
                onChange={(e) => handleInputChange('cardNumber', e.target.value)}
                placeholder="Card Number"
              />
            </div>

            {/* Set — DB-driven, filtered by Brand + Year */}
            <div className="space-y-2 col-span-1 md:col-span-2">
              <Label htmlFor="set">Set</Label>
              {setOptions.length > 0 ? (
                <Select
                  value={editedData.set || ''}
                  onValueChange={(v) => handleInputChange('set', v)}
                >
                  <SelectTrigger id="set">
                    <SelectValue placeholder="Select set" />
                  </SelectTrigger>
                  <SelectContent>
                    {setOptions.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="set"
                  value={editedData.set || ''}
                  onChange={(e) => handleInputChange('set', e.target.value)}
                  placeholder={editedData.brand && editedData.year ? "No matches — type a set" : "Pick brand & year first"}
                />
              )}
            </div>

            {/* Collection — DB-driven */}
            <div className="space-y-2 col-span-1 md:col-span-2">
              <Label htmlFor="collection">Collection</Label>
              {collectionOptions.length > 0 ? (
                <Select
                  value={editedData.collection || ''}
                  onValueChange={(v) => handleInputChange('collection', v)}
                >
                  <SelectTrigger id="collection">
                    <SelectValue placeholder="Select collection" />
                  </SelectTrigger>
                  <SelectContent>
                    {collectionOptions.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="collection"
                  value={editedData.collection || ''}
                  onChange={(e) => handleInputChange('collection', e.target.value)}
                  placeholder={editedData.brand && editedData.year ? "No matches — type a collection" : "Pick brand & year first"}
                />
              )}
            </div>

            {/* Parallel — only shows parallels matching the card's
                serial-status (defaults to non-serialized when not numbered) */}
            <div className="space-y-2 col-span-1 md:col-span-2">
              <Label>Parallel</Label>
              <FoilTypeSelect
                brand={editedData.brand}
                year={editedData.year}
                collection={editedData.collection}
                set={editedData.set}
                value={editedData.foilType || ''}
                isNumbered={!!editedData.isNumbered}
                onChange={(foilType) => {
                  handleInputChange('foilType', foilType);
                  handleInputChange('isFoil', !!foilType);
                }}
              />
            </div>

            {/* Serial Number */}
            <div className="space-y-2 col-span-1 md:col-span-2">
              <Label htmlFor="serialNumber">Serial Number</Label>
              <Input
                id="serialNumber"
                value={editedData.serialNumber || ''}
                onChange={(e) => handleInputChange('serialNumber', e.target.value)}
                placeholder="Serial Number (if any)"
              />
            </div>

            {/* Variant — free-text only (e.g. SSP, Image Variation, Photo Variation) */}
            <div className="space-y-2 col-span-1 md:col-span-2">
              <Label htmlFor="variant">Variant</Label>
              <Input
                id="variant"
                value={editedData.variant || ''}
                onChange={(e) => handleInputChange('variant', e.target.value)}
                placeholder="e.g. SSP, Photo Variation"
              />
            </div>

            {/* Condition */}
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
          <div className="space-y-6">
            <div className="space-y-3">
              <div className="text-lg">
                <span className="font-semibold text-slate-800">Sport: </span>
                <span className="text-slate-700">{data.sport || 'Not detected'}</span>
              </div>
              <div className="text-lg">
                <span className="font-semibold text-slate-800">Player: </span>
                <span className="text-slate-700">{data.playerFirstName || ''} {data.playerLastName || 'Not detected'}</span>
              </div>
              <div className="text-lg">
                <span className="font-semibold text-slate-800">Year: </span>
                <span className="text-slate-700">{data.year && data.year > 0 ? data.year : 'Not detected'}</span>
              </div>
              <div className="text-lg">
                <span className="font-semibold text-slate-800">Brand: </span>
                <span className="text-slate-700">{data.brand || 'Not detected'}</span>
              </div>
              <div className="text-lg">
                <span className="font-semibold text-slate-800">Card #: </span>
                <span className="text-slate-700">{data.cardNumber || 'Not detected'}</span>
              </div>
              {data.cmpNumber && (
                <div className="text-lg">
                  <span className="font-semibold text-slate-800">CMP Code: </span>
                  <span className="text-slate-700">{data.cmpNumber}</span>
                </div>
              )}
              <hr className="border-t border-slate-200 my-2" />
              <div className="text-lg">
                <span className="font-semibold text-slate-800">Set: </span>
                <span className="text-slate-700">{data.set || 'Not detected'}</span>
              </div>
              <div className="text-lg">
                <span className="font-semibold text-slate-800">Collection: </span>
                <span className="text-slate-700">{data.collection || 'Not detected'}</span>
              </div>
              <div className="text-lg">
                <span className="font-semibold text-slate-800">Parallel: </span>
                <span className="text-slate-700">{data.foilType || 'None detected'}</span>
              </div>
              <div className="text-lg">
                <span className="font-semibold text-slate-800">Serial #: </span>
                <span className="text-slate-700">{data.serialNumber || 'None'}</span>
              </div>
              <div className="text-lg">
                <span className="font-semibold text-slate-800">Variant: </span>
                <span className="text-slate-700">{data.variant || 'Not detected'}</span>
              </div>
              <div className="text-lg">
                <span className="font-semibold text-slate-800">Rookie Card: </span>
                <span className="text-slate-700">{data.isRookieCard ? 'Yes' : 'No'}</span>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-end gap-2 mt-4">
                {confirmStatus === 'confirmed' ? (
                  <span className="text-sm text-green-600 font-medium flex items-center gap-1">
                    <Check className="h-4 w-4" /> Confirmed
                  </span>
                ) : confirmStatus === 'error' ? (
                  <span className="text-sm text-red-500">Error saving</span>
                ) : (
                  <>
                    <span className="text-sm text-slate-600 font-medium">Correct info?</span>
                    <button
                      type="button"
                      onClick={handleConfirmCard}
                      disabled={confirmStatus === 'confirming'}
                      className="p-1.5 rounded-full hover:bg-green-50 transition-colors disabled:opacity-50"
                      title="Yes, this is correct"
                    >
                      <ThumbsUp className={`h-5 w-5 ${confirmStatus === 'confirming' ? 'text-gray-400' : 'text-green-600 hover:text-green-700'}`} />
                    </button>
                    <button
                      type="button"
                      onClick={handleRejectCard}
                      className="p-1.5 rounded-full hover:bg-red-50 transition-colors"
                      title="No, let me fix it"
                    >
                      <ThumbsDown className="h-5 w-5 text-red-500 hover:text-red-600" />
                    </button>
                  </>
                )}
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
        {!editMode ? (
          <Button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleEditMode();
            }}
            className="bg-blue-600 hover:bg-blue-500 text-white"
          >
            Edit Card Details
          </Button>
        ) : (
          <Button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // Apply changes to the form and proceed with saving
              // This will use our edited data and apply it to the form
              applyAndUseDirectly();
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