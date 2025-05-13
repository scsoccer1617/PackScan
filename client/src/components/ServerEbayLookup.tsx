import { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ExternalLink, Loader2 } from "lucide-react";
import { useQuery } from '@tanstack/react-query';

interface ServerEbayLookupProps {
  cardId: number;
  onValueSelect: (value: number) => void;
}

export default function ServerEbayLookup({ cardId, onValueSelect }: ServerEbayLookupProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);

  // Define the response type
  interface ServerResponse {
    success: boolean;
    data?: {
      url: string;
      query: string;
      card: {
        id: number;
        collection: string;
        playerName: string;
        cardNumber: string;
        brand: string;
        year: number;
        variant: string | null;
      }
    };
    error?: string;
  }

  // Use TanStack Query to fetch eBay URL from server
  const { data, isLoading: isUrlLoading, error } = useQuery<ServerResponse>({
    queryKey: [`/api/cards/${cardId}/ebay-url`],
    enabled: !!cardId, // Only run if cardId is provided
  });
  
  // Log data when it changes
  useEffect(() => {
    if (data) {
      console.log(`Server eBay URL fetch successful for card ${cardId}:`, data);
    }
    if (error) {
      console.error(`Server eBay URL fetch failed for card ${cardId}:`, error);
    }
  }, [data, error, cardId]);

  useEffect(() => {
    if (error) {
      console.error('Error loading eBay URL:', error);
      toast({
        title: 'Error',
        description: 'Failed to generate eBay search URL.',
        variant: 'destructive',
      });
    } else if (data) {
      console.log('Server-generated eBay URL data:', data);
    }
  }, [data, error, toast]);

  // Handle selecting a value (using the same hardcoded examples for now)
  const handleSelectValue = (value: number) => {
    onValueSelect(value);
    toast({
      title: 'Value Selected',
      description: `Card value set to $${value.toFixed(2)}`,
    });
  };

  if (isUrlLoading) {
    return (
      <div className="flex items-center justify-center p-4">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        <span>Loading eBay URL...</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-red-500 text-center p-2">
        Failed to generate eBay URL. Please try again.
      </div>
    );
  }
  
  // Safely extract data from the response
  const ebayUrl = !data.success || !data.data 
    ? '' 
    : data.data.url;
    
  const queryString = !data.success || !data.data
    ? '' 
    : data.data.query;

  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500 mb-1">
        eBay search: <span className="font-medium">{queryString}</span>
      </div>
      
      <div className="flex flex-col space-y-2">
        <Button 
          variant="outline" 
          size="sm"
          className="flex items-center justify-center w-full"
          asChild
        >
          <a 
            href={ebayUrl} 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center"
          >
            <span>Lookup on eBay</span>
            <ExternalLink className="ml-2 h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
    </div>
  );
}