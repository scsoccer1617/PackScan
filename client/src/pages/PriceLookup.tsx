import { useState } from "react";
import SimpleImageUploader from "@/components/SimpleImageUploader";
import { Button } from "@/components/ui/button";
import { ScanSearch, ThumbsUp, ThumbsDown, Check, Loader2, Database, Pencil } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import EbayPriceResults from "@/components/EbayPriceResults";
import { CardFormValues } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";

export default function PriceLookup() {
  const [frontImage, setFrontImage] = useState<string>("");
  const [backImage, setBackImage] = useState<string>("");
  const [cardData, setCardData] = useState<Partial<CardFormValues> & { confirmedSource?: boolean } | null>(null);
  const [editedData, setEditedData] = useState<Partial<CardFormValues>>({});
  const [editMode, setEditMode] = useState(false);
  const [showPriceResults, setShowPriceResults] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [confirmSaving, setConfirmSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const { toast } = useToast();

  const handleAnalyzeRequest = async () => {
    if (!backImage) {
      toast({
        title: "Back Image Required",
        description: "Please upload the BACK of the card for detailed card information.",
        variant: "destructive",
      });
      return;
    }

    setAnalyzing(true);
    setConfirmed(false);
    setEditMode(false);
    setShowPriceResults(false);
    try {
      const response = await fetch('/api/analyze-card-dual-images', {
        method: 'POST',
        body: (() => {
          const formData = new FormData();

          const backByteCharacters = atob(backImage.split(',')[1]);
          const backByteNumbers = new Array(backByteCharacters.length);
          for (let i = 0; i < backByteCharacters.length; i++) {
            backByteNumbers[i] = backByteCharacters.charCodeAt(i);
          }
          const backByteArray = new Uint8Array(backByteNumbers);
          const backBlob = new Blob([backByteArray], { type: 'image/jpeg' });
          formData.append('backImage', backBlob, 'back.jpg');

          if (frontImage) {
            const frontByteCharacters = atob(frontImage.split(',')[1]);
            const frontByteNumbers = new Array(frontByteCharacters.length);
            for (let i = 0; i < frontByteCharacters.length; i++) {
              frontByteNumbers[i] = frontByteCharacters.charCodeAt(i);
            }
            const frontByteArray = new Uint8Array(frontByteNumbers);
            const frontBlob = new Blob([frontByteArray], { type: 'image/jpeg' });
            formData.append('frontImage', frontBlob, 'front.jpg');
          }

          return formData;
        })()
      });

      if (!response.ok) {
        throw new Error('Analysis failed');
      }

      const result = await response.json();

      if (result.success && result.data) {
        setCardData(result.data);
        setEditedData(result.data);
      } else {
        throw new Error(result.message || 'Analysis failed');
      }
    } catch (error) {
      console.error('Analysis error:', error);
      toast({
        title: "Analysis Failed",
        description: "Could not analyze the card image. Please try again.",
        variant: "destructive",
      });
    } finally {
      setAnalyzing(false);
    }
  };

  const handleInputChange = (field: keyof CardFormValues, value: string | number | boolean) => {
    setEditedData(prev => ({ ...prev, [field]: value }));
  };

  const handleConfirmCard = async () => {
    setConfirmSaving(true);
    try {
      const dataToConfirm = editMode ? editedData : cardData;
      await apiRequest({
        url: '/api/confirmed-cards',
        method: 'POST',
        body: {
          sport: dataToConfirm?.sport || 'Baseball',
          playerFirstName: dataToConfirm?.playerFirstName,
          playerLastName: dataToConfirm?.playerLastName,
          brand: dataToConfirm?.brand,
          collection: dataToConfirm?.collection || '',
          cardNumber: dataToConfirm?.cardNumber,
          year: dataToConfirm?.year,
          variant: dataToConfirm?.variant || '',
          serialNumber: dataToConfirm?.serialNumber || '',
          isRookieCard: dataToConfirm?.isRookieCard || false,
          isAutographed: dataToConfirm?.isAutographed || false,
          isNumbered: dataToConfirm?.isNumbered || false,
        },
      });
      setConfirmed(true);
      if (editMode) {
        setCardData(editedData);
        setEditMode(false);
      }
      toast({
        title: "Card Confirmed",
        description: "This card's info has been saved for future lookups.",
      });
      const finalData = editMode ? editedData : cardData;
      setCardData(finalData as any);
      setShowPriceResults(true);
      toast({
        title: "Searching eBay",
        description: "Looking up recent sold prices...",
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

  const handleSaveEditsAndSearch = () => {
    setCardData(editedData as any);
    setEditMode(false);
    setShowPriceResults(true);
    toast({
      title: "Searching eBay",
      description: "Looking up recent sold prices with updated info...",
    });
  };

  const handleReset = () => {
    setFrontImage("");
    setBackImage("");
    setCardData(null);
    setEditedData({});
    setEditMode(false);
    setShowPriceResults(false);
    setConfirmed(false);
  };

  const displayData = editMode ? editedData : cardData;

  return (
    <div className="p-4 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScanSearch className="h-5 w-5" />
            Upload Card Images
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <h3 className="font-medium mb-2 text-sm">Front of Card</h3>
              <SimpleImageUploader
                onImageCaptured={setFrontImage}
                label="Upload front"
                existingImage={frontImage}
              />
            </div>
            <div>
              <h3 className="font-medium mb-2 text-sm">Back of Card</h3>
              <SimpleImageUploader
                onImageCaptured={setBackImage}
                label="Upload back"
                existingImage={backImage}
              />
            </div>
          </div>

          {!cardData && !analyzing && (
            <Button
              onClick={handleAnalyzeRequest}
              disabled={analyzing || !backImage}
              className="w-full"
              size="lg"
            >
              <ScanSearch className="h-4 w-4 mr-2" />
              Analyze Card & Get Prices
            </Button>
          )}

          {analyzing && (
            <div className="flex items-center justify-center py-4 text-slate-500">
              <Loader2 className="h-5 w-5 mr-2 animate-spin" />
              Analyzing card image...
            </div>
          )}
        </CardContent>
      </Card>

      {cardData && !showPriceResults && !analyzing && (
        <Card>
          <CardContent className="pt-6">
            {!editMode ? (
              <div className="space-y-3">
                {cardData.confirmedSource && (
                  <div className="flex items-center gap-1 text-sm text-blue-600 mb-2">
                    <Database className="h-4 w-4" />
                    <span>Matched from confirmed database</span>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <span className="font-semibold text-slate-600">Player: </span>
                    <span>{cardData.playerFirstName || ''} {cardData.playerLastName || 'Not detected'}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-slate-600">Sport: </span>
                    <span>{cardData.sport || 'Not detected'}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-slate-600">Brand: </span>
                    <span>{cardData.brand || 'Not detected'}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-slate-600">Collection: </span>
                    <span>{cardData.collection || 'Not detected'}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-slate-600">Card #: </span>
                    <span>{cardData.cardNumber || 'Not detected'}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-slate-600">Year: </span>
                    <span>{cardData.year && cardData.year > 0 ? cardData.year : 'Not detected'}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-slate-600">Variant: </span>
                    <span>{cardData.variant || 'None'}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-slate-600">Serial #: </span>
                    <span>{cardData.serialNumber || 'None'}</span>
                  </div>
                </div>
                {(cardData.isRookieCard || cardData.isAutographed || cardData.isNumbered) && (
                  <div className="flex flex-wrap gap-2 mt-1">
                    {cardData.isRookieCard && (
                      <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">Rookie</span>
                    )}
                    {cardData.isAutographed && (
                      <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">Auto</span>
                    )}
                    {cardData.isNumbered && (
                      <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">Numbered</span>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between pt-3 border-t mt-3">
                  <span className="text-sm font-medium text-slate-700">Correct info?</span>
                  {confirmed ? (
                    <span className="inline-flex items-center text-green-600 text-sm font-medium">
                      <Check className="h-4 w-4 mr-1" />
                      Confirmed
                    </span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditMode(true);
                          setEditedData(cardData);
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium text-red-600 hover:bg-red-50 border border-red-200 transition-colors"
                      >
                        <ThumbsDown className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        disabled={confirmSaving}
                        onClick={handleConfirmCard}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium text-green-600 hover:bg-green-50 border border-green-200 transition-colors"
                      >
                        {confirmSaving ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <ThumbsUp className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 mb-2">
                  <Pencil className="h-4 w-4 text-slate-500" />
                  <span className="text-sm font-medium text-slate-700">Edit card details</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="playerFirstName" className="text-xs">First Name</Label>
                    <Input
                      id="playerFirstName"
                      value={editedData.playerFirstName || ''}
                      onChange={(e) => handleInputChange('playerFirstName', e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="playerLastName" className="text-xs">Last Name</Label>
                    <Input
                      id="playerLastName"
                      value={editedData.playerLastName || ''}
                      onChange={(e) => handleInputChange('playerLastName', e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="sport" className="text-xs">Sport</Label>
                    <Select
                      value={editedData.sport || 'Baseball'}
                      onValueChange={(value) => handleInputChange('sport', value)}
                    >
                      <SelectTrigger id="sport" className="h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["Baseball", "Football", "Basketball", "Hockey", "Soccer", "Other"].map((s) => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="brand" className="text-xs">Brand</Label>
                    <Select
                      value={editedData.brand || ''}
                      onValueChange={(value) => handleInputChange('brand', value)}
                    >
                      <SelectTrigger id="brand" className="h-8 text-sm">
                        <SelectValue placeholder="Select brand" />
                      </SelectTrigger>
                      <SelectContent>
                        {["Topps", "Panini", "Upper Deck", "Bowman", "Fleer", "Donruss", "Score", "Other"].map((b) => (
                          <SelectItem key={b} value={b}>{b}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="collection" className="text-xs">Collection</Label>
                    <Input
                      id="collection"
                      value={editedData.collection || ''}
                      onChange={(e) => handleInputChange('collection', e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cardNumber" className="text-xs">Card #</Label>
                    <Input
                      id="cardNumber"
                      value={editedData.cardNumber || ''}
                      onChange={(e) => handleInputChange('cardNumber', e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="year" className="text-xs">Year</Label>
                    <Input
                      id="year"
                      type="number"
                      value={editedData.year || ''}
                      onChange={(e) => handleInputChange('year', parseInt(e.target.value) || '')}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="variant" className="text-xs">Variant</Label>
                    <Input
                      id="variant"
                      value={editedData.variant || ''}
                      onChange={(e) => handleInputChange('variant', e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="serialNumber" className="text-xs">Serial #</Label>
                    <Input
                      id="serialNumber"
                      value={editedData.serialNumber || ''}
                      onChange={(e) => handleInputChange('serialNumber', e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-4 mt-2">
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={editedData.isRookieCard === true}
                      onChange={(e) => handleInputChange('isRookieCard', e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-gray-300"
                    />
                    Rookie
                  </label>
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={editedData.isAutographed === true}
                      onChange={(e) => handleInputChange('isAutographed', e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-gray-300"
                    />
                    Auto
                  </label>
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={editedData.isNumbered === true}
                      onChange={(e) => handleInputChange('isNumbered', e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-gray-300"
                    />
                    Numbered
                  </label>
                </div>

                <div className="flex items-center justify-between pt-3 border-t mt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditMode(false)}
                  >
                    Cancel
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handleSaveEditsAndSearch}
                    >
                      Search eBay
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={confirmSaving}
                      onClick={handleConfirmCard}
                      className="bg-green-600 hover:bg-green-500 text-white"
                    >
                      {confirmSaving ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4 mr-1" />
                      )}
                      Save & Search
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {showPriceResults && cardData && (
        <div className="space-y-4">
          <EbayPriceResults
            cardData={cardData}
            frontImage={frontImage}
            backImage={backImage}
            onCardDataUpdate={(updatedData) => {
              setCardData(updatedData);
            }}
          />
          <Button
            onClick={handleReset}
            variant="outline"
            className="w-full"
          >
            Look Up Another Card
          </Button>
        </div>
      )}
    </div>
  );
}
