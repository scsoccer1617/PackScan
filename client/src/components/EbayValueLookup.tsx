import { useState } from 'react';
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
  
  // Function to directly open eBay in a new window/tab
  const openEbaySearch = () => {
    if (!playerName || !cardNumber || !brand || !year) {
      toast({
        title: "Missing card information",
        description: "Please provide player name, card number, brand, and year before searching eBay.",
        variant: "destructive"
      });
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
    
    // Open eBay in a new tab/window, which keeps our app open
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // Simple button-only interface
  return (
    <Button 
      variant="default" 
      className="w-full bg-blue-600 hover:bg-blue-700" 
      onClick={openEbaySearch}
      disabled={!playerName || !cardNumber || !brand || !year}
    >
      <ExternalLink className="mr-2 h-4 w-4" />
      Lookup on eBay
    </Button>
  );
}