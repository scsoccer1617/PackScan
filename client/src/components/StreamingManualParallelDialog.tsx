import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles } from "lucide-react";

// PR T Item 3 — streaming-mode manual-entry parallel dialog. Fires
// inline DURING stage 2 when the user clicks "No" on the
// StreamingParallelConfirmDialog (rather than after the scan completes
// on the result page). Stage 3 stays in its `waiting` chip until the
// user saves a value here, so eBay and pricing run with the
// user-entered parallel — not the auto-detected one or a base-card
// query that has to be redone after the fact.
//
// Mirrors the layout/header of StreamingParallelConfirmDialog so the
// inline transition from confirm → manual feels like one continuous
// modal. Reuses the same identifying header line (year · brand · set
// · collection · # · player) so the user keeps context.

interface Props {
  open: boolean;
  /** Identity preview line shown beneath the title — same string the
   *  Yes/No streaming modal renders. */
  cardDescription?: string;
  /** Resolves with the user-entered parallel string. Empty string
   *  ⇒ "no parallel / treat as base". The caller is responsible for
   *  threading this onto the cardData and unblocking stage 3. */
  onSave: (parallel: string) => void;
}

export default function StreamingManualParallelDialog({
  open,
  cardDescription,
  onSave,
}: Props) {
  const [freetext, setFreetext] = useState("");

  // Reset the input every time the modal reopens so the previous
  // attempt's text doesn't leak into a fresh scan / re-open.
  useEffect(() => {
    if (open) setFreetext("");
  }, [open]);

  const pending = freetext.trim().slice(0, 100);
  const handleSubmit = () => {
    onSave(pending);
  };

  return (
    <Sheet open={open}>
      <SheetContent
        side="bottom"
        className="max-h-[90dvh] flex flex-col rounded-t-2xl"
        onInteractOutside={() => {
          /* indefinite block — outside taps do nothing while stage 3
             waits on this confirmation. */
        }}
        data-testid="streaming-manual-parallel-dialog"
      >
        <SheetHeader className="shrink-0 pb-2">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-foil-violet" />
            Type a parallel
          </SheetTitle>
          {cardDescription && (
            <SheetDescription className="text-sm">
              {cardDescription}
            </SheetDescription>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto py-2 min-h-0 space-y-3 px-1">
          <p className="text-sm text-muted-foreground">
            Type the parallel name, or leave blank if this is a base card.
          </p>
          <Input
            autoFocus
            value={freetext}
            placeholder="e.g. Pink Ice"
            maxLength={100}
            onChange={(e) => setFreetext(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
            data-testid="streaming-manual-parallel-input"
          />
          <Button
            onClick={handleSubmit}
            className="w-full h-11"
            data-testid="streaming-manual-parallel-save"
          >
            Save parallel{pending ? `: ${pending}` : " (base)"}
          </Button>
          <p className="text-xs text-muted-foreground">
            We&apos;ll look up eBay listings for the variant you save.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
