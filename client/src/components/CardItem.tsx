import { Card, CardWithRelations } from "@shared/schema";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface CardItemProps {
  card: Card | CardWithRelations;
  onDelete?: () => void;
}

export default function CardItem({ card, onDelete }: CardItemProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const { toast } = useToast();
  
  // Function to check if the card has relations
  const hasRelations = (card: Card | CardWithRelations): card is CardWithRelations => {
    return 'brand' in card || 'sport' in card;
  };

  // Access brand name safely
  const getBrandName = () => {
    if (hasRelations(card) && card.brand && typeof card.brand === 'object') {
      return card.brand.name;
    }
    return '';
  };
  
  // Handle card deletion
  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    
    if (confirm(`Are you sure you want to delete ${card.playerFirstName} ${card.playerLastName}'s card?`)) {
      setIsDeleting(true);
      try {
        // Use fetch directly instead of apiRequest helper
        const response = await fetch(`/api/cards/${card.id}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
          },
        });
        
        if (!response.ok) {
          throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
        }
        
        // Invalidate cards query to refresh the list
        queryClient.invalidateQueries({ queryKey: ['/api/cards'] });
        
        // Also invalidate stats
        queryClient.invalidateQueries({ queryKey: ['/api/collection/summary'] });
        
        toast({
          title: "Card Deleted",
          description: `${card.playerFirstName} ${card.playerLastName}'s card has been removed.`,
        });
        
        // If a callback was provided, call it
        if (onDelete) {
          onDelete();
        }
      } catch (error) {
        console.error('Error deleting card:', error);
        toast({
          title: "Error",
          description: "Failed to delete the card. Please try again.",
          variant: "destructive",
        });
      } finally {
        setIsDeleting(false);
      }
    }
  };

  const conditionClass = 
    card.condition === "PSA 10" ? "bg-green-500" :
    card.condition === "PSA 9" ? "bg-secondary-500" :
    card.condition === "PSA 8" ? "bg-secondary-500" :
    card.condition === "PSA 7" ? "bg-amber-500" :
    card.condition === "PSA 6" ? "bg-amber-500" :
    card.condition === "PSA 5" ? "bg-amber-500" :
    card.condition === "PSA 4" ? "bg-amber-500" :
    card.condition === "PSA 3" ? "bg-amber-500" :
    card.condition === "PSA 2" ? "bg-red-500" :
    "bg-red-500";

  const conditionNumber = card.condition ? card.condition.split(" ")[1] : "";

  return (
    <div className="rounded-lg overflow-hidden border border-slate-200 bg-white card-shadow hover:shadow-md transition-all duration-300 hover:border-secondary-300">
      <div className="aspect-w-2 aspect-h-3 relative bg-slate-200 overflow-hidden">
        {card.frontImage ? (
          <>
            <img 
              src={card.frontImage.startsWith('http') ? card.frontImage : `${window.location.origin}${card.frontImage}`} 
              alt={`${card.playerFirstName} ${card.playerLastName} card`} 
              className="object-contain w-full h-full transform hover:scale-105 transition-transform duration-300" 
              onError={(e) => {
                // If image fails to load, show placeholder
                (e.target as HTMLImageElement).style.display = 'none';
                const parent = (e.target as HTMLImageElement).parentElement;
                if (parent) {
                  const fallback = parent.querySelector('.image-fallback');
                  if (fallback) fallback.classList.remove('hidden');
                }
              }}
            />
            {/* Hidden fallback that appears if image fails to load */}
            <div className="flex items-center justify-center h-full hidden image-fallback">
              <div className="text-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p className="text-xs text-slate-500 mt-2">Image not available</p>
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <p className="text-xs text-slate-500 mt-2">No image available</p>
            </div>
          </div>
        )}
        {/* Delete button */}
        <button 
          className="absolute top-2 left-2 bg-white/80 hover:bg-red-100 text-red-500 rounded-full p-1.5 transition-colors z-10"
          onClick={handleDelete}
          disabled={isDeleting}
          aria-label="Delete card"
        >
          <Trash2 className="w-4 h-4" />
        </button>
        
        {card.condition && (
          <div className={`absolute top-2 right-2 ${conditionClass} text-white rounded-full w-8 h-8 flex items-center justify-center text-xs font-bold`}>
            {conditionNumber}
          </div>
        )}
      </div>
      <div className="p-3">
        <h3 className="font-medium text-sm">{card.playerFirstName} {card.playerLastName}</h3>
        <p className="text-xs text-slate-500">
          {card.year} {getBrandName()} {typeof card.collection === 'string' ? card.collection : ''}
        </p>
        <div className="flex justify-between items-center mt-2">
          <span className="text-xs font-medium text-secondary-600">
            ${card.estimatedValue ? card.estimatedValue.toFixed(2) : 'N/A'}
          </span>
          <span className="text-xs text-slate-400">#{card.cardNumber}</span>
        </div>
      </div>
    </div>
  );
}
