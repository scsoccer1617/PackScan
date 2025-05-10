import { useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ExternalLink } from "lucide-react";

interface EbayValueLookupProps {
  playerName: string;
  cardNumber: string;
  brand: string;
  year: number;
  collection?: string;
  condition?: string;
  variant?: string;
  onValueSelect: (value: number) => void;
}

export default function EbayValueLookup({ 
  playerName, 
  cardNumber, 
  brand, 
  year,
  collection,
  condition,
  variant,
  onValueSelect 
}: EbayValueLookupProps) {
  const { toast } = useToast();
  
  // Create the eBay search URL
  const ebayUrl = useMemo(() => {
    if (!playerName || !cardNumber || !brand || !year) {
      return '';
    }
    
    // Build eBay search URL directly
    let query = '';
    
    // Build the base query with core card information
    query = `${brand} ${year}`;
    
    // Add collection if available
    if (collection) {
      query += ` ${collection}`;
    }
    
    // Add variant if available
    if (variant) {
      query += ` ${variant}`;
    }
    
    // Add player name and card number
    query += ` ${playerName} #${cardNumber}`;
    
    // Special handling for Heritage cards
    if (collection && collection.toLowerCase().includes('heritage')) {
      query = `${brand} ${year} heritage ${playerName} #${cardNumber}`;
    }
    
    // Log the search query for debugging
    console.log('eBay search query:', JSON.stringify(query));
    
    // Construct the URL with search parameters
    const baseUrl = 'https://www.ebay.com/sch/i.html';
    const searchParams = new URLSearchParams({
      _nkw: query,
      LH_Complete: '1',    // Completed listings
      LH_Sold: '1',        // Sold listings
      rt: 'nc',            // No "see other items" 
      LH_PrefLoc: '1'      // Ships to US
    });
    
    return `${baseUrl}?${searchParams.toString()}`;
  }, [playerName, cardNumber, brand, year, collection, condition, variant]);
  
  // Show warning if card information is missing
  const handleMissingInfo = () => {
    if (!playerName || !cardNumber || !brand || !year) {
      toast({
        title: "Missing card information",
        description: "Please provide player name, card number, brand, and year before searching eBay.",
        variant: "destructive"
      });
    }
  };

  // Render a regular anchor tag styled as a button
  return (
    <div className="w-full">
      {ebayUrl ? (
        <a 
          href={ebayUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-blue-600 hover:bg-blue-700 text-white h-10 px-4 py-2"
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          Lookup on eBay
        </a>
      ) : (
        <Button 
          variant="default" 
          className="w-full bg-blue-600 hover:bg-blue-700" 
          onClick={handleMissingInfo}
          disabled={!playerName || !cardNumber || !brand || !year}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          Lookup on eBay
        </Button>
      )}
    </div>
  );
}