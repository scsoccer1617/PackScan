import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Check, FolderTree, Search } from "lucide-react";

export interface CollectionCandidate {
  brand: string;
  year: number;
  collection: string;
  set: string | null;
  cardNumber: string;
  playerName: string;
  isRookieCard: boolean;
}

interface CollectionPickerSheetProps {
  open: boolean;
  cardDescription: string;
  candidates: CollectionCandidate[];
  onConfirm: (picked: CollectionCandidate) => void;
}

export default function CollectionPickerSheet({
  open,
  cardDescription,
  candidates,
  onConfirm,
}: CollectionPickerSheetProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && candidates.length > 0) {
      setSelectedIdx(0);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = 0;
        });
      });
    }
  }, [open, candidates]);

  const handleConfirm = () => {
    const picked = candidates[selectedIdx];
    if (picked) onConfirm(picked);
  };

  const selected = candidates[selectedIdx];
  const selectedLabel = selected ? (selected.set || selected.collection) : "";

  return (
    <Sheet open={open}>
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] flex flex-col rounded-t-2xl"
        onInteractOutside={() => {}}
      >
        <SheetHeader className="shrink-0 pb-2">
          <SheetTitle className="flex items-center gap-2">
            <FolderTree className="h-5 w-5 text-blue-600" />
            Which set is this card from?
          </SheetTitle>
          <SheetDescription className="text-sm">
            {cardDescription} — multiple sets share this card number. Pick the one printed on your card.
          </SheetDescription>
        </SheetHeader>

        <div ref={scrollRef} className="flex-1 overflow-y-auto py-2 space-y-1 min-h-0">
          {candidates.map((c, i) => {
            const setLabel = c.set || c.collection;
            const colSubLabel = c.set && c.collection && c.set !== c.collection
              ? c.collection
              : undefined;
            return (
              <PickerRow
                key={`${c.collection}|${c.set}|${c.playerName}|${i}`}
                label={setLabel}
                sublabel={[colSubLabel, c.isRookieCard ? "Rookie" : undefined].filter(Boolean).join(" • ") || undefined}
                selected={selectedIdx === i}
                onSelect={() => setSelectedIdx(i)}
              />
            );
          })}
        </div>

        <div className="shrink-0 pt-3 border-t space-y-2">
          <p className="text-center text-xs text-muted-foreground">
            Searching as:{" "}
            <span className="font-medium text-foreground">{selectedLabel}</span>
          </p>
          <Button
            onClick={handleConfirm}
            disabled={!selected}
            className="w-full"
            size="lg"
          >
            <Search className="h-4 w-4 mr-2" />
            Use this set
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
