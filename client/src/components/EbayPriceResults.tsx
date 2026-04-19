import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExternalLink, TrendingUp, Pencil, RotateCcw, ThumbsUp, ThumbsDown, Check } from "lucide-react";
import { CardFormValues } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import VariantCombobox from "@/components/VariantCombobox";
import FoilTypeSelect from "@/components/FoilTypeSelect";
import AddToSheetButton from "@/components/AddToSheetButton";

interface EbaySearchResult {
  title: string;
  price: number;
  currency: string;
  url: string;
  imageUrl: string;
  condition: string;
  endTime: string;
}

interface EbayResponse {
  averageValue: number;
  results: EbaySearchResult[];
  searchUrl?: string;
  errorMessage?: string;
  dataType?: 'sold' | 'current';
}

interface EbayPriceResultsProps {
  cardData: Partial<CardFormValues>;
  frontImage?: string;
  backImage?: string;
  onCardDataUpdate?: (updatedData: Partial<CardFormValues>) => void;
}

export default function EbayPriceResults({ cardData, frontImage, backImage, onCardDataUpdate }: EbayPriceResultsProps) {
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<EbaySearchResult[]>([]);
  const [averageValue, setAverageValue] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [searchUrl, setSearchUrl] = useState<string | null>(null);
  const [dataType, setDataType] = useState<'sold' | 'current'>('sold');
  const [editMode, setEditMode] = useState(false);
  const [editData, setEditData] = useState<Partial<CardFormValues>>({});
  const [confirmStatus, setConfirmStatus] = useState<'idle' | 'confirming' | 'confirmed' | 'error'>('idle');
  // DB-driven dropdown options for Collection + Set, scoped by edited Brand+Year
  // (Set additionally narrows by Collection). Falls back to free-text when empty.
  const [collectionOptions, setCollectionOptions] = useState<string[]>([]);
  const [setOptions, setSetOptions] = useState<string[]>([]);
  const cardInfoRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollAfterRelookup = useRef(false);

  useEffect(() => {
    if (!editMode || !editData.brand || !editData.year) {
      setCollectionOptions([]);
      return;
    }
    const params = new URLSearchParams({
      brand: String(editData.brand),
      year: String(editData.year),
    });
    // Narrow Collection options to those that exist within the chosen Set,
    // so the dropdown only shows collections actually associated with it.
    if (editData.set) params.set('set', String(editData.set));
    if (editData.playerLastName) params.set('playerLastName', String(editData.playerLastName));
    fetch(`/api/card-database/collections?${params.toString()}`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setCollectionOptions(d); })
      .catch(() => setCollectionOptions([]));
  }, [editMode, editData.brand, editData.year, editData.set, editData.playerLastName]);

  useEffect(() => {
    if (!editMode || !editData.brand || !editData.year) {
      setSetOptions([]);
      return;
    }
    const params = new URLSearchParams({
      brand: String(editData.brand),
      year: String(editData.year),
    });
    if (editData.collection) params.set('collection', String(editData.collection));
    if (editData.playerLastName) params.set('playerLastName', String(editData.playerLastName));
    fetch(`/api/card-database/sets?${params.toString()}`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setSetOptions(d); })
      .catch(() => setSetOptions([]));
  }, [editMode, editData.brand, editData.year, editData.collection, editData.playerLastName]);

  const handleConfirmCard = async () => {
    if (!cardData || confirmStatus === 'confirming' || confirmStatus === 'confirmed') return;
    setConfirmStatus('confirming');
    try {
      await apiRequest('/api/confirmed-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sport: cardData.sport,
          playerFirstName: cardData.playerFirstName,
          playerLastName: cardData.playerLastName,
          brand: cardData.brand,
          collection: cardData.collection || '',
          cardNumber: cardData.cardNumber,
          year: cardData.year,
          variant: cardData.variant || '',
          serialNumber: cardData.serialNumber || '',
          isRookieCard: cardData.isRookieCard || false,
          isAutographed: cardData.isAutographed || false,
          isNumbered: cardData.isNumbered || false,
          isFoil: cardData.isFoil || false,
          foilType: cardData.foilType || null,
        }),
      });
      setConfirmStatus('confirmed');
    } catch (err) {
      console.error('Error confirming card:', err);
      setConfirmStatus('error');
      setTimeout(() => setConfirmStatus('idle'), 3000);
    }
  };

  useEffect(() => {
    const fetchEbayData = async () => {
      setLoading(true);
      setError(null);
      setResults([]);
      setAverageValue(0);
      setSearchUrl(null);
      
      const hasEnoughForSearch = (cardData.brand && (cardData.year ?? 0) > 0) ||
        (cardData.playerFirstName && cardData.playerLastName);
      if (!hasEnoughForSearch) {
        setError("Missing required card information for price lookup");
        setLoading(false);
        return;
      }

      try {
        const playerName = cardData.playerFirstName && cardData.playerLastName
          ? `${cardData.playerFirstName} ${cardData.playerLastName}`
          : (cardData.playerLastName || cardData.playerFirstName || '');
        const searchParams = new URLSearchParams({
          playerName,
          cardNumber: cardData.cardNumber || "",
          brand: cardData.brand || "",
          year: (cardData.year ?? 0).toString(),
          collection: cardData.collection || "",
          set: (cardData as any).set || "",
          condition: cardData.condition || "",
          isNumbered: cardData.isNumbered ? "true" : "false",
          foilType: cardData.foilType || "",
          serialNumber: cardData.serialNumber || "",
          variant: cardData.variant || "",
          isAutographed: cardData.isAutographed ? "true" : "false"
        });

        const response = await fetch(`/api/ebay-search?${searchParams}`);
        if (!response.ok) {
          throw new Error("Failed to fetch eBay data");
        }

        const data: EbayResponse = await response.json();
        setResults(data.results.slice(0, 5));
        setAverageValue(data.averageValue);
        setSearchUrl(data.searchUrl || null);
        setDataType(data.dataType || 'sold');
        if (data.errorMessage) {
          setError(data.errorMessage);
        }
        setLoading(false);
      } catch (err) {
        setError("Failed to fetch eBay prices. Please try again.");
        setLoading(false);
      }
    };

    fetchEbayData();
  }, [cardData]);

  // NOTE: This effect must live above the `if (loading) return …` early
  // return below — React requires hooks to be called in the same order on
  // every render, and adding a hook after an early return causes a
  // "Rendered more hooks than during the previous render" crash when
  // loading flips from true → false.
  useEffect(() => {
    if (shouldScrollAfterRelookup.current && cardInfoRef.current) {
      shouldScrollAfterRelookup.current = false;
      cardInfoRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [cardData]);

  const formatPrice = (price: number, currency: string = 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
    }).format(price);
  };

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    } catch {
      return 'N/A';
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Finding Sold Listings...
          </CardTitle>
          <p className="text-sm text-gray-600">
            Searching eBay sold listings for recent sale prices
          </p>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center space-x-4 animate-pulse">
                <div className="w-16 h-20 bg-gray-200 rounded"></div>
                <div className="flex-1">
                  <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
                  <div className="h-3 bg-gray-200 rounded w-1/2"></div>
                </div>
                <div className="text-right">
                  <div className="h-5 bg-gray-200 rounded w-16 mb-1"></div>
                  <div className="h-3 bg-gray-200 rounded w-12"></div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const handleStartEdit = () => {
    setEditData({ ...cardData });
    setEditMode(true);
  };

  const handleCancelEdit = () => {
    setEditMode(false);
    setEditData({});
  };

  const handleSaveAndRelookup = () => {
    if (!editData.playerFirstName?.trim() || !editData.playerLastName?.trim() || !editData.brand?.trim() || !editData.year) {
      return;
    }
    setEditMode(false);
    shouldScrollAfterRelookup.current = true;
    if (onCardDataUpdate) {
      onCardDataUpdate({ ...editData });
    }
  };

  const updateEditField = (field: keyof CardFormValues, value: any) => {
    setEditData(prev => ({ ...prev, [field]: value }));
  };

  const renderCardInfoSection = () => (
    <div className="space-y-4">
      {(frontImage || backImage) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Uploaded Card Images</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {frontImage && (
                <div className="space-y-2">
                  <h3 className="font-medium text-slate-700">Front of Card</h3>
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <img 
                      src={frontImage} 
                      alt="Front of card" 
                      className="w-full h-auto max-h-96 object-contain bg-gray-50"
                    />
                  </div>
                </div>
              )}
              {backImage && (
                <div className="space-y-2">
                  <h3 className="font-medium text-slate-700">Back of Card</h3>
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <img 
                      src={backImage} 
                      alt="Back of card" 
                      className="w-full h-auto max-h-96 object-contain bg-gray-50"
                    />
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card ref={cardInfoRef}>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle className="text-lg">Card Information</CardTitle>
            {!editMode && (
              <Button variant="outline" size="sm" onClick={handleStartEdit}>
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                Edit & Re-lookup
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {editMode ? (
            // Field order:
            //   Sport · First Name · Last Name · Year · Brand · Card # ·
            //   Set · Collection · Parallel · Serial # · Variant · Rookie Card
            <div className="space-y-3">
              <div>
                <Label htmlFor="edit-sport">Sport</Label>
                <Input id="edit-sport" value={editData.sport || ''} onChange={e => updateEditField('sport', e.target.value)} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="edit-firstName">First Name</Label>
                  <Input id="edit-firstName" value={editData.playerFirstName || ''} onChange={e => updateEditField('playerFirstName', e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="edit-lastName">Last Name</Label>
                  <Input id="edit-lastName" value={editData.playerLastName || ''} onChange={e => updateEditField('playerLastName', e.target.value)} />
                </div>
              </div>
              <div>
                <Label htmlFor="edit-year">Year</Label>
                <Input id="edit-year" type="number" value={editData.year || ''} onChange={e => updateEditField('year', parseInt(e.target.value) || 0)} />
              </div>
              <div>
                <Label htmlFor="edit-brand">Brand</Label>
                <Input id="edit-brand" value={editData.brand || ''} onChange={e => updateEditField('brand', e.target.value)} />
              </div>
              <div>
                <Label htmlFor="edit-cardNumber">Card #</Label>
                <Input id="edit-cardNumber" value={editData.cardNumber || ''} onChange={e => updateEditField('cardNumber', e.target.value)} />
              </div>
              <div>
                <Label htmlFor="edit-set">Set</Label>
                {setOptions.length > 0 ? (
                  <Select
                    value={editData.set || ''}
                    onValueChange={(v) => updateEditField('set', v)}
                  >
                    <SelectTrigger id="edit-set">
                      <SelectValue placeholder="Select set" />
                    </SelectTrigger>
                    <SelectContent>
                      {setOptions.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input id="edit-set" value={editData.set || ''} onChange={e => updateEditField('set', e.target.value)} />
                )}
              </div>
              <div>
                <Label htmlFor="edit-collection">Collection</Label>
                {collectionOptions.length > 0 ? (
                  <Select
                    value={editData.collection || ''}
                    onValueChange={(v) => updateEditField('collection', v)}
                  >
                    <SelectTrigger id="edit-collection">
                      <SelectValue placeholder="Select collection" />
                    </SelectTrigger>
                    <SelectContent>
                      {collectionOptions.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input id="edit-collection" value={editData.collection || ''} onChange={e => updateEditField('collection', e.target.value)} />
                )}
              </div>
              <div>
                <Label>Parallel</Label>
                <FoilTypeSelect
                  brand={editData.brand}
                  year={editData.year}
                  collection={editData.collection}
                  set={editData.set}
                  value={editData.foilType || ''}
                  isNumbered={!!editData.isNumbered}
                  onChange={(foilType) => {
                    updateEditField('foilType', foilType || null);
                    updateEditField('isFoil', !!foilType);
                  }}
                />
              </div>
              <div>
                <Label htmlFor="edit-serialNumber">Serial #</Label>
                <Input id="edit-serialNumber" value={editData.serialNumber || ''} onChange={e => updateEditField('serialNumber', e.target.value)} />
              </div>
              <div>
                <Label htmlFor="edit-variant">Variant</Label>
                <Input
                  id="edit-variant"
                  value={editData.variant || ''}
                  onChange={e => updateEditField('variant', e.target.value)}
                  placeholder="e.g. SSP, Photo Variation"
                />
              </div>
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="edit-rookieCard"
                  checked={!!editData.isRookieCard}
                  onChange={e => updateEditField('isRookieCard', e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 accent-blue-600"
                />
                <Label htmlFor="edit-rookieCard" className="cursor-pointer">Rookie Card</Label>
              </div>
              <div className="flex justify-end gap-2 pt-3 mt-2 border-t border-slate-100">
                <Button variant="outline" size="sm" onClick={handleCancelEdit}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSaveAndRelookup}>
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                  Re-lookup Prices
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                <div className="text-base">
                  <span className="font-semibold text-slate-800">Sport: </span>
                  <span className="text-slate-700">{cardData.sport || 'Not detected'}</span>
                </div>
                <div className="text-base">
                  <span className="font-semibold text-slate-800">Player: </span>
                  <span className="text-slate-700">{cardData.playerFirstName || ''} {cardData.playerLastName || 'Not detected'}</span>
                </div>
                <div className="text-base">
                  <span className="font-semibold text-slate-800">Year: </span>
                  <span className="text-slate-700">{cardData.year || 'Not detected'}</span>
                </div>
                <div className="text-base">
                  <span className="font-semibold text-slate-800">Brand: </span>
                  <span className="text-slate-700">{cardData.brand || 'Not detected'}</span>
                </div>
                <div className="text-base">
                  <span className="font-semibold text-slate-800">Card #: </span>
                  <span className="text-slate-700">{cardData.cardNumber || 'Not detected'}</span>
                </div>
                {cardData.cmpNumber && (
                  <div className="text-base">
                    <span className="font-semibold text-slate-800">CMP Code: </span>
                    <span className="text-slate-700">{cardData.cmpNumber}</span>
                  </div>
                )}
                <hr className="border-t border-slate-200 my-2" />
                <div className="text-base">
                  <span className="font-semibold text-slate-800">Set: </span>
                  <span className="text-slate-700">{cardData.set || 'Not detected'}</span>
                </div>
                <div className="text-base">
                  <span className="font-semibold text-slate-800">Collection: </span>
                  <span className="text-slate-700">{cardData.collection || 'Not detected'}</span>
                </div>
                <div className="text-base">
                  <span className="font-semibold text-slate-800">Parallel: </span>
                  <span className="text-slate-700">{cardData.foilType || 'None detected'}</span>
                </div>
                <div className="text-base">
                  <span className="font-semibold text-slate-800">Serial #: </span>
                  <span className="text-slate-700">{cardData.serialNumber || 'None'}</span>
                </div>
                <div className="text-base">
                  <span className="font-semibold text-slate-800">Variant: </span>
                  <span className="text-slate-700">{cardData.variant || 'Base/Standard'}</span>
                </div>
                <div className="text-base">
                  <span className="font-semibold text-slate-800">Rookie Card: </span>
                  <span className="text-slate-700">{cardData.isRookieCard ? 'Yes' : 'No'}</span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-slate-100">
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
                      onClick={handleStartEdit}
                      className="p-1.5 rounded-full hover:bg-red-50 transition-colors"
                      title="No, let me fix it"
                    >
                      <ThumbsDown className="h-5 w-5 text-red-500 hover:text-red-600" />
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );

  if (error) {
    const isRateLimit = error.includes('rate limit');
    // "No sold listings found" means the search ran fine but genuinely returned 0 results —
    // show the friendly "No Sold Listings Found" card with a search link.
    // "Unavailable" means the scrape itself failed (blocked, network error, etc.) —
    // show the actual server error message instead so the user knows what happened.
    const isNoResults = !isRateLimit && searchUrl && (
      error.toLowerCase().includes('no active') ||
      error.toLowerCase().includes('no sold') ||
      error.toLowerCase().includes('not found')
    );
    
    if (isNoResults) {
      return (
        <div className="space-y-4">
          {renderCardInfoSection()}
          <Card className="border-slate-200">
            <CardHeader>
              <CardTitle className="text-slate-600 text-base">No Sold Listings Found</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-slate-500 text-sm">
                No recent sold listings were found for this card. It may be a newer release, low-volume card, or spelled differently on eBay.
              </p>
              {searchUrl && (
                <Button
                  onClick={() => window.open(searchUrl, '_blank')}
                  className="flex items-center gap-2"
                  variant="outline"
                >
                  <ExternalLink className="h-4 w-4" />
                  Search eBay Sold Listings
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {renderCardInfoSection()}
        
        <Card className={isRateLimit ? "border-yellow-200 bg-yellow-50" : ""}>
          <CardHeader>
            <CardTitle className={isRateLimit ? "text-yellow-700" : "text-red-600"}>
              {isRateLimit ? "eBay Rate Limit Reached" : "Error Loading Prices"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isRateLimit ? (
              <div className="space-y-3">
                <p className="text-yellow-700">
                  The eBay API has daily usage limits. This will reset within 24 hours.
                </p>
                <p className="text-sm text-yellow-600">
                  When available, this shows up to 5 <strong>recently sold eBay listings</strong> to give you a sense of actual sale prices.
                </p>
              </div>
            ) : (
              <p className="text-gray-600 mb-4">{error}</p>
            )}
            
            {searchUrl && (
              <div className="mt-4">
                <Button 
                  onClick={() => window.open(searchUrl, '_blank')}
                  className="flex items-center gap-2"
                  variant={isRateLimit ? "default" : "secondary"}
                >
                  <ExternalLink className="h-4 w-4" />
                  Browse eBay Sold Listings
                </Button>
                <p className="text-xs text-gray-500 mt-2">
                  Opens eBay with your card details pre-filled
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {renderCardInfoSection()}

      {averageValue > 0 && (
        <Card className="bg-green-50 border-green-200">
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="text-2xl font-bold text-green-800">
                {formatPrice(averageValue)}
              </div>
              <p className="text-green-600">
                {dataType === 'current' ? 'Average Listed Price' : 'Average Sold Price'}
              </p>
              {dataType === 'current' && (
                <p className="text-xs text-amber-600 mt-1">Showing active listings — sold data temporarily unavailable</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <AddToSheetButton
        cardData={cardData}
        averageValue={averageValue}
        searchUrl={searchUrl || undefined}
        frontImage={frontImage}
        backImage={backImage}
      />


      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            {dataType === 'current' ? `Active Listings (${results.length})` : `Recently Sold (${results.length})`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {results.length === 0 ? (
            <div className="text-center py-6 space-y-3">
              <p className="text-gray-600">
                No recent sold listings found — the card may be rare or the search may need refinement.
              </p>
              {searchUrl && (
                <Button
                  onClick={() => window.open(searchUrl, '_blank')}
                  className="flex items-center gap-2 mx-auto"
                >
                  <ExternalLink className="h-4 w-4" />
                  View on eBay →
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {results.map((result, index) => (
                <div key={index} className="flex items-start space-x-4 p-3 border rounded-lg hover:bg-gray-50">
                  {result.imageUrl && (
                    <img
                      src={result.imageUrl}
                      alt="Card listing"
                      className="w-16 h-20 object-cover rounded border"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-sm line-clamp-2 mb-1">
                      {result.title}
                    </h4>
                    {result.condition && (
                      <p className="text-xs text-gray-500 mb-1">
                        Condition: {result.condition}
                      </p>
                    )}
                    {result.endTime && (
                      <p className="text-xs text-gray-400">
                        {dataType === 'current' ? 'Listed' : 'Sold'}: {formatDate(result.endTime)}
                      </p>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="font-bold text-lg text-green-600">
                      {formatPrice(result.price, result.currency)}
                    </div>
                    {result.url && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto p-1 text-xs"
                        onClick={() => window.open(result.url, '_blank')}
                      >
                        <ExternalLink className="h-3 w-3 mr-1" />
                        View
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
