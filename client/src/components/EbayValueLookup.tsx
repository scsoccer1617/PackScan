import { useState, useRef } from 'react';
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ExternalLink } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";

// Define interfaces
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
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const clickTimeoutRef = useRef<number | null>(null);
  
  // Function to directly open eBay in a new window/tab
  const openEbaySearch = () => {
    // Prevent multiple rapid clicks
    if (isLoading) return;
    
    // Debounce to prevent multiple windows from opening
    if (clickTimeoutRef.current) {
      window.clearTimeout(clickTimeoutRef.current);
    }
    
    setIsLoading(true);
    
    if (!playerName || !cardNumber || !brand || !year) {
      toast({
        title: "Missing card information",
        description: "Please provide player name, card number, brand, and year before searching eBay.",
        variant: "destructive"
      });
      setIsLoading(false);
      return;
    }
    
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
    
    // Schedule the window.open call
    clickTimeoutRef.current = window.setTimeout(() => {
      try {
        // Open eBay in a new tab/window, which keeps our app open
        const newWindow = window.open(url, '_blank', 'noopener,noreferrer');
        
        // Check if window was successfully opened
        if (!newWindow || newWindow.closed || typeof newWindow.closed === 'undefined') {
          toast({
            title: "Popup blocked",
            description: "Please allow popups for this site to open eBay search results.",
            variant: "destructive"
          });
        }
      } catch (error) {
        console.error("Error opening eBay window:", error);
      } finally {
        setIsLoading(false);
        clickTimeoutRef.current = null;
      }
    }, 100);
  };

  // Simple button-only interface
  return (
    <Button 
      variant="default" 
      className="w-full bg-blue-600 hover:bg-blue-700" 
      onClick={openEbaySearch}
      disabled={isLoading || !playerName || !cardNumber || !brand || !year}
    >
      <ExternalLink className="mr-2 h-4 w-4" />
      {isLoading ? "Opening eBay..." : "Lookup on eBay"}
    </Button>
  );
}