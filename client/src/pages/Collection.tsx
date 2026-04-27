import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Search as SearchIcon,
  Filter as FilterIcon,
  LayoutGrid,
  List as ListIcon,
  Mic,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatSeasonYear } from "@/lib/seasonYear";
import type { CardWithRelations } from "@shared/schema";
import EditCardModal from "@/components/EditCardModal";

/**
 * Redesigned Collection page.
 *
 * Visual direction follows the redesign prototype (packscan-redesign):
 *   - Page header with card count + total value summary.
 *   - Grid / list view toggle.
 *   - Search + filter chip row.
 *   - Grid tiles with foil-tone grade chips, list rows with inline grade.
 *
 * Data comes from the same endpoints the old CardGrid used — no backend
 * work needed:
 *   /api/cards               → array of user-saved cards (CardWithRelations).
 *   /api/scan-grades?limit=… → recent Holo grades, joined by card id so
 *                              each saved card shows its latest grade.
 *
 * Each tile is a tap target that opens the existing EditCardModal (which
 * supports delete), preserving the original edit/delete flow without
 * sprinkling extra buttons on top of every tile.
 */

type CollectionSummary = { cardCount: number; totalValue: number };

type ScanGrade = {
  id: number;
  cardId?: number | null;
  overall: number;
  label: string;
  /** Sentinel `"none"` marks rows inserted when auto-grade was off. */
  model: string;
  createdAt: string | Date;
};

type ScanGradesResponse = {
  success: boolean;
  grades: ScanGrade[];
};

type FilterKey = "all" | "baseball" | "basketball" | "football" | "rookies" | "numbered";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "baseball", label: "Baseball" },
  { key: "basketball", label: "Basketball" },
  { key: "football", label: "Football" },
  { key: "rookies", label: "Rookies" },
  { key: "numbered", label: "Numbered" },
];

function money(n: number, fractionDigits = 0) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(n);
}

function gradeTone(n: number): { bg: string; text: string; ring: string } {
  if (n >= 9.5) return { bg: "bg-foil-gold/10", text: "text-foil-gold", ring: "ring-foil-gold/30" };
  if (n >= 9) return { bg: "bg-foil-cyan/10", text: "text-foil-cyan", ring: "ring-foil-cyan/30" };
  if (n >= 8) return { bg: "bg-foil-green/10", text: "text-foil-green", ring: "ring-foil-green/30" };
  if (n >= 6) return { bg: "bg-foil-amber/10", text: "text-foil-amber", ring: "ring-foil-amber/30" };
  return { bg: "bg-foil-red/10", text: "text-foil-red", ring: "ring-foil-red/30" };
}

function brandName(card: CardWithRelations): string {
  return card.brand?.name ?? "";
}

function sportName(card: CardWithRelations): string {
  return card.sport?.name ?? "";
}

function parallelLabel(card: CardWithRelations): string {
  const serial = card.serialNumber ? ` /${card.serialNumber.replace(/^\//, "")}` : "";
  if (card.variant && card.variant.trim()) return `${card.variant}${serial}`;
  if (card.collection && card.collection.trim() && card.collection.toLowerCase() !== "base set") {
    return `${card.collection}${serial}`;
  }
  return serial ? `Base${serial}` : "Base";
}

function estValue(card: CardWithRelations): number {
  return card.estimatedValue ? Number(card.estimatedValue) : 0;
}

function matchesFilter(card: CardWithRelations, key: FilterKey): boolean {
  if (key === "all") return true;
  if (key === "rookies") return !!card.isRookieCard;
  if (key === "numbered") return !!card.isNumbered || !!card.serialNumber;
  const sport = sportName(card).toLowerCase();
  if (key === "baseball") return sport.includes("baseball");
  if (key === "basketball") return sport.includes("basketball");
  if (key === "football") return sport.includes("football");
  return true;
}

function matchesQuery(card: CardWithRelations, q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    card.playerFirstName,
    card.playerLastName,
    `${card.playerFirstName} ${card.playerLastName}`,
    card.year?.toString(),
    brandName(card),
    card.collection,
    card.variant,
    card.cardNumber,
    card.serialNumber,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export default function Collection() {
  const [view, setView] = useState<"grid" | "list">("grid");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<CardWithRelations | null>(null);

  const { data: cards, isLoading } = useQuery<CardWithRelations[]>({
    queryKey: ["/api/cards"],
  });

  const { data: summary } = useQuery<CollectionSummary>({
    queryKey: ["/api/collection/summary"],
  });

  const { data: scanGrades } = useQuery<ScanGradesResponse>({
    queryKey: ["/api/scan-grades", { limit: 100 }],
    queryFn: async () => {
      const res = await fetch("/api/scan-grades?limit=100");
      if (!res.ok) throw new Error("Failed to load scans");
      return res.json();
    },
  });

  // Map of cardId → latest overall grade, taking the most recent per card.
  // Skip ungraded placeholder rows (model='none' / label='UNGRADED') — those
  // exist so Recent Scans can show scan activity when auto-grade is off, but
  // they carry no real grade and would stamp a bogus "0.0" pill on tiles.
  const gradesByCardId = useMemo(() => {
    const out = new Map<number, number>();
    const list = scanGrades?.grades ?? [];
    for (const g of list) {
      if (!g.cardId) continue;
      if (g.model === "none" || g.label === "UNGRADED") continue;
      // First occurrence wins because /api/scan-grades returns newest-first.
      if (!out.has(g.cardId)) out.set(g.cardId, g.overall);
    }
    return out;
  }, [scanGrades]);

  const filtered = useMemo(() => {
    const list = cards ?? [];
    return list.filter((c) => matchesFilter(c, filter) && matchesQuery(c, query));
  }, [cards, filter, query]);

  const totalCards = summary?.cardCount ?? cards?.length ?? 0;
  const totalValue = summary?.totalValue ?? 0;

  return (
    <div className="pt-4 pb-6 space-y-4">
      {/* Header */}
      <div className="px-4 flex items-end justify-between">
        <div>
          <h1 className="font-display text-[22px] font-semibold tracking-tight">Collection</h1>
          <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-collection-summary">
            {totalCards.toLocaleString()} {totalCards === 1 ? "card" : "cards"} · {money(totalValue)}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setView("grid")}
            className={cn(
              "w-9 h-9 rounded-lg flex items-center justify-center transition",
              view === "grid" ? "bg-muted text-foreground" : "text-muted-foreground hover-elevate"
            )}
            aria-label="Grid view"
            aria-pressed={view === "grid"}
            data-testid="button-view-grid"
          >
            <LayoutGrid className="w-[18px] h-[18px]" />
          </button>
          <button
            type="button"
            onClick={() => setView("list")}
            className={cn(
              "w-9 h-9 rounded-lg flex items-center justify-center transition",
              view === "list" ? "bg-muted text-foreground" : "text-muted-foreground hover-elevate"
            )}
            aria-label="List view"
            aria-pressed={view === "list"}
            data-testid="button-view-list"
          >
            <ListIcon className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-4">
        <label className="flex items-center gap-2 rounded-xl bg-card border border-card-border px-3 h-11">
          <SearchIcon className="w-4 h-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your collection"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
            data-testid="input-collection-search"
          />
          <FilterIcon className="w-4 h-4 text-muted-foreground" />
        </label>
      </div>

      {/* Filter chips */}
      <div className="flex gap-2 overflow-x-auto px-4 no-scrollbar">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "shrink-0 h-8 px-3 rounded-full text-xs font-medium border transition",
                active
                  ? "bg-foreground text-background border-foreground"
                  : "bg-card border-card-border text-muted-foreground hover-elevate"
              )}
              aria-pressed={active}
              data-testid={`filter-${f.key}`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 px-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="bg-card border border-card-border rounded-2xl overflow-hidden animate-pulse"
            >
              <div className="aspect-[3/4] bg-muted" />
              <div className="p-2.5 space-y-1.5">
                <div className="h-3 w-2/3 bg-muted rounded" />
                <div className="h-2.5 w-1/2 bg-muted rounded" />
                <div className="h-3 w-1/3 bg-muted rounded mt-1" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState hasCards={(cards?.length ?? 0) > 0} />
      ) : view === "grid" ? (
        <div className="grid grid-cols-2 gap-3 px-4">
          {filtered.map((card) => (
            <CollectionGridTile
              key={card.id}
              card={card}
              grade={gradesByCardId.get(card.id)}
              // Sheet-backed rows have string ids (e.g. "sheetId-4"); edit-by-tap is a follow-up.
              onOpen={() => { if (typeof card.id === "number") setEditing(card); }}
            />
          ))}
        </div>
      ) : (
        <div className="px-4 space-y-2">
          {filtered.map((card) => (
            <CollectionListRow
              key={card.id}
              card={card}
              grade={gradesByCardId.get(card.id)}
              // Sheet-backed rows have string ids (e.g. "sheetId-4"); edit-by-tap is a follow-up.
              onOpen={() => { if (typeof card.id === "number") setEditing(card); }}
            />
          ))}
        </div>
      )}

      {editing ? (
        <EditCardModal
          isOpen={true}
          onClose={() => setEditing(null)}
          card={editing}
        />
      ) : null}
    </div>
  );
}

function CollectionGridTile({
  card,
  grade,
  onOpen,
}: {
  card: CardWithRelations;
  grade: number | undefined;
  onOpen: () => void;
}) {
  const tone = typeof grade === "number" ? gradeTone(grade) : null;
  const value = estValue(card);
  const front = card.frontImage || undefined;
  // Voice-added cards never have a front OR back image stored. We detect
  // them by the absence of both (rather than reading a schema flag that
  // doesn't exist) and show a friendlier mic-icon placeholder.
  const isVoiceAdded = !card.frontImage && !card.backImage;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left bg-card border border-card-border rounded-2xl overflow-hidden hover-elevate"
      data-testid={`card-collection-${card.id}`}
    >
      <div className="aspect-[3/4] bg-muted relative overflow-hidden">
        {front ? (
          <img
            src={front}
            alt={`${card.playerFirstName} ${card.playerLastName}`}
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : isVoiceAdded ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-muted-foreground"
            data-testid={`voice-fallback-${card.id}`}
          >
            <Mic className="w-5 h-5" strokeWidth={1.75} />
            <span className="text-[11px] font-medium">Added by voice</span>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-xs">
            No image
          </div>
        )}
        {tone ? (
          <span
            className={cn(
              "absolute top-2 right-2 px-2 py-0.5 rounded-full text-[11px] font-semibold ring-1 backdrop-blur",
              tone.bg,
              tone.text,
              tone.ring
            )}
            data-testid={`grade-chip-${card.id}`}
          >
            {grade!.toFixed(1)}
          </span>
        ) : null}
      </div>
      <div className="p-2.5">
        <p className="text-[13px] font-medium leading-tight truncate">
          {card.playerFirstName} {card.playerLastName}
        </p>
        <p className="text-[11px] text-muted-foreground truncate">
          {formatSeasonYear(card.year, sportName(card)) ?? card.year} {brandName(card) || "Unknown brand"}
        </p>
        <p className="text-[13px] font-display font-semibold mt-1.5">
          {value > 0 ? money(value, 2) : <span className="text-muted-foreground font-sans font-normal">—</span>}
        </p>
      </div>
    </button>
  );
}

function CollectionListRow({
  card,
  grade,
  onOpen,
}: {
  card: CardWithRelations;
  grade: number | undefined;
  onOpen: () => void;
}) {
  const tone = typeof grade === "number" ? gradeTone(grade) : null;
  const value = estValue(card);
  const front = card.frontImage || undefined;
  const isVoiceAdded = !card.frontImage && !card.backImage;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left flex items-center gap-3 p-2.5 rounded-2xl bg-card border border-card-border hover-elevate"
      data-testid={`row-collection-${card.id}`}
    >
      {front ? (
        <img
          src={front}
          alt={`${card.playerFirstName} ${card.playerLastName}`}
          loading="lazy"
          className="w-12 h-16 rounded-md object-cover border border-card-border bg-muted"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
          }}
        />
      ) : isVoiceAdded ? (
        <div
          className="w-12 h-16 rounded-md border border-card-border bg-muted flex items-center justify-center text-muted-foreground"
          data-testid={`voice-fallback-row-${card.id}`}
          aria-label="Added by voice"
        >
          <Mic className="w-4 h-4" strokeWidth={1.75} />
        </div>
      ) : (
        <div className="w-12 h-16 rounded-md border border-card-border bg-muted" aria-hidden />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-tight truncate">
          {card.playerFirstName} {card.playerLastName}
        </p>
        <p className="text-[11px] text-muted-foreground truncate">
          {formatSeasonYear(card.year, sportName(card)) ?? card.year} {brandName(card)} · {parallelLabel(card)}
        </p>
      </div>
      <div className="text-right">
        {tone ? (
          <span
            className={cn(
              "inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ring-1",
              tone.bg,
              tone.text,
              tone.ring
            )}
            data-testid={`grade-chip-${card.id}`}
          >
            {grade!.toFixed(1)}
          </span>
        ) : null}
        <p className="font-display text-sm font-semibold mt-1">
          {value > 0 ? money(value, 2) : <span className="text-muted-foreground font-sans font-normal">—</span>}
        </p>
      </div>
    </button>
  );
}

function EmptyState({ hasCards }: { hasCards: boolean }) {
  return (
    <div className="mx-4 mt-6 rounded-2xl border border-dashed border-card-border bg-card p-8 text-center">
      <p className="font-display text-lg font-semibold tracking-tight">
        {hasCards ? "No matches" : "Your collection is empty"}
      </p>
      <p className="text-sm text-muted-foreground mt-1">
        {hasCards
          ? "Try a different filter or clear your search."
          : "Scan a card to save it to your collection."}
      </p>
    </div>
  );
}
