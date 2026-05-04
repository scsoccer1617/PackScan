import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";

// PR R Item 2 — fired immediately after stage 2 ("Detecting parallel")
// completes during a live scan. Stage 3 (eBay listings) chip shows a
// "Waiting for confirmation" pill until the user clicks Yes/No here.
//
// The post-completion picker on /result (GeminiParallelPickerSheet) is
// unchanged — that path still runs after navigation if the user lands on
// /result without having confirmed (e.g. fallback path). This component
// is visually similar but lives inside the streaming Scan flow so it
// can gate the rest of the in-flight scan.
//
// Behavior:
//  - geminiParallel non-empty → Yes/No buttons.
//  - geminiParallel empty (base card) → caller should NOT mount this;
//    gate yourself off the same condition that fires the modal.
//  - Indefinite block. No auto-accept timeout. The user is actively
//    scanning, so we never proceed without an explicit click.

interface Props {
  open: boolean;
  /** Detected parallel name from the SSE detecting_parallel:completed
   *  data payload. Empty → caller is responsible for skipping the modal. */
  geminiParallel: string | null;
  /** Identity preview line shown beneath the title. */
  cardDescription?: string;
  onYes: () => void;
  onNo: () => void;
}

export default function StreamingParallelConfirmDialog({
  open,
  geminiParallel,
  cardDescription,
  onYes,
  onNo,
}: Props) {
  const trimmed = (geminiParallel ?? "").trim();
  return (
    <Sheet open={open}>
      <SheetContent
        side="bottom"
        className="max-h-[90dvh] flex flex-col rounded-t-2xl"
        onInteractOutside={() => {
          /* indefinite block — outside taps do nothing */
        }}
        data-testid="streaming-parallel-confirm-dialog"
      >
        <SheetHeader className="shrink-0 pb-2">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-foil-violet" />
            Confirm parallel
          </SheetTitle>
          {cardDescription && (
            <SheetDescription className="text-sm">
              {cardDescription}
            </SheetDescription>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto py-2 min-h-0 space-y-4 px-1">
          <p className="text-sm text-muted-foreground">
            Potential parallel detected:
          </p>
          <p
            className="text-lg font-semibold text-ink"
            data-testid="streaming-parallel-confirm-value"
          >
            {trimmed || "Base"}
          </p>
          <p className="text-xs text-muted-foreground">
            We&apos;ll look up eBay listings for the variant you confirm.
          </p>
          <div className="grid grid-cols-2 gap-2 pt-2">
            <Button
              onClick={onYes}
              className="h-12"
              data-testid="streaming-parallel-confirm-yes"
            >
              Yes
            </Button>
            <Button
              onClick={onNo}
              variant="secondary"
              className="h-12"
              data-testid="streaming-parallel-confirm-no"
            >
              No
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
