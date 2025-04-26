import { Card, CardWithRelations } from "@shared/schema";

interface CardItemProps {
  card: Card | CardWithRelations;
}

export default function CardItem({ card }: CardItemProps) {
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
    <div className="rounded-lg overflow-hidden border border-slate-200 bg-white card-shadow">
      <div className="aspect-w-2 aspect-h-3 relative bg-slate-200">
        {card.frontImage ? (
          <img 
            src={card.frontImage} 
            alt={`${card.playerFirstName} ${card.playerLastName} card`} 
            className="object-cover w-full h-full" 
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        )}
        {card.condition && (
          <div className={`absolute top-2 right-2 ${conditionClass} text-white rounded-full w-8 h-8 flex items-center justify-center text-xs font-bold`}>
            {conditionNumber}
          </div>
        )}
      </div>
      <div className="p-3">
        <h3 className="font-medium text-sm">{card.playerFirstName} {card.playerLastName}</h3>
        <p className="text-xs text-slate-500">
          {card.year} {
            'brand' in card && typeof card.brand === 'object' && card.brand && 'name' in card.brand 
              ? card.brand.name 
              : ''
          } {typeof card.collection === 'string' ? card.collection : ''}
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
