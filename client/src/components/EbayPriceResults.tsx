import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExternalLink, TrendingUp } from "lucide-react";
import { CardFormValues } from "@shared/schema";

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
}

export default function EbayPriceResults({ cardData, frontImage, backImage }: EbayPriceResultsProps) {
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<EbaySearchResult[]>([]);
  const [averageValue, setAverageValue] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [searchUrl, setSearchUrl] = useState<string | null>(null);
  const [dataType, setDataType] = useState<'sold' | 'current'>('sold');

  useEffect(() => {
    const fetchEbayData = async () => {
      if (!cardData.playerFirstName || !cardData.playerLastName || !cardData.brand || !cardData.year) {
        setError("Missing required card information for price lookup");
        setLoading(false);
        return;
      }

      try {
        const playerName = `${cardData.playerFirstName} ${cardData.playerLastName}`;
        const searchParams = new URLSearchParams({
          playerName,
          cardNumber: cardData.cardNumber || "",
          brand: cardData.brand,
          year: cardData.year.toString(),
          collection: cardData.collection || "",
          condition: cardData.condition || "",
          isNumbered: cardData.isNumbered ? "true" : "false",
          foilType: cardData.foilType || ""
        });

        const response = await fetch(`/api/ebay-search?${searchParams}`);
        if (!response.ok) {
          throw new Error("Failed to fetch eBay data");
        }

        const data: EbayResponse = await response.json();
        setResults(data.results.slice(0, 5)); // Get only the 5 most recent
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
            Finding Recent Sold Prices...
          </CardTitle>
          <p className="text-sm text-gray-600">
            Searching for authentic sold prices to get real market values
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

  // Helper function to render card information section
  const renderCardInfoSection = () => (
    <div className="space-y-4">
      {/* Uploaded Card Images */}
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

      {/* Card Summary - Clean Format */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg mb-4">Card Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* Sport */}
            <div className="text-lg">
              <span className="font-semibold text-slate-800">Sport: </span>
              <span className="text-slate-700">{cardData.sport || 'Baseball'}</span>
            </div>

            {/* Player */}
            <div className="text-lg">
              <span className="font-semibold text-slate-800">Player: </span>
              <span className="text-slate-700">{cardData.playerFirstName || ''} {cardData.playerLastName || 'Not detected'}</span>
            </div>

            {/* Two-column layout for card details */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
              <div className="space-y-4">
                {/* Brand */}
                <div className="text-lg">
                  <span className="font-semibold text-slate-800">Brand: </span>
                  <span className="text-slate-700">{cardData.brand || 'Not detected'}</span>
                </div>

                {/* Card Number */}
                <div className="text-lg">
                  <span className="font-semibold text-slate-800">Card #: </span>
                  <span className="text-slate-700">{cardData.cardNumber || 'Not detected'}</span>
                </div>

                {/* Year */}
                <div className="text-lg">
                  <span className="font-semibold text-slate-800">Year: </span>
                  <span className="text-slate-700">{cardData.year || 'Not detected'}</span>
                </div>
              </div>

              <div className="space-y-4">
                {/* Collection */}
                <div className="text-lg">
                  <span className="font-semibold text-slate-800">Collection: </span>
                  <span className="text-slate-700">{cardData.collection || 'Not detected'}</span>
                </div>

                {/* Variant */}
                <div className="text-lg">
                  <span className="font-semibold text-slate-800">Variant: </span>
                  <span className="text-slate-700">{cardData.variant || 'Base/Standard'}</span>
                </div>

                {/* Serial Number */}
                {cardData.serialNumber && (
                  <div className="text-lg">
                    <span className="font-semibold text-slate-800">Serial #: </span>
                    <span className="text-slate-700">{cardData.serialNumber}</span>
                  </div>
                )}

                {/* Foil Type */}
                <div className="text-lg">
                  <span className="font-semibold text-slate-800">Foil Type: </span>
                  <span className="text-slate-700">{cardData.foilType || 'None detected'}</span>
                </div>

                {/* Rookie Card Status */}
                <div className="text-lg">
                  <span className="font-semibold text-slate-800">Rookie Card: </span>
                  <span className="text-slate-700">{cardData.isRookieCard ? 'Yes' : 'No'}</span>
                </div>

                {/* Numbered */}
                {cardData.isNumbered && (
                  <div className="text-lg">
                    <span className="font-semibold text-slate-800">Type: </span>
                    <span className="text-slate-700">Numbered Card</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );

  if (error) {
    const isRateLimit = error.includes('rate limit');
    
    return (
      <div className="space-y-4">
        {/* Always show card information first */}
        {renderCardInfoSection()}
        
        {/* Then show pricing error */}
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
                  When available, this shows the 5 most recent <strong>sold prices</strong> (not asking prices) for accurate market values.
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
                  Search eBay Sold Listings Manually
                </Button>
                <p className="text-xs text-gray-500 mt-2">
                  Opens eBay with your card details and sold listings filter
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
      {/* Always show card information first */}
      {renderCardInfoSection()}

      {/* Average Price */}
      {averageValue > 0 && (
        <Card className={dataType === 'sold' ? "bg-green-50 border-green-200" : "bg-blue-50 border-blue-200"}>
          <CardContent className="pt-6">
            <div className="text-center">
              <div className={`text-2xl font-bold ${dataType === 'sold' ? 'text-green-800' : 'text-blue-800'}`}>
                {formatPrice(averageValue)}
              </div>
              <p className={dataType === 'sold' ? 'text-green-600' : 'text-blue-600'}>
                {dataType === 'sold' ? 'Average Recent Sold Price' : 'Average Current Asking Price'}
              </p>
              {dataType === 'current' && (
                <p className="text-xs text-blue-500 mt-1">
                  Note: These are asking prices, not actual sale prices
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Listings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            {dataType === 'sold' ? 'Recent Sold Listings' : 'Current Market Listings'} ({results.length})
          </CardTitle>
          {dataType === 'current' && (
            <p className="text-sm text-blue-600">
              Showing current asking prices - sold prices temporarily unavailable due to API limits
            </p>
          )}
        </CardHeader>
        <CardContent>
          {results.length === 0 ? (
            <p className="text-gray-600 text-center py-4">
              No recent sold listings found for this card.
            </p>
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
                    <p className="text-xs text-gray-400">
                      Sold: {formatDate(result.endTime)}
                    </p>
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