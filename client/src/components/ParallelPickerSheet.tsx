import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Check, Layers, Search } from "lucide-react";
import { CardFormValues } from "@shared/schema";

interface ParallelOption {
  variationOrParallel: string;
  serialNumber: string | null;
}

interface ParallelPickerSheetProps {
  open: boolean;
  cardData: Partial<CardFormValues>;
  onConfirm: (foilType: string, serialNumber?: string) => void;
}

const BASE_CARD = "__base__";
const CUSTOM_VALUE = "__custom__";

export default function ParallelPickerSheet({ open, cardData, onConfirm }: ParallelPickerSheetProps) {
  const [options, setOptions] = useState<ParallelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string>(BASE_CARD);
  const [customText, setCustomText] = useState("");

  // Fetch parallels from DB whenever the card context changes
  useEffect(() => {
    if (!open || !cardData.brand || !cardData.year) return;

    const fetchOptions = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          brand: cardData.brand!,
          year: cardData.year!.toString(),
        });
        if (cardData.collection) params.set("collection", cardData.collection);

        const resp = await fetch(`/api/card-variations/options?${params}`);
        if (resp.ok) {
          const data = await resp.json();
          const raw: { variationOrParallel: string; serialNumber: string | null }[] = data.options || [];
          // Deduplicate by name (keep first occurrence which has serial)
          const seen = new Set<string>();
          const unique: ParallelOption[] = [];
          for (const o of raw) {
            if (!seen.has(o.variationOrParallel)) {
              seen.add(o.variationOrParallel);
              unique.push({ variationOrParallel: o.variationOrParallel, serialNumber: o.serialNumber });
            }
          }
          setOptions(unique);

          // Auto-select OCR-detected foilType if it matches a DB option
          const detected = cardData.foilType?.trim() || "";
          if (detected) {
            const match = unique.find(o =>
              o.variationOrParallel.toLowerCase() === detected.toLowerCase()
            );
            if (match) {
              setSelected(match.variationOrParallel);
            } else {
              // OCR detected something not in DB — start with it as custom
              setSelected(CUSTOM_VALUE);
              setCustomText(detected);
            }
          } else {
            setSelected(BASE_CARD);
          }
        }
      } catch {
        setOptions([]);
      } finally {
        setLoading(false);
      }
    };

    fetchOptions();
  }, [open, cardData.brand, cardData.year, cardData.collection, cardData.foilType]);

  const handleConfirm = () => {
    if (selected === BASE_CARD) {
      onConfirm(""); // no parallel — base card
    } else if (selected === CUSTOM_VALUE) {
      onConfirm(customText.trim());
    } else {
      // Find the serial number for this parallel
      const opt = options.find(o => o.variationOrParallel === selected);
      onConfirm(selected, opt?.serialNumber ?? undefined);
    }
  };

  const selectedLabel = () => {
    if (selected === BASE_CARD) return "Base Card";
    if (selected === CUSTOM_VALUE) return customText || "Custom…";
    return selected;
  };

  return (
    <Sheet open={open}>
      <SheetContent side="bottom" className="max-h-[85vh] flex flex-col rounded-t-2xl" onInteractOutside={() => {}}>
        <SheetHeader className="shrink-0 pb-2">
          <SheetTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-blue-600" />
            Which parallel is this?
          </SheetTitle>
          <SheetDescription className="text-sm">
            {cardData.year} {cardData.brand} {cardData.collection ? `${cardData.collection} ` : ""}
            #{cardData.cardNumber} · {cardData.playerFirstName} {cardData.playerLastName}
          </SheetDescription>
        </SheetHeader>

        {/* Scrollable parallel list */}
        <div className="flex-1 overflow-y-auto py-2 space-y-1 min-h-0">
          {loading ? (
            <div className="space-y-2 px-1">
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="h-12 rounded-lg bg-muted animate-pulse" />
              ))}
            </div>
          ) : (
            <>
              {/* Base card option */}
              <PickerRow
                label="Base Card"
                sublabel="No parallel / standard version"
                selected={selected === BASE_CARD}
                onSelect={() => setSelected(BASE_CARD)}
                isBase
              />

              {/* DB parallels */}
              {options.map(opt => (
                <PickerRow
                  key={opt.variationOrParallel}
                  label={opt.variationOrParallel}
                  sublabel={opt.serialNumber ? `Numbered /${opt.serialNumber.replace(/\//g, "")}` : undefined}
                  selected={selected === opt.variationOrParallel}
                  onSelect={() => setSelected(opt.variationOrParallel)}
                />
              ))}

              {/* Custom entry */}
              <PickerRow
                label="Other / Custom…"
                sublabel="Type a parallel not listed above"
                selected={selected === CUSTOM_VALUE}
                onSelect={() => setSelected(CUSTOM_VALUE)}
              />
              {selected === CUSTOM_VALUE && (
                <div className="px-1 pt-1">
                  <Input
                    autoFocus
                    placeholder="e.g. Green Leaf Foil"
                    value={customText}
                    onChange={e => setCustomText(e.target.value)}
                    className="h-10"
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 pt-3 border-t space-y-2">
          {selected !== BASE_CARD && (
            <p className="text-center text-xs text-muted-foreground">
              Searching as: <span className="font-medium text-foreground">{selectedLabel()}</span>
            </p>
          )}
          <Button
            onClick={handleConfirm}
            disabled={selected === CUSTOM_VALUE && !customText.trim()}
            className="w-full"
            size="lg"
          >
            <Search className="h-4 w-4 mr-2" />
            Search eBay
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PickerRow({
  label,
  sublabel,
  selected,
  onSelect,
  isBase = false,
}: {
  label: string;
  sublabel?: string;
  selected: boolean;
  onSelect: () => void;
  isBase?: boolean;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left transition-colors
        ${selected
          ? "bg-blue-50 border border-blue-200 dark:bg-blue-950 dark:border-blue-800"
          : "hover:bg-muted border border-transparent"
        }`}
    >
      {/* Check indicator */}
      <div className={`shrink-0 h-5 w-5 rounded-full border-2 flex items-center justify-center
        ${selected ? "bg-blue-600 border-blue-600" : "border-muted-foreground/40"}`}>
        {selected && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
      </div>

      {/* Label */}
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium truncate ${isBase ? "text-muted-foreground" : ""}`}>{label}</p>
        {sublabel && <p className="text-xs text-muted-foreground truncate">{sublabel}</p>}
      </div>
    </button>
  );
}
