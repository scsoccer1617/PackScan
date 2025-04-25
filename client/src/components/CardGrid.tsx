import { useQuery } from "@tanstack/react-query";
import CardItem from "./CardItem";
import { Card } from "@shared/schema";

export default function CardGrid() {
  const { data: cards, isLoading, error } = useQuery<Card[]>({
    queryKey: ['/api/cards'],
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-lg overflow-hidden border border-slate-200 bg-white">
            <div className="aspect-w-2 aspect-h-3 bg-slate-200 animate-pulse"></div>
            <div className="p-3">
              <div className="h-4 bg-slate-200 rounded animate-pulse mb-2"></div>
              <div className="h-3 bg-slate-200 rounded animate-pulse w-2/3 mb-2"></div>
              <div className="flex justify-between items-center mt-2">
                <div className="h-3 bg-slate-200 rounded animate-pulse w-1/4"></div>
                <div className="h-3 bg-slate-200 rounded animate-pulse w-1/6"></div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
        <p>Failed to load cards: {(error as Error).message}</p>
      </div>
    );
  }

  if (!cards || cards.length === 0) {
    return (
      <div className="bg-white rounded-lg p-6 text-center border border-slate-200">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto text-slate-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
        <h3 className="text-lg font-medium text-slate-700 mb-2">No cards yet</h3>
        <p className="text-slate-500 mb-4">Start by adding your first card to your collection.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      {cards.map((card) => (
        <CardItem key={card.id} card={card} />
      ))}
    </div>
  );
}
