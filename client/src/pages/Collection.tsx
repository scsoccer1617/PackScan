import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import CardGrid from "@/components/CardGrid";

export default function Collection() {
  const [searchQuery, setSearchQuery] = useState("");
  const [manualCardCount, setManualCardCount] = useState(0);
  const [manualTotalValue, setManualTotalValue] = useState(0);
  const [allCards, setAllCards] = useState([]);
  
  // Direct API call for the cards
  useEffect(() => {
    async function fetchCards() {
      try {
        const response = await fetch('/api/cards');
        if (response.ok) {
          const cardsData = await response.json();
          setAllCards(cardsData);
          
          // Calculate stats from cards data
          const totalValue = cardsData.reduce((sum, card) => 
            sum + (card.estimatedValue ? Number(card.estimatedValue) : 0), 0);
          
          console.log("Direct cards data:", {
            cardCount: cardsData.length,
            totalValue: totalValue
          });
          
          setManualCardCount(cardsData.length);
          setManualTotalValue(totalValue);
        }
      } catch (error) {
        console.error("Error fetching cards:", error);
      }
    }
    
    fetchCards();
  }, []);
  
  // Fetch using React Query (for comparison)
  const { data: collectionSummary, isLoading: summaryLoading } = useQuery<{ cardCount: number, totalValue: number }>({
    queryKey: ['/api/collection/summary'],
  });

  return (
    <div className="p-4">
      {/* Filter and Sort Options */}
      <div className="flex items-center justify-between mb-4">
        <div className="relative flex-1 max-w-xs">
          <Input
            type="text"
            placeholder="Search collection..."
            className="w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 absolute left-3 top-2.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        
        <div className="flex space-x-2">
          <Button variant="outline" size="icon" className="border border-slate-300 bg-white">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
          </Button>
          <Button variant="outline" size="icon" className="border border-slate-300 bg-white">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
            </svg>
          </Button>
        </div>
      </div>
      
      {/* Collection Stats */}
      <div className="bg-primary-50 rounded-lg p-4 mb-4">
        <div className="flex justify-between items-center">
          <div>
            <h3 className="font-medium text-primary-900">My Collection</h3>
            <p className="text-sm text-primary-700 font-medium">
              {manualCardCount} cards • Est. value: ${manualTotalValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
            </p>
          </div>
          <Button className="bg-primary-100 text-primary-800 hover:bg-primary-200">
            Export
          </Button>
        </div>
      </div>
      
      {/* Card Grid */}
      <CardGrid />
      
      {/* Bottom spacer to prevent content from being hidden behind navigation */}
      <div className="h-28 w-full mt-8"></div>
    </div>
  );
}
