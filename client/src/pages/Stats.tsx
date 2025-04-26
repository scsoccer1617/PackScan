import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import StatsSummary from "@/components/StatsSummary";
import StatsCharts from "@/components/StatsCharts";
import { Card as CardType, CardWithRelations } from "@shared/schema";
import { formatCurrency } from "@/lib/utils";

interface TopCard extends CardWithRelations {
  changePercent: number;
}

export default function Stats() {
  const { data: topCards, isLoading, error } = useQuery<TopCard[]>({
    queryKey: ['/api/stats/top-cards'],
  });
  
  // Helper function to get brand name safely
  const getBrandName = (card: any) => {
    if (card && card.brand && typeof card.brand === 'object' && 'name' in card.brand) {
      return card.brand.name;
    }
    return '';
  };

  return (
    <div className="p-4">
      <h2 className="font-semibold text-lg mb-3">Collection Stats</h2>
      
      {/* Value Summary */}
      <StatsSummary />
      
      {/* Charts Section */}
      <StatsCharts />
      
      {/* Top Cards */}
      <Card className="bg-white rounded-lg p-4 shadow-sm mb-4">
        <CardTitle className="text-sm font-medium text-slate-500 mb-2">Most Valuable Cards</CardTitle>
        
        <CardContent className="p-0 pt-2">
          <div className="space-y-3">
            {isLoading ? (
              Array(3).fill(0).map((_, index) => (
                <div key={index} className="flex items-center space-x-3 p-2 animate-pulse">
                  <div className="w-12 h-16 bg-slate-200 rounded"></div>
                  <div className="flex-1">
                    <div className="h-4 bg-slate-200 rounded w-3/4 mb-1"></div>
                    <div className="h-3 bg-slate-200 rounded w-1/2"></div>
                  </div>
                  <div className="text-right">
                    <div className="h-4 bg-slate-200 rounded w-16 mb-1"></div>
                    <div className="h-3 bg-slate-200 rounded w-10"></div>
                  </div>
                </div>
              ))
            ) : error ? (
              <div className="text-center py-4 text-slate-500">
                Failed to load top cards
              </div>
            ) : !topCards || topCards.length === 0 ? (
              <div className="text-center py-4 text-slate-500">
                Add cards to see your most valuable items
              </div>
            ) : (
              topCards.map((card) => (
                <div key={card.id} className="flex items-center space-x-3 p-2 hover:bg-slate-50 rounded">
                  <div className="w-12 h-16 bg-slate-100 rounded overflow-hidden">
                    {card.frontImage ? (
                      <>
                        <img 
                          src={card.frontImage.startsWith('http') ? card.frontImage : `${window.location.origin}${card.frontImage}`} 
                          alt="Card thumbnail" 
                          className="object-cover w-full h-full" 
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                            const parent = (e.target as HTMLImageElement).parentElement;
                            if (parent) {
                              const fallback = parent.querySelector('.image-fallback');
                              if (fallback) fallback.classList.remove('hidden');
                            }
                          }}
                        />
                        <div className="w-full h-full flex items-center justify-center hidden image-fallback">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                        </div>
                      </>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-sm truncate">{card.playerFirstName} {card.playerLastName}</h4>
                    <p className="text-xs text-slate-500 truncate">{card.year} {getBrandName(card)} {card.collection} #{card.cardNumber}</p>
                  </div>
                  <div className="text-right">
                    <div className="font-medium text-secondary-600">{formatCurrency(Number(card.estimatedValue))}</div>
                    {card.changePercent !== 0 && (
                      <div className={`text-xs ${card.changePercent > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {card.changePercent > 0 ? '↑' : '↓'} {Math.abs(card.changePercent).toFixed(1)}%
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
