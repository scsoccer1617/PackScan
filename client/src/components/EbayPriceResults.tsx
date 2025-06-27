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
}

interface EbayPriceResultsProps {
  cardData: Partial<CardFormValues>;
}

export default function EbayPriceResults({ cardData }: EbayPriceResultsProps) {
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<EbaySearchResult[]>([]);
  const [averageValue, setAverageValue] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [searchUrl, setSearchUrl] = useState<string | null>(null);

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
          condition: cardData.condition || ""
        });

        const response = await fetch(`/api/ebay-search?${searchParams}`);
        if (!response.ok) {
          throw new Error("Failed to fetch eBay data");
        }

        const data: EbayResponse = await response.json();
        setResults(data.results.slice(0, 5)); // Get only the 5 most recent
        setAverageValue(data.averageValue);
        setSearchUrl(data.searchUrl || null);
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

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-red-600">Error Loading Prices</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-gray-600 mb-4">{error}</p>
          {searchUrl && (
            <Button 
              onClick={() => window.open(searchUrl, '_blank')}
              className="flex items-center gap-2"
            >
              <ExternalLink className="h-4 w-4" />
              Search eBay Manually
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Card Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {cardData.playerFirstName} {cardData.playerLastName} - {cardData.year} {cardData.brand}
          </CardTitle>
          {cardData.collection && (
            <p className="text-gray-600">{cardData.collection}</p>
          )}
          {cardData.cardNumber && (
            <p className="text-sm text-gray-500">Card #{cardData.cardNumber}</p>
          )}
        </CardHeader>
      </Card>

      {/* Average Price */}
      {averageValue > 0 && (
        <Card className="bg-green-50 border-green-200">
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="text-2xl font-bold text-green-800">
                {formatPrice(averageValue)}
              </div>
              <p className="text-green-600">Average Recent Sold Price</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Sold Listings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Recent Sold Listings ({results.length})
          </CardTitle>
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