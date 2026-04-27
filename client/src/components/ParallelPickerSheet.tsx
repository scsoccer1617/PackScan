import { useState, useEffect, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Check, Layers, Search } from "lucide-react";

export interface ParallelOption {
  variationOrParallel: string;
  serialNumber: string | null;
}

interface ParallelPickerSheetProps {
  open: boolean;
  detectedLabel: string;
  cardDescription: string;
  options: ParallelOption[];
  onConfirm: (foilType: string, serialNumber?: string) => void;
  /** When true, the title is generic ("Which parallel is this?") instead
   *  of colour-specific. Used after the user has tapped "No" on the
   *  detected colour and asked to see all parallels. */
  showAllMode?: boolean;
}

const CUSTOM_VALUE_INTERNAL = "__custom__";

/**
 * Pick the most-likely default option for the picker.
 *
 * When the detector reports a specific colour (e.g. "Silver"), the picker
 * keeps Silver, Gold, Rainbow, and themed parallels in view. The previous
 * implementation defaulted to options[0], which was alphabetically Gold
 * for many sets — wrong when Silver was actually detected. This helper
 * preselects the first option whose label contains the detected colour
 * keyword, falling back to options[0] when no match exists (e.g. show-all
 * mode or a colour the catalogue doesn't carry).
 */
function pickDefaultOption(
  options: ParallelOption[],
  detectedLabel: string,
): string {
  if (options.length === 0) return CUSTOM_VALUE_INTERNAL;
  const keyword = (detectedLabel || "").trim().toLowerCase();
  if (keyword) {
    const match = options.find(o =>
      o.variationOrParallel.toLowerCase().includes(keyword),
    );
    if (match) return match.variationOrParallel;
  }
  return options[0].variationOrParallel;
}

/**
 * Reorder options so the keyword-matched default sits at the top of
 * the rendered list. Non-matching options keep their original relative
 * order beneath it.
 *
 * Without this, Silver could be correctly preselected at index 7 in a
 * Topps Series 2 set — the radio dot would be active but visually
 * halfway down the picker, with Aqua / Black / Blue stacked above it.
 * Users had to scroll to find their preselect.
 */
function reorderForDefault(
  options: ParallelOption[],
  detectedLabel: string,
): ParallelOption[] {
  if (options.length <= 1) return options;
  const keyword = (detectedLabel || "").trim().toLowerCase();
  if (!keyword) return options;
  const idx = options.findIndex(o =>
    o.variationOrParallel.toLowerCase().includes(keyword),
  );
  if (idx <= 0) return options; // no match, or already first
  const matched = options[idx];
  return [matched, ...options.slice(0, idx), ...options.slice(idx + 1)];
}

const CUSTOM_VALUE = CUSTOM_VALUE_INTERNAL;
const NONE_VALUE = "__none__";

export default function ParallelPickerSheet({
  open,
  detectedLabel,
  cardDescription,
  options,
  onConfirm,
  showAllMode = false,
}: ParallelPickerSheetProps) {
  // In show-all mode (No-flow second step) the title and behaviour are
  // generic, and we deliberately don't bias the order toward the
  // detected colour the user just rejected. In normal mode, hoist the
  // matched default to the top so the preselected radio is visible at
  // first paint.
  const orderedOptions = useMemo(
    () =>
      showAllMode
        ? options
        : reorderForDefault(options, detectedLabel),
    [options, detectedLabel, showAllMode],
  );
  const [selected, setSelected] = useState<string>(() =>
    pickDefaultOption(orderedOptions, detectedLabel),
  );
  const [customText, setCustomText] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && orderedOptions.length > 0) {
      setSelected(pickDefaultOption(orderedOptions, detectedLabel));
      setCustomText("");
      // Force the picker list back to the top whenever the sheet opens.
      // Without this, Radix's focus management inside the Sheet (and any
      // prior scroll position the container kept from a previous open)
      // could leave the user staring at the bottom of the option list,
      // hiding the highlighted default selection. Two rAF ticks gives
      // Radix time to apply its own focus before we override the scroll.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = 0;
        });
      });
    }
  }, [open, orderedOptions]);

  const handleConfirm = () => {
    if (selected === CUSTOM_VALUE) {
      onConfirm(customText.trim());
    } else if (selected === NONE_VALUE) {
      // Search without specifying a parallel — useful when the correct
      // parallel isn't in the catalog list (e.g. an SSP not yet imported,
      // or a colour combo like "Pink/Green Polka Dot" Arenado that we
      // don't have catalogued). Drops the foil keyword from the search
      // so eBay's broader fallback can still find the right card.
      onConfirm("");
    } else {
      const opt = orderedOptions.find(o => o.variationOrParallel === selected);
      onConfirm(selected, opt?.serialNumber ?? undefined);
    }
  };

  const selectedLabel =
    selected === CUSTOM_VALUE ? (customText || "Custom…")
    : selected === NONE_VALUE ? "No parallel filter"
    : selected;

  return (
    <Sheet open={open}>
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] flex flex-col rounded-t-2xl"
        onInteractOutside={() => {}}
      >
        <SheetHeader className="shrink-0 pb-2">
          <SheetTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-blue-600" />
            {showAllMode || !detectedLabel
              ? "Which parallel is this?"
              : `Which ${detectedLabel} parallel is this?`}
          </SheetTitle>
          <SheetDescription className="text-sm">{cardDescription}</SheetDescription>
        </SheetHeader>

        <div ref={scrollRef} className="flex-1 overflow-y-auto py-2 space-y-1 min-h-0">
          {orderedOptions.map(opt => (
            <PickerRow
              key={opt.variationOrParallel}
              label={opt.variationOrParallel}
              sublabel={opt.serialNumber ? `Numbered /${opt.serialNumber.replace(/\//g, "")}` : undefined}
              selected={selected === opt.variationOrParallel}
              onSelect={() => setSelected(opt.variationOrParallel)}
            />
          ))}

          <PickerRow
            label="Not listed — search without parallel"
            sublabel="Use when the right parallel isn't shown above"
            selected={selected === NONE_VALUE}
            onSelect={() => setSelected(NONE_VALUE)}
          />

          <PickerRow
            label="Other / Custom…"
            sublabel="Type a name not listed above"
            selected={selected === CUSTOM_VALUE}
            onSelect={() => setSelected(CUSTOM_VALUE)}
          />
          {selected === CUSTOM_VALUE && (
            <div className="px-1 pt-1">
              <Input
                autoFocus
                placeholder={`e.g. ${detectedLabel} Leaf Foil`}
                value={customText}
                onChange={e => setCustomText(e.target.value)}
                className="h-10"
              />
            </div>
          )}
        </div>

        <div className="shrink-0 pt-3 border-t space-y-2">
          <p className="text-center text-xs text-muted-foreground">
            Searching as:{" "}
            <span className="font-medium text-foreground">{selectedLabel}</span>
          </p>
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
}: {
  label: string;
  sublabel?: string;
  selected: boolean;
  onSelect: () => void;
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
      <div
        className={`shrink-0 h-5 w-5 rounded-full border-2 flex items-center justify-center
          ${selected ? "bg-blue-600 border-blue-600" : "border-muted-foreground/40"}`}
      >
        {selected && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{label}</p>
        {sublabel && <p className="text-xs text-muted-foreground truncate">{sublabel}</p>}
      </div>
    </button>
  );
}
