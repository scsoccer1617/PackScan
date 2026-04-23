import { useState, useEffect } from "react";
import { Search, Sparkles, ScanLine } from "lucide-react";
import { Link } from "wouter";
import EbayPriceResults from "@/components/EbayPriceResults";
import { CardFormValues } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/**
 * Redesigned Manual Lookup page (`/search`).
 *
 * Feature is unchanged — enter card details, get an eBay price — but the
 * form is visually aligned with the rest of the redesign: `font-display`
 * header, rounded-2xl card, labeled rounded inputs, foil-violet CTA,
 * and a "Suggestions" row of popular brand/year combos that mirrors the
 * prototype's trending list.
 */

interface ParallelOption {
  variationOrParallel: string;
  serialNumber: string | null;
}

// Handy one-tap fill-ins; mirrors the prototype's Trending list but
// seeded with real brand/year pairs users most often look up.
const SUGGESTIONS: { label: string; year: string; brand: string }[] = [
  { label: "2024 Topps Chrome", year: "2024", brand: "Topps Chrome" },
  { label: "2024 Bowman Chrome", year: "2024", brand: "Bowman Chrome" },
  { label: "2024 Topps Series 1", year: "2024", brand: "Topps" },
  { label: "2023 Panini Prizm", year: "2023", brand: "Panini Prizm" },
  { label: "2025 Topps Chrome", year: "2025", brand: "Topps Chrome" },
];

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
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setBrands(data); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const params = brand ? `?brand=${encodeURIComponent(brand)}` : "";
    fetch(`/api/card-database/collections${params}`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setCollections(data); })
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
      .then((r) => r.json())
      .then((data) => {
        if (data?.options && Array.isArray(data.options)) setParallelOptions(data.options);
        else setParallelOptions([]);
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
        const selectedParallel = parallelOptions.find((p) => p.variationOrParallel === effectiveVariant);
        const cardDataWithParallel = {
          ...result.cardData,
          variant: effectiveVariant || result.cardData.variant || "",
          foilType: effectiveVariant || result.cardData.foilType || "",
          isNumbered: !!selectedParallel?.serialNumber || result.cardData.isNumbered,
          serialNumber: selectedParallel?.serialNumber
            ? `/${selectedParallel.serialNumber.replace(/\//g, "")}`
            : result.cardData.serialNumber || "",
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

  const applySuggestion = (s: (typeof SUGGESTIONS)[number]) => {
    setYear(s.year);
    setBrand(s.brand);
    setCollection("");
    setVariant("");
  };

  const canSearch = !!(brand && year);

  return (
    <div className="pt-4 pb-10 space-y-5">
      {/* Header */}
      <div className="px-4">
        <h1 className="font-display text-[22px] font-semibold tracking-tight">Manual lookup</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Type a card's details to see live eBay comps — no scan needed.
        </p>
      </div>

      {cardData ? (
        /* Results view */
        <div className="px-4 space-y-4">
          {searchSource === "card_database" && (
            <div className="text-sm rounded-2xl border border-foil-green/25 bg-foil-green/10 text-foil-green px-3 py-2.5 flex items-center gap-2">
              <Sparkles className="w-4 h-4 shrink-0" />
              <span>Card found — player and details filled in automatically.</span>
            </div>
          )}

          <EbayPriceResults
            cardData={cardData}
            onCardDataUpdate={(updatedData) => setCardData({ ...updatedData })}
          />

          <button
            onClick={handleReset}
            className="w-full h-11 rounded-xl border border-card-border bg-card text-sm font-medium hover-elevate"
            data-testid="button-search-another"
          >
            Search another card
          </button>
        </div>
      ) : (
        <>
          {/* Form card */}
          <div className="mx-4 rounded-2xl bg-card border border-card-border p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Year" required>
                <input
                  inputMode="numeric"
                  placeholder="2024"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className={inputCls}
                  data-testid="input-year"
                />
              </Field>
              <Field label="Card #">
                <input
                  placeholder="316, T91-13…"
                  value={cardNumber}
                  onChange={(e) => setCardNumber(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className={inputCls}
                  data-testid="input-card-number"
                />
              </Field>
            </div>

            <Field label="Brand" required>
              <input
                list="search-brands-list"
                placeholder="Topps, Bowman, Panini…"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                onKeyDown={handleKeyDown}
                className={inputCls}
                data-testid="input-brand"
              />
              <datalist id="search-brands-list">
                {brands.map((b) => <option key={b} value={b} />)}
              </datalist>
            </Field>

            <Field label="Collection">
              <input
                list="search-collections-list"
                placeholder={brand ? "Select or type a collection…" : "Enter a brand first for suggestions"}
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
                onKeyDown={handleKeyDown}
                className={inputCls}
                data-testid="input-collection"
              />
              <datalist id="search-collections-list">
                {collections.map((c) => <option key={c} value={c} />)}
              </datalist>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="First name">
                <input
                  placeholder="Mike"
                  value={playerFirstName}
                  onChange={(e) => setPlayerFirstName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className={inputCls}
                  data-testid="input-first-name"
                />
              </Field>
              <Field label="Last name">
                <input
                  placeholder="Trout"
                  value={playerLastName}
                  onChange={(e) => setPlayerLastName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className={inputCls}
                  data-testid="input-last-name"
                />
              </Field>
            </div>

            <Field label="Parallel" optional>
              {parallelOptions.length > 0 ? (
                <select
                  value={variant}
                  onChange={(e) => setVariant(e.target.value)}
                  className={cn(inputCls, "appearance-none bg-no-repeat bg-[right_0.75rem_center] pr-9")}
                  style={{
                    backgroundImage:
                      "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
                  }}
                  data-testid="select-variant"
                >
                  <option value="">Base card (no parallel)</option>
                  <option value="__none__">Base card (no parallel)</option>
                  {parallelOptions.map((p) => (
                    <option key={p.variationOrParallel} value={p.variationOrParallel}>
                      {p.variationOrParallel}
                      {p.serialNumber ? ` /${p.serialNumber.replace(/\//g, "")}` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  placeholder={
                    loadingParallels
                      ? "Loading parallels…"
                      : brand && year
                      ? "No parallels found — type manually"
                      : "Enter brand & year for options"
                  }
                  value={variant}
                  onChange={(e) => setVariant(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className={inputCls}
                  data-testid="input-variant"
                />
              )}
            </Field>

            <button
              onClick={handleSearch}
              disabled={searching || !canSearch}
              className={cn(
                "mt-1 w-full h-11 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-opacity",
                canSearch && !searching
                  ? "bg-foil-violet text-white hover-elevate"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              )}
              data-testid="button-search"
            >
              {searching ? (
                <>
                  <span className="inline-block w-4 h-4 rounded-full border-2 border-current border-r-transparent animate-spin" />
                  Searching…
                </>
              ) : (
                <>
                  <Search className="w-4 h-4" />
                  Get card value
                </>
              )}
            </button>
          </div>

          {/* Suggestions */}
          <section className="px-4">
            <div className="flex items-center gap-1.5 mb-2">
              <Sparkles className="w-3.5 h-3.5 text-foil-violet" />
              <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Popular lookups
              </h2>
            </div>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => applySuggestion(s)}
                  className="h-8 px-3 rounded-full bg-card border border-card-border text-[12px] font-medium hover-elevate"
                  data-testid={`chip-suggestion-${s.label.replace(/\s+/g, "-").toLowerCase()}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </section>

          {/* Scan upsell */}
          <section className="mx-4 rounded-2xl bg-muted/50 p-4 text-center">
            <p className="text-sm font-medium">Faster to scan it</p>
            <p className="text-[12px] text-muted-foreground mt-1 mb-3">
              Point your camera at the card — grade and price in seconds.
            </p>
            <Link
              href="/scan"
              className="inline-flex h-10 px-4 rounded-xl bg-foil-violet text-white text-sm font-medium items-center gap-1.5 hover-elevate"
              data-testid="link-open-scanner"
            >
              <ScanLine className="w-4 h-4" />
              Open scanner
            </Link>
          </section>
        </>
      )}
    </div>
  );
}

const inputCls =
  "w-full h-11 rounded-xl bg-background border border-card-border px-3 text-sm outline-none focus:ring-2 focus:ring-foil-violet/30 placeholder:text-muted-foreground";

function Field({
  label,
  required,
  optional,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
        {label}
        {required && <span className="text-foil-red/80 ml-0.5">*</span>}
        {optional && <span className="text-muted-foreground/60 ml-1 normal-case tracking-normal">(optional)</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
