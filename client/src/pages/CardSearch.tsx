import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Search } from "lucide-react";
import EbayPriceResults from "@/components/EbayPriceResults";
import { CardFormValues } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

export default function CardSearch() {
  const [year, setYear] = useState("");
  const [brand, setBrand] = useState("");
  const [collection, setCollection] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [playerFirstName, setPlayerFirstName] = useState("");
  const [playerLastName, setPlayerLastName] = useState("");
  const [variant, setVariant] = useState("");

  const [brands, setBrands] = useState<string[]>([]);
  const [collections, setCollections] = useState<string[]>([]);

  const [searching, setSearching] = useState(false);
  const [cardData, setCardData] = useState<Partial<CardFormValues> | null>(null);
  const [searchSource, setSearchSource] = useState<string>("");

  const { toast } = useToast();

  useEffect(() => {
    fetch("/api/card-database/brands")
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setBrands(data); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const params = brand ? `?brand=${encodeURIComponent(brand)}` : "";
    fetch(`/api/card-database/collections${params}`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setCollections(data); })
      .catch(() => {});
  }, [brand]);

  const handleSearch = async () => {
    if (!brand && !playerLastName && !cardNumber) {
      toast({
        title: "More info needed",
        description: "Enter at least a brand, card number, or player name.",
        variant: "destructive",
      });
      return;
    }

    setSearching(true);
    setCardData(null);

    try {
      const params = new URLSearchParams();
      if (year) params.set("year", year);
      if (brand) params.set("brand", brand);
      if (collection) params.set("collection", collection);
      if (cardNumber) params.set("cardNumber", cardNumber);
      if (variant) params.set("variant", variant);
      if (playerFirstName) params.set("playerFirstName", playerFirstName);
      if (playerLastName) params.set("playerLastName", playerLastName);

      const response = await fetch(`/api/card-search?${params}`);
      if (!response.ok) throw new Error("Search request failed");
      const result = await response.json();

      if (result.cardData) {
        setCardData({ ...result.cardData });
        setSearchSource(result.source);
        if (!result.found) {
          toast({
            title: "No database match",
            description: "Card not found in database. Searching eBay with your inputs.",
          });
        }
      }
    } catch {
      toast({
        title: "Search failed",
        description: "Could not complete the search. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSearching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  const handleReset = () => {
    setCardData(null);
    setSearchSource("");
  };

  const canSearch = !!(brand || playerLastName || cardNumber);

  return (
    <div className="p-4 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            Find Card Value
          </CardTitle>
          <p className="text-sm text-gray-500">
            Enter what you know — brand, year, card number, or player name — to look up market value.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="s-year">Year</Label>
              <Input
                id="s-year"
                type="number"
                placeholder="2024"
                value={year}
                onChange={e => setYear(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
            <div>
              <Label htmlFor="s-cardNumber">Card #</Label>
              <Input
                id="s-cardNumber"
                placeholder="316, T91-13…"
                value={cardNumber}
                onChange={e => setCardNumber(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="s-brand">Brand</Label>
            <Input
              id="s-brand"
              list="search-brands-list"
              placeholder="Topps, Bowman, Panini…"
              value={brand}
              onChange={e => setBrand(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <datalist id="search-brands-list">
              {brands.map(b => (
                <option key={b} value={b} />
              ))}
            </datalist>
          </div>

          <div>
            <Label htmlFor="s-collection">Collection</Label>
            <Input
              id="s-collection"
              list="search-collections-list"
              placeholder={brand ? "Select or type a collection…" : "Enter a brand first for suggestions"}
              value={collection}
              onChange={e => setCollection(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <datalist id="search-collections-list">
              {collections.map(c => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="s-firstName">First Name</Label>
              <Input
                id="s-firstName"
                placeholder="Mike"
                value={playerFirstName}
                onChange={e => setPlayerFirstName(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
            <div>
              <Label htmlFor="s-lastName">Last Name</Label>
              <Input
                id="s-lastName"
                placeholder="Trout"
                value={playerLastName}
                onChange={e => setPlayerLastName(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="s-variant">Variant / Parallel <span className="text-gray-400 font-normal">(optional)</span></Label>
            <Input
              id="s-variant"
              placeholder="Gold Refractor, Sky Blue…"
              value={variant}
              onChange={e => setVariant(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>

          <Button
            onClick={handleSearch}
            disabled={searching || !canSearch}
            className="w-full"
            size="lg"
          >
            {searching ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                Searching…
              </>
            ) : (
              <>
                <Search className="h-4 w-4 mr-2" />
                Get Card Value
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {cardData && (
        <div className="space-y-4">
          {searchSource === "card_database" && (
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">
              Card found in database — player name and details filled automatically.
            </div>
          )}

          <EbayPriceResults
            cardData={cardData}
            onCardDataUpdate={updatedData => setCardData({ ...updatedData })}
          />

          <Button onClick={handleReset} variant="outline" className="w-full">
            Search Another Card
          </Button>
        </div>
      )}
    </div>
  );
}
