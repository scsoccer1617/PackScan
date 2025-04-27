import { useState, useRef } from 'react';
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ExternalLink, DollarSign, Check } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";



interface EbayValueResult {
  title: string;
  price: number;
  currency: string;
  url: string;
  imageUrl: string;
  condition: string;
  endTime: string;
}

interface EbayValueResponse {
  status: 'success' | 'unconfigured';
  message?: string;
  searchUrl: string;
  averageValue: number | null;
  results: EbayValueResult[];
}

interface EbayValueLookupProps {
  playerName: string;
  cardNumber: string;
  brand: string;
  year: number;
  collection?: string;
  condition?: string;
  onValueSelect: (value: number) => void;
}

export default function EbayValueLookup({ 
  playerName, 
  cardNumber, 
  brand, 
  year,
  collection,
  condition,
  onValueSelect 
}: EbayValueLookupProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<EbayValueResponse | null>(null);
  const [customValue, setCustomValue] = useState<string>('');
  const { toast } = useToast();

  // Format the player name for display (combine first and last name)
  const fullPlayerName = playerName;

  const lookupValue = async () => {
    if (!playerName || !cardNumber || !brand || !year) {
      toast({
        title: "Missing information",
        description: "Please fill in player name, card number, brand, and year before looking up values.",
        variant: "destructive"
      });
      return;
    }

    try {
      setLoading(true);
      
      // Make API request to our new eBay endpoint
      const data = await apiRequest<EbayValueResponse>({
        url: '/api/ebay/search-values',
        method: 'POST',
        body: {
          playerName,
          cardNumber,
          brand,
          year,
          collection,
          condition
        }
      });
      
      setResults(data);
      
      // If we have an average value from eBay, show it in a toast
      if (data.averageValue) {
        toast({
          title: "eBay Value Found",
          description: `Average value: ${formatCurrency(data.averageValue)}`,
        });
      }
    } catch (error) {
      console.error('Error looking up card value:', error);
      toast({
        title: "Error",
        description: "Failed to lookup card value. Please try again.",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const handleValueSelect = (value: number) => {
    onValueSelect(value);
    setIsOpen(false);
    
    toast({
      title: "Value Applied",
      description: `Card value set to ${formatCurrency(value)}`,
    });
  };
  
  const handleCustomValueSubmit = () => {
    const value = parseFloat(customValue);
    if (isNaN(value) || value <= 0) {
      toast({
        title: "Invalid value",
        description: "Please enter a valid positive number",
        variant: "destructive"
      });
      return;
    }
    
    handleValueSelect(value);
  };

  // Function to directly open eBay instead of dialog
  const openEbaySearch = () => {
    // Build eBay search URL directly
    let query = `${brand} ${year} ${playerName} ${cardNumber}`;
    
    // Add collection if provided, but handle special collections
    if (collection) {
      if (collection.toLowerCase().includes('heritage')) {
        query = `${brand} ${year} heritage ${playerName}`;
      } else {
        query += ` ${collection}`;
      }
    }
    
    // Construct the URL with search parameters
    const baseUrl = 'https://www.ebay.com/sch/i.html';
    const searchParams = new URLSearchParams({
      _nkw: query,
      LH_Complete: '1',    // Completed listings
      LH_Sold: '1',        // Sold listings
      rt: 'nc',            // No "see other items" 
      LH_PrefLoc: '1'      // Ships to US
    });
    
    const url = `${baseUrl}?${searchParams.toString()}`;
    window.open(url, '_blank');
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <Button 
        variant="default" 
        className="w-full bg-blue-600 hover:bg-blue-700" 
        onClick={openEbaySearch}
        disabled={loading || !playerName || !cardNumber || !brand || !year}
      >
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Looking up value...
          </>
        ) : (
          <>
            <DollarSign className="mr-2 h-4 w-4" />
            Look up eBay value
          </>
        )}
      </Button>
      <DialogTrigger asChild className="hidden">
        <button>Hidden trigger</button>
      </DialogTrigger>
      
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Card Value Lookup</DialogTitle>
        </DialogHeader>
        
        {loading ? (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
            <p>Looking up recent sales on eBay...</p>
          </div>
        ) : results ? (
          <div className="space-y-4">
            <div className="flex flex-col space-y-1.5">
              <h3 className="text-lg font-semibold">{fullPlayerName}</h3>
              <p className="text-sm text-muted-foreground">
                {brand} {year} {collection ? `${collection} ` : ''}{cardNumber} {condition ? `• ${condition}` : ''}
              </p>
            </div>
            
            {results.status === 'unconfigured' ? (
              <div className="p-4 bg-muted rounded-md">
                <p className="mb-2 text-sm">eBay API is not configured yet. You can still view sold listings on eBay:</p>
                <Button 
                  variant="outline" 
                  className="w-full mt-2"
                  onClick={() => window.open(results.searchUrl, '_blank')}
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  View on eBay
                </Button>
              </div>
            ) : (
              <>
                {results.averageValue ? (
                  <div className="p-4 bg-muted rounded-md">
                    <p className="text-sm font-medium">Average value based on {results.results.length} recent sales:</p>
                    <h4 className="text-2xl font-bold mt-1">{formatCurrency(results.averageValue)}</h4>
                    
                    <Button 
                      className="w-full mt-4"
                      onClick={() => handleValueSelect(results.averageValue!)}
                    >
                      Use this value
                    </Button>
                  </div>
                ) : (
                  <div className="p-4 bg-muted rounded-md">
                    <Button 
                      variant="default" 
                      className="w-full mb-3"
                      onClick={() => window.open(results.searchUrl, '_blank')}
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      View on eBay
                    </Button>
                  </div>
                )}
                
                {results.results.length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                      <h4 className="text-sm font-medium">Recent Sales</h4>
                      
                      {results.results.map((result, i) => (
                        <Card key={i} className="p-3 flex items-start space-x-3">
                          {result.imageUrl && (
                            <div className="flex-shrink-0 w-12 h-12 overflow-hidden rounded-sm">
                              <img 
                                src={result.imageUrl} 
                                alt={result.title} 
                                className="w-full h-full object-cover"
                              />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <h4 className="text-sm font-medium truncate">{result.title}</h4>
                            <p className="text-xs text-muted-foreground">{result.condition}</p>
                            <div className="flex justify-between items-center mt-1">
                              <p className="font-bold">{formatCurrency(result.price)}</p>
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="h-6 px-2"
                                onClick={() => handleValueSelect(result.price)}
                              >
                                Use
                              </Button>
                            </div>
                          </div>
                        </Card>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            
            <Separator className="my-2" />
            
            <div className="p-4 bg-muted rounded-md">
              <Label htmlFor="custom-value" className="text-sm font-medium mb-1 block">
                Enter Custom Value
              </Label>
              <div className="flex space-x-2">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span>
                  <Input
                    id="custom-value"
                    type="number"
                    min="0.01" 
                    step="0.01"
                    placeholder="0.00"
                    className="pl-7"
                    value={customValue}
                    onChange={(e) => setCustomValue(e.target.value)}
                  />
                </div>
                <Button 
                  onClick={handleCustomValueSubmit}
                  disabled={!customValue}
                >
                  <Check className="mr-2 h-4 w-4" />
                  Use
                </Button>
              </div>
            </div>
            
            <div className="flex justify-center pt-2">
              <Button variant="outline" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="py-6 text-center">
            <p>Enter card details and click "Look up eBay value" to see recent sales.</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}