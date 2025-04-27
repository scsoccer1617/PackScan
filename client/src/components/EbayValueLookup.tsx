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
    let query = `${brand} ${year} ${playerName} #${cardNumber}`;
    
    // Add collection if provided, but handle special collections
    if (collection) {
      if (collection.toLowerCase().includes('heritage')) {
        query = `${brand} ${year} heritage ${playerName} #${cardNumber}`;
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
        onClick={() => openEbaySearch()}
        disabled={!playerName || !cardNumber || !brand || !year}
      >
        <ExternalLink className="mr-2 h-4 w-4" />
        Lookup on eBay
      </Button>
      
      {/* This DialogTrigger is just for the custom value entry dialog, not the main button */}
      <DialogTrigger asChild>
        <Button 
          variant="outline" 
          className="w-full mt-2" 
          onClick={() => setIsOpen(true)}
        >
          <DollarSign className="mr-2 h-4 w-4" />
          Set Custom Value
        </Button>
      </DialogTrigger>
      
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set Card Value</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          <div className="flex flex-col space-y-1.5">
            <h3 className="text-lg font-semibold">{fullPlayerName}</h3>
            <p className="text-sm text-muted-foreground">
              {brand} {year} {collection ? `${collection} ` : ''}{cardNumber} {condition ? `• ${condition}` : ''}
            </p>
          </div>
          
          <div className="p-4 bg-muted rounded-md">
            <Label htmlFor="custom-value" className="text-sm font-medium mb-1 block">
              Enter Card Value
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
                Save
              </Button>
            </div>
          </div>
          
          <div className="flex justify-center pt-2">
            <Button variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}