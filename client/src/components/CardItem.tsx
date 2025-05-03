import { Card, CardWithRelations } from "@shared/schema";
import { Trash2, Edit } from "lucide-react";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatCurrency } from "@/lib/utils";
import EditCardModal from "./EditCardModal";

interface CardItemProps {
  card: Card | CardWithRelations;
  quantity?: number;
  onDelete?: () => void;
}

export default function CardItem({ card, quantity, onDelete }: CardItemProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
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

  // Use useEffect to log the image state
  useEffect(() => {
    if (card.frontImage) {
      console.log(`Card ID ${card.id}: ${card.frontImage}`);
    }
  }, [card.id, card.frontImage]);

  // Define state for image loading
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [pathIndex, setPathIndex] = useState(0);
  const [imageError, setImageError] = useState(false);
  
  // Generate multiple possible paths for the image
  useEffect(() => {
    if (!card.frontImage) return;
    
    // Try different path formats
    const paths = [
      // Original card.frontImage path (with /uploads/ added if needed)
      card.frontImage.startsWith('/uploads/') ? card.frontImage : `/uploads/${card.frontImage}`,
      
      // Try attaching /uploads/ to the base filename without a path
      `/uploads/${card.frontImage.split('/').pop()}`,
      
      // Try attaching /attached_assets/ to the player name for fallbacks
      `/attached_assets/${card.playerFirstName?.toLowerCase()}_${card.playerLastName?.toLowerCase()}_front_${card.year}_topps_${card.collection?.toLowerCase()}.jpg`,
      
      // Try a direct path to attached_assets
      `/attached_assets/${card.frontImage.split('/').pop()}`
    ];
    
    // Set the initial path
    setImagePath(paths[pathIndex]);
    console.log(`Card ${card.id} trying path ${pathIndex}: ${paths[pathIndex]}`);
  }, [card.frontImage, pathIndex, card.playerFirstName, card.playerLastName, card.year, card.collection, card.id]);
  
  // Handle image error by trying the next path
  const handleImageError = () => {
    console.error(`Failed to load image path ${pathIndex}:`, imagePath);
    if (pathIndex < 3) {
      // Try the next path
      setPathIndex(pathIndex + 1);
    } else {
      // All paths failed, show fallback
      setImageError(true);
    }
  };

  return (
    <div id={`card-${card.id}`} className="rounded-lg overflow-hidden border border-slate-200 bg-white card-shadow hover:shadow-md transition-all duration-300 hover:border-secondary-300">
      <div className="card-image-container relative bg-slate-100">
        {card.frontImage ? (
          <div className={`card-image-wrapper relative ${imageError ? 'image-error' : ''}`}>
            {/* Try multiple image sources if needed */}
            {imagePath && (
              <img 
                key={imagePath} // Key helps React know when to recreate the image element
                src={imagePath}
                alt={`${card.playerFirstName} ${card.playerLastName} card`}
                className="card-image"
                onError={handleImageError}
                loading="eager"
              />
            )}
            
            <div className="fallback-content">
              <div className="text-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p className="text-xs text-slate-500 mt-2">Image not found</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="card-image-wrapper image-error">
            <div className="fallback-content">
              <div className="text-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p className="text-xs text-slate-500 mt-2">No Image</p>
              </div>
            </div>
          </div>
        )}
        {/* Button controls */}
        <div className="absolute top-2 left-2 flex space-x-1 z-10">
          {/* Edit button */}
          <button 
            className="bg-white/80 hover:bg-blue-100 text-blue-500 rounded-full p-1.5 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setIsEditModalOpen(true);
            }}
            aria-label="Edit card"
          >
            <Edit className="w-4 h-4" />
          </button>
          
          {/* Delete button */}
          <button 
            className="bg-white/80 hover:bg-red-100 text-red-500 rounded-full p-1.5 transition-colors"
            onClick={handleDelete}
            disabled={isDeleting}
            aria-label="Delete card"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
        
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
            {card.estimatedValue ? formatCurrency(Number(card.estimatedValue)) : 'N/A'}
          </span>
          <div className="flex flex-col items-end">
            <div className="flex items-center">
              <span className="text-xs text-slate-400">#{card.cardNumber}</span>
              {quantity && quantity > 1 && (
                <span className="ml-1.5 text-xs font-bold bg-secondary-100 text-secondary-700 px-1.5 py-0.5 rounded-full">
                  x{quantity}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* Edit Card Modal */}
      <EditCardModal 
        card={hasRelations(card) ? card : null}
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
      />
    </div>
  );
}
