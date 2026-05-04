// Gemini-authority parallel picker.
//
// Two-step pass-through flow that trusts Gemini's emitted parallel verbatim:
//
//   STEP 1 — confirmation card:
//     "Potential parallel detected: <geminiParallel>" → [Yes] [No]
//     - Yes: persist Gemini's value, close picker.
//     - No: show a free-text input, then save the user's value and close.
//     - When Gemini returned no parallel, STEP 1 is skipped entirely and
//       the free-text input is the first thing the user sees.
//
// PR #163: the eBay listings step that lived after confirm/freetext was
// removed — the picker's job is just to capture the parallel. eBay search
// code (server/ebayPickerSearch.ts, /api/picker/ebay-search) is preserved
// dormant (not imported) so a revert can revive the listings UI without
// rewriting it. Same reversibility pattern PR #162 used for CardDB.
//
// `queryParts` is still part of the interface so callers don't have to
// change shape — it's just unused by this component now. Holding it lets
// us re-introduce the eBay step (or any other downstream picker action)
// without churning the call sites.
//
// No variationsDB filtering anywhere. No "Which X parallel" dropdown. No
// autocomplete chips. Gemini-or-freetext, end of story.

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
  /** Pre-built query parts. Currently unused by the picker (PR #163 removed
   *  the eBay listings step) but retained so callers don't have to change
   *  shape if/when downstream picker steps return. */
  queryParts: GeminiPickerQueryParts;
  /** Called once the user has confirmed (or freetext-typed) a parallel.
   *  Empty string ⇒ "no parallel / base". The parent persists this onto
   *  cardData.foilType. */
  onConfirm: (parallel: string) => void;
  /** PR S Item 3 — when true, skip the Yes/No "confirm" stage entirely
   *  and open straight to the freetext input. Used after the streaming
   *  parallel-confirm modal answered "No" — re-prompting Yes/No would
   *  ask the same question twice, so we go directly to manual entry.
   *  Defaults to false (legacy behavior preserved). */
  startInFreetext?: boolean;
}

type Stage = "confirm" | "freetext";

export default function GeminiParallelPickerSheet({
  open,
  geminiParallel,
  cardDescription,
  onConfirm,
  startInFreetext = false,
}: Props) {
  const initialStage: Stage =
    startInFreetext || !(geminiParallel && geminiParallel.trim())
      ? "freetext"
      : "confirm";
  const [stage, setStage] = useState<Stage>(initialStage);
  const [freetext, setFreetext] = useState<string>("");

  useEffect(() => {
    if (open) {
      setStage(
        startInFreetext || !(geminiParallel && geminiParallel.trim())
          ? "freetext"
          : "confirm",
      );
      setFreetext("");
    }
  }, [open, geminiParallel, startInFreetext]);

  const handleYes = () => {
    onConfirm((geminiParallel ?? "").trim());
  };

  const handleNo = () => {
    setStage("freetext");
  };

  const handleFreetextSubmit = () => {
    onConfirm(freetext.trim().slice(0, 100));
  };

  const pendingFreetext = freetext.trim().slice(0, 100);

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
                Save parallel{pendingFreetext ? `: ${pendingFreetext}` : " (base)"}
              </Button>
            </div>
          )}
        </div>

        <div className="shrink-0 pt-3 border-t">
          <p className="text-center text-xs text-muted-foreground">
            Gemini-detected parallels flow through verbatim.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
