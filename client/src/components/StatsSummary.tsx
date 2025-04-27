import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { useState, useEffect } from "react";

interface StatsSummaryProps {
  totalValue: number;
  changeValue: number;
  changePercent: number;
}

export default function StatsSummary() {
  const [directTotalValue, setDirectTotalValue] = useState(0);

  // Direct API call to calculate stats
  useEffect(() => {
    async function fetchCards() {
      try {
        const response = await fetch('/api/cards');
        if (response.ok) {
          const cardsData = await response.json();
          
          // Calculate total value from cards data
          const totalValue = cardsData.reduce((sum, card) => 
            sum + (card.estimatedValue ? Number(card.estimatedValue) : 0), 0);
          
          console.log("Stats page - direct data:", {
            cardCount: cardsData.length,
            totalValue: totalValue
          });
          
          setDirectTotalValue(totalValue);
        }
      } catch (error) {
        console.error("Error fetching cards for stats:", error);
      }
    }
    
    fetchCards();
  }, []);
  
  // Original Query for comparison
  const { data, isLoading, error } = useQuery<{
    totalValue: number;
    changeValue: number;
    changePercent: number;
  }>({
    queryKey: ['/api/stats/summary'],
  });

  if (isLoading) {
    return (
      <Card className="bg-white rounded-lg p-4 shadow-sm mb-4">
        <div className="animate-pulse">
          <div className="h-4 bg-slate-200 rounded w-1/3 mb-2"></div>
          <div className="h-8 bg-slate-200 rounded w-1/2 mb-2"></div>
        </div>
      </Card>
    );
  }

  // Get values from API if available, otherwise use our direct calculation
  const valuesToUse = {
    totalValue: directTotalValue,
    changeValue: 0,
    changePercent: 0
  };

  // Use direct data instead of relying on the API response
  return (
    <Card className="bg-white rounded-lg p-4 shadow-sm mb-4">
      <h3 className="text-sm font-medium text-slate-500 mb-2">Total Collection Value</h3>
      <div className="flex items-baseline">
        <span className="text-2xl font-bold">{formatCurrency(valuesToUse.totalValue)}</span>
        {valuesToUse.changeValue !== 0 && (
          <span className={`ml-2 text-xs font-medium ${valuesToUse.changeValue > 0 ? 'text-green-600' : 'text-red-600'}`}>
            {valuesToUse.changeValue > 0 ? '↑' : '↓'} {formatCurrency(Math.abs(valuesToUse.changeValue))} ({valuesToUse.changePercent.toFixed(1)}%)
          </span>
        )}
      </div>
    </Card>
  );
}
