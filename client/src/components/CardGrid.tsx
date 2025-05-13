import { useQuery } from "@tanstack/react-query";
import CardItem from "./CardItem";
import { Card, CardWithRelations } from "@shared/schema";
import React, { useState, useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp, Filter, SortDesc } from "lucide-react";

// Group cards by Year + Brand + Collection
type CardsByGroup = {
  [key: string]: CardWithRelations[];
};

// Sort types
type SortOption = "newest" | "oldest" | "name-asc" | "name-desc" | "value-high" | "value-low" | "card-number";

export default function CardGrid() {
  const { data: cards, isLoading, error } = useQuery<CardWithRelations[]>({
    queryKey: ['/api/cards']
  });
  
  // Add separate debugging effect
  useEffect(() => {
    if (cards) {
      console.log('Card images in collection:');
      cards.forEach((card: CardWithRelations) => {
        if (card.frontImage) {
          console.log(`Card ID ${card.id}: ${card.frontImage}`);
        }
      });
    }
  }, [cards]);

  const [groupedCards, setGroupedCards] = useState<CardsByGroup>({});
  const [allGroups, setAllGroups] = useState<string[]>([]);
  const [sortOption, setSortOption] = useState<SortOption>("card-number");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  
  // Toggle group expansion
  const toggleGroup = (group: string) => {
    const newExpanded = new Set(expandedGroups);
    if (newExpanded.has(group)) {
      newExpanded.delete(group);
    } else {
      newExpanded.add(group);
    }
    setExpandedGroups(newExpanded);
  };
  
  // Process cards into groups with Year + Brand + Collection format
  useEffect(() => {
    if (!cards || cards.length === 0) return;
    
    const grouped: CardsByGroup = {};
    const groups: Set<string> = new Set();
    
    // Group cards by Year + Brand + Collection
    cards.forEach(card => {
      const year = card.year || 'Unknown Year';
      const brand = card.brand?.name || 'Unknown Brand';
      const collection = card.collection || 'Uncategorized';
      
      // Create group label in format: "2024 - Topps Stars of MLB"
      const groupKey = `${year} - ${brand} ${collection}`;
      groups.add(groupKey);
      
      if (!grouped[groupKey]) {
        grouped[groupKey] = [];
      }
      
      grouped[groupKey].push(card);
    });
    
    // Calculate card quantities for duplicates within each group
    Object.keys(grouped).forEach(groupKey => {
      // Create a map to track quantities
      const cardMap = new Map<string, { card: CardWithRelations, quantity: number }>();
      
      // Track cards by their unique identifiers
      grouped[groupKey].forEach(card => {
        // Create a unique identifier for each card (combination of attributes)
        const cardIdentifier = `${card.playerFirstName}_${card.playerLastName}_${card.cardNumber}_${card.variant || ''}_${card.year || ''}`;
        
        if (cardMap.has(cardIdentifier)) {
          // Increment quantity for existing card
          const existing = cardMap.get(cardIdentifier)!;
          existing.quantity += 1;
        } else {
          // Add new card to map
          cardMap.set(cardIdentifier, { card, quantity: 1 });
        }
      });
      
      // Replace the array with de-duplicated cards
      grouped[groupKey] = Array.from(cardMap.values()).map(item => ({
        ...item.card,
        quantity: item.quantity
      }));
    });
    
    // Sort groups by year (newest first), then alphabetically
    const sortedGroups = Array.from(groups).sort((a: string, b: string) => {
      // Extract year from group name (format: "2024 - Topps Stars of MLB")
      const yearA = parseInt(a.split(' - ')[0]) || 0;
      const yearB = parseInt(b.split(' - ')[0]) || 0;
      
      // Sort by year descending first
      if (yearB !== yearA) {
        return yearB - yearA;
      }
      
      // If years are equal, sort alphabetically
      return a.localeCompare(b);
    });
    
    // Apply sorting to each group
    Object.keys(grouped).forEach(group => {
      switch (sortOption) {
        case "newest":
          grouped[group].sort((a: CardWithRelations, b: CardWithRelations) => 
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          break;
        case "oldest":
          grouped[group].sort((a: CardWithRelations, b: CardWithRelations) => 
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          break;
        case "name-asc":
          grouped[group].sort((a: CardWithRelations, b: CardWithRelations) => 
            `${a.playerFirstName} ${a.playerLastName}`.localeCompare(`${b.playerFirstName} ${b.playerLastName}`));
          break;
        case "name-desc":
          grouped[group].sort((a: CardWithRelations, b: CardWithRelations) => 
            `${b.playerFirstName} ${b.playerLastName}`.localeCompare(`${a.playerFirstName} ${a.playerLastName}`));
          break;
        case "value-high":
          grouped[group].sort((a: CardWithRelations, b: CardWithRelations) => 
            Number(b.estimatedValue || 0) - Number(a.estimatedValue || 0));
          break;
        case "value-low":
          grouped[group].sort((a: CardWithRelations, b: CardWithRelations) => 
            Number(a.estimatedValue || 0) - Number(b.estimatedValue || 0));
          break;
        case "card-number":
          grouped[group].sort((a: CardWithRelations, b: CardWithRelations) => {
            // Helper function to parse complex card numbers like "89B-32" or "SMLB-27"
            const parseCardNumber = (cardNum: string) => {
              // First, try to split by dash (-) to handle formats like "89B-32"
              const parts = cardNum.split('-');
              
              // Extract prefix (everything before the dash) and number (after the dash)
              const prefix = parts.length > 1 ? parts[0] : '';
              const numberPart = parts.length > 1 ? parts[1] : cardNum;
              
              // Convert the number part to a number for correct numerical sorting
              const number = parseInt(numberPart);
              
              return { prefix, number, originalNumber: numberPart };
            };
            
            const cardA = parseCardNumber(a.cardNumber);
            const cardB = parseCardNumber(b.cardNumber);
            
            // First, sort by prefix (if they're different)
            if (cardA.prefix !== cardB.prefix) {
              return cardA.prefix.localeCompare(cardB.prefix);
            }
            
            // If prefixes are the same, sort by number part
            if (!isNaN(cardA.number) && !isNaN(cardB.number)) {
              return cardA.number - cardB.number;
            }
            
            // Fallback to original card number comparison if parsing failed
            return a.cardNumber.localeCompare(b.cardNumber);
          });
          break;
        default:
          break;
      }
    });
    
    setGroupedCards(grouped);
    setAllGroups(sortedGroups);
    
    // Auto-expand all groups when first loading
    if (expandedGroups.size === 0) {
      setExpandedGroups(new Set(sortedGroups));
    }
  }, [cards, sortOption, expandedGroups]);

  if (isLoading) {
    return (
      <div className="space-y-8">
        <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 mb-4 animate-pulse">
          <div className="h-8 bg-slate-200 rounded w-1/3 mb-2"></div>
          <div className="h-6 bg-slate-200 rounded w-1/4"></div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="rounded-lg overflow-hidden border border-slate-200 bg-white animate-pulse">
              <div className="aspect-w-2 aspect-h-3 bg-slate-200"></div>
              <div className="p-3">
                <div className="h-4 bg-slate-200 rounded mb-2"></div>
                <div className="h-3 bg-slate-200 rounded w-2/3 mb-2"></div>
                <div className="flex justify-between items-center mt-2">
                  <div className="h-3 bg-slate-200 rounded w-1/4"></div>
                  <div className="h-3 bg-slate-200 rounded w-1/6"></div>
                </div>
              </div>
            </div>
          ))}
        </div>
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

  const sortOptions = [
    { value: "newest", label: "Newest First" },
    { value: "oldest", label: "Oldest First" },
    { value: "name-asc", label: "Name (A-Z)" },
    { value: "name-desc", label: "Name (Z-A)" },
    { value: "value-high", label: "Value (High-Low)" },
    { value: "value-low", label: "Value (Low-High)" },
    { value: "card-number", label: "Card Number" },
  ];

  return (
    <div className="space-y-8 mb-20">
      {/* Sort and filter controls */}
      <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 mb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <SortDesc className="h-5 w-5 text-slate-500 mr-2" />
            <span className="text-sm font-medium text-slate-700">Sort by:</span>
          </div>
          
          <Select value={sortOption} onValueChange={(value) => setSortOption(value as SortOption)}>
            <SelectTrigger className="w-[180px] h-8 text-sm bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sortOptions.map(option => (
                <SelectItem key={option.value} value={option.value} className="text-sm">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        
        <div className="mt-2 text-xs text-slate-500 flex items-center">
          <Filter className="h-3 w-3 mr-1" />
          <span>Displaying {cards.length} cards in {allGroups.length} groups</span>
        </div>
      </div>
      
      {/* Card Groups (Year + Brand + Collection) */}
      <div className="space-y-4">
        {allGroups.map(group => (
          <div 
            key={group} 
            className="border border-slate-200 rounded-lg overflow-hidden bg-white"
          >
            <button 
              className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors"
              onClick={() => toggleGroup(group)}
            >
              <div className="flex items-center">
                <h2 className="text-lg font-bold text-slate-800">{group}</h2>
                <span className="ml-2 bg-slate-200 text-slate-700 text-xs font-medium px-2 py-1 rounded-full">
                  {groupedCards[group]?.length || 0}
                </span>
              </div>
              
              {expandedGroups.has(group) ? (
                <ChevronUp className="h-5 w-5 text-slate-500" />
              ) : (
                <ChevronDown className="h-5 w-5 text-slate-500" />
              )}
            </button>
            
            {expandedGroups.has(group) && (
              <div className="p-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                  {groupedCards[group]?.map((card) => (
                    <CardItem 
                      key={card.id} 
                      card={card} 
                      quantity={(card as any).quantity || 1} 
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
