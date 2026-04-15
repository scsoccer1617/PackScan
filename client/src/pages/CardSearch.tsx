import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search } from "lucide-react";
import EbayPriceResults from "@/components/EbayPriceResults";
import { CardFormValues } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

interface ParallelOption {
  variationOrParallel: string;
  serialNumber: string | null;
}

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
  const [parallelOptions, setParallelOptions] = useState<ParallelOption[]>([]);
  const [loadingParallels, setLoadingParallels] = useState(false);

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

  useEffect(() => {
    if (!brand || !year) {
      setParallelOptions([]);
      return;
    }
    setLoadingParallels(true);
    const params = new URLSearchParams({ brand, year });
    if (collection) params.set("collection", collection);
    fetch(`/api/card-variations/options?${params}`)
      .then(r => r.json())
      .then(data => {
        if (data?.options && Array.isArray(data.options)) {
          setParallelOptions(data.options);
        } else {
          setParallelOptions([]);
        }
      })
      .catch(() => setParallelOptions([]))
      .finally(() => setLoadingParallels(false));
  }, [brand, year, collection]);

  const handleSearch = async () => {
    if (!(brand && year)) {
      toast({
        title: "More info needed",
        description: "Brand and year are required to look up pricing.",
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
      const effectiveVariant = variant === "__none__" ? "" : variant;
      if (effectiveVariant) params.set("variant", effectiveVariant);
      if (playerFirstName) params.set("playerFirstName", playerFirstName);
      if (playerLastName) params.set("playerLastName", playerLastName);

      const response = await fetch(`/api/card-search?${params}`);
      if (!response.ok) throw new Error("Search request failed");
      const result = await response.json();

      if (result.cardData) {
        const selectedParallel = parallelOptions.find(p => p.variationOrParallel === effectiveVariant);
        const cardDataWithParallel = {
          ...result.cardData,
          variant: effectiveVariant || result.cardData.variant || '',
          foilType: effectiveVariant || result.cardData.foilType || '',
          isNumbered: !!(selectedParallel?.serialNumber) || result.cardData.isNumbered,
          serialNumber: selectedParallel?.serialNumber
            ? `/${selectedParallel.serialNumber.replace(/\//g, '')}`
            : result.cardData.serialNumber || '',
        };
        setCardData(cardDataWithParallel);
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

  const canSearch = !!(brand && year);

  return (
    <div className="p-4 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            Find Card Value
          </CardTitle>
          <p className="text-sm text-gray-500">
            Brand and year are required. Add card number or player name for a more precise result.
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
            <Label htmlFor="s-variant">Parallel <span className="text-gray-400 font-normal">(optional)</span></Label>
            {parallelOptions.length > 0 ? (
              <Select value={variant} onValueChange={setVariant}>
                <SelectTrigger id="s-variant">
                  <SelectValue placeholder="Base card (no parallel)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Base card (no parallel)</SelectItem>
                  {parallelOptions.map(p => (
                    <SelectItem key={p.variationOrParallel} value={p.variationOrParallel}>
                      {p.variationOrParallel}{p.serialNumber ? ` /${p.serialNumber.replace(/\//g, '')}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="s-variant"
                placeholder={loadingParallels ? "Loading parallels…" : brand && year ? "No parallels found — type manually" : "Enter brand & year for options"}
                value={variant}
                onChange={e => setVariant(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            )}
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
