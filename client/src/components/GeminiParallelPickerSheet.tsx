// Gemini-authority parallel picker (PR #162).
//
// Replaces the variationsDB-filtered dropdown picker with a two-step,
// pass-through flow that trusts Gemini's emitted parallel verbatim:
//
//   STEP 1 — confirmation card:
//     "Potential parallel detected: <geminiParallel>" → [Yes] [No]
//     - Yes: keep Gemini's value, jump to STEP 2.
//     - No: show a free-text input (placeholder "Type parallel name, or
//       leave blank for base"), then jump to STEP 2 with the user's value.
//     - When Gemini returned no parallel, STEP 1 is skipped entirely and
//       the free-text input is the first thing the user sees.
//
//   STEP 2 — eBay results:
//     "Searching as: <query>" plus an editable input the user can rerun.
//     Two tabs: Active listings + Sold/completed (Sold is best-effort —
//     when the eBay API doesn't expose completed listings under the
//     current credential scope the tab renders a "not available" notice).
//
// No variationsDB filtering anywhere. No "Which X parallel" dropdown. No
// autocomplete chips. Gemini-or-freetext, end of story.

import { useEffect, useMemo, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Search, Sparkles } from "lucide-react";

export interface PickerListing {
  title: string;
  price: number;
  currency: string;
  url: string;
  imageUrl: string;
  condition: string;
}

export interface GeminiPickerQueryParts {
  year?: number | string | null;
  brand?: string | null;
  set?: string | null;
  cardNumber?: string | null;
  player?: string | null;
  parallel?: string | null;
}

interface Props {
  open: boolean;
  /** Gemini's emitted parallel name. Null/empty → skip STEP 1 and prompt
   *  for free-text immediately. */
  geminiParallel: string | null;
  /** Card-identity preview rendered in the sheet header. */
  cardDescription: string;
  /** Pre-built query parts for the eBay search (PR #162). The picker
   *  builds the canonical query string from these and lets the user edit
   *  it inline before re-running. */
  queryParts: GeminiPickerQueryParts;
  /** Called once the user has confirmed (or freetext-typed) a parallel.
   *  Empty string ⇒ "no parallel / base". The parent persists this onto
   *  cardData.foilType. */
  onConfirm: (parallel: string) => void;
}

function buildQuery(parts: GeminiPickerQueryParts): string {
  const segments: string[] = [];
  if (parts.year != null && String(parts.year).trim()) {
    segments.push(String(parts.year).trim());
  }
  if (parts.brand && parts.brand.trim()) segments.push(parts.brand.trim());
  if (parts.set && parts.set.trim()) segments.push(parts.set.trim());
  if (parts.cardNumber && String(parts.cardNumber).trim()) {
    const num = String(parts.cardNumber).trim();
    segments.push(num.startsWith("#") ? num : `#${num}`);
  }
  if (parts.player && parts.player.trim()) segments.push(parts.player.trim());
  if (parts.parallel && parts.parallel.trim()) segments.push(parts.parallel.trim());
  return segments.join(" ").replace(/\s{2,}/g, " ").trim();
}

type Stage = "confirm" | "freetext" | "results";

export default function GeminiParallelPickerSheet({
  open,
  geminiParallel,
  cardDescription,
  queryParts,
  onConfirm,
}: Props) {
  const initialStage: Stage = geminiParallel && geminiParallel.trim() ? "confirm" : "freetext";
  const [stage, setStage] = useState<Stage>(initialStage);
  // Whatever the user has chosen (Gemini-confirmed or freetext-typed). Empty
  // string is meaningful: "base / no parallel".
  const [chosenParallel, setChosenParallel] = useState<string>("");
  const [freetext, setFreetext] = useState<string>("");
  const [editableQuery, setEditableQuery] = useState<string>("");
  const [active, setActive] = useState<PickerListing[]>([]);
  const [sold, setSold] = useState<PickerListing[]>([]);
  const [soldAvailable, setSoldAvailable] = useState<boolean>(false);
  const [searching, setSearching] = useState<boolean>(false);

  // Reset internal state every time the sheet opens with a new card.
  useEffect(() => {
    if (open) {
      setStage(geminiParallel && geminiParallel.trim() ? "confirm" : "freetext");
      setChosenParallel("");
      setFreetext("");
      setActive([]);
      setSold([]);
      setSoldAvailable(false);
      setSearching(false);
    }
  }, [open, geminiParallel]);

  const baseQueryWithoutParallel = useMemo(
    () => buildQuery({ ...queryParts, parallel: null }),
    [queryParts],
  );

  const runEbaySearch = async (queryString: string) => {
    setSearching(true);
    try {
      const res = await fetch("/api/picker/ebay-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: queryString, limit: 10 }),
      });
      const data = await res.json();
      setActive(Array.isArray(data?.active) ? data.active : []);
      setSold(Array.isArray(data?.sold) ? data.sold : []);
      setSoldAvailable(!!data?.soldAvailable);
    } catch {
      setActive([]);
      setSold([]);
      setSoldAvailable(false);
    } finally {
      setSearching(false);
    }
  };

  const goToResults = (parallel: string) => {
    setChosenParallel(parallel);
    const q = buildQuery({ ...queryParts, parallel: parallel || null });
    setEditableQuery(q);
    setStage("results");
    void runEbaySearch(q);
  };

  const handleYes = () => {
    goToResults((geminiParallel ?? "").trim());
  };

  const handleNo = () => {
    setStage("freetext");
  };

  const handleFreetextSubmit = () => {
    const trimmed = freetext.trim().slice(0, 100);
    goToResults(trimmed);
  };

  const handleRerun = () => {
    void runEbaySearch(editableQuery);
  };

  const handleSaveAndClose = () => {
    onConfirm(chosenParallel);
  };

  return (
    <Sheet open={open}>
      <SheetContent
        side="bottom"
        className="max-h-[90dvh] flex flex-col rounded-t-2xl"
        onInteractOutside={() => {}}
      >
        <SheetHeader className="shrink-0 pb-2">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-foil-violet" />
            {stage === "confirm" && "Confirm parallel"}
            {stage === "freetext" && "Type a parallel"}
            {stage === "results" && "eBay listings"}
          </SheetTitle>
          {cardDescription && (
            <SheetDescription className="text-sm">{cardDescription}</SheetDescription>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto py-2 min-h-0">
          {stage === "confirm" && (
            <div className="space-y-4 px-1">
              <p className="text-sm text-muted-foreground">
                Potential parallel detected:
              </p>
              <p
                className="text-lg font-semibold text-ink"
                data-testid="gemini-parallel-value"
              >
                {geminiParallel}
              </p>
              <div className="grid grid-cols-2 gap-2 pt-2">
                <Button
                  onClick={handleYes}
                  className="h-12"
                  data-testid="gemini-parallel-yes"
                >
                  Yes
                </Button>
                <Button
                  onClick={handleNo}
                  variant="secondary"
                  className="h-12"
                  data-testid="gemini-parallel-no"
                >
                  No
                </Button>
              </div>
            </div>
          )}

          {stage === "freetext" && (
            <div className="space-y-3 px-1">
              <p className="text-sm text-muted-foreground">
                Type the parallel name, or leave blank if this is a base card.
              </p>
              <Input
                autoFocus
                value={freetext}
                placeholder="e.g. Pink/Green Polka Dot"
                maxLength={100}
                onChange={(e) => setFreetext(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleFreetextSubmit();
                }}
                data-testid="gemini-parallel-freetext"
              />
              <Button
                onClick={handleFreetextSubmit}
                className="w-full h-11"
                data-testid="gemini-parallel-freetext-submit"
              >
                <Search className="h-4 w-4 mr-2" />
                Search eBay
              </Button>
              {!!baseQueryWithoutParallel && (
                <p className="text-xs text-muted-foreground">
                  Base query: {baseQueryWithoutParallel}
                </p>
              )}
            </div>
          )}

          {stage === "results" && (
            <div className="space-y-3 px-1">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Searching as:</p>
                <div className="flex gap-2">
                  <Input
                    value={editableQuery}
                    onChange={(e) => setEditableQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRerun();
                    }}
                    data-testid="gemini-picker-editable-query"
                  />
                  <Button
                    onClick={handleRerun}
                    variant="secondary"
                    disabled={searching}
                    data-testid="gemini-picker-rerun"
                  >
                    {searching ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              <Tabs defaultValue="active">
                <TabsList className="grid grid-cols-2">
                  <TabsTrigger value="active" data-testid="gemini-picker-tab-active">
                    Active ({active.length})
                  </TabsTrigger>
                  <TabsTrigger value="sold" data-testid="gemini-picker-tab-sold">
                    Sold {soldAvailable ? `(${sold.length})` : ""}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="active" className="mt-2">
                  <ListingsList
                    items={active}
                    loading={searching}
                    emptyText="No active listings."
                  />
                </TabsContent>
                <TabsContent value="sold" className="mt-2">
                  {soldAvailable ? (
                    <ListingsList
                      items={sold}
                      loading={searching}
                      emptyText="No completed listings."
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground py-6 text-center">
                      Sold data isn't available with the current eBay API access.
                    </p>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>

        <div className="shrink-0 pt-3 border-t">
          {stage === "results" ? (
            <Button
              onClick={handleSaveAndClose}
              className="w-full"
              size="lg"
              data-testid="gemini-picker-save"
            >
              Save parallel{chosenParallel ? `: ${chosenParallel}` : " (base)"}
            </Button>
          ) : (
            <p className="text-center text-xs text-muted-foreground">
              Gemini-detected parallels flow through verbatim.
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ListingsList({
  items,
  loading,
  emptyText,
}: {
  items: PickerListing[];
  loading: boolean;
  emptyText: string;
}) {
  if (loading) {
    return (
      <div className="py-6 flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Searching eBay…
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">{emptyText}</p>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <li key={it.url} className="flex gap-3 items-center p-2 border rounded-lg">
          {it.imageUrl ? (
            <img
              src={it.imageUrl}
              alt=""
              className="w-12 h-12 object-cover rounded shrink-0"
            />
          ) : (
            <div className="w-12 h-12 bg-muted rounded shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <a
              href={it.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-ink line-clamp-2 hover:underline"
            >
              {it.title}
            </a>
            <p className="text-xs text-muted-foreground">
              {it.condition || "—"}
            </p>
          </div>
          <p className="text-sm font-semibold text-ink shrink-0">
            {it.currency === "USD" ? "$" : `${it.currency} `}
            {it.price.toFixed(2)}
          </p>
        </li>
      ))}
    </ul>
  );
}
