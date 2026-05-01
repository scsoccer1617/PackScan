import { useFieldArray, type UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X } from "lucide-react";
import type { CardFormValues } from "@shared/schema";

/**
 * Multi-player editing UI for vintage Topps subsets that print 2–3 named
 * players on one card (1971 N.L. Strikeout Leaders, 1968 Batting Leaders,
 * Manager's Dream, etc.). Renders a dynamic list of {First, Last, Role?}
 * rows on top of the form's `players` field array.
 *
 * Element 0 of the array is the PRIMARY player and the only row that
 * cannot be removed — it mirrors the legacy `playerFirstName` /
 * `playerLastName` fields on the form. This component keeps those legacy
 * fields in sync via form.setValue so existing readers (eBay query
 * builder, search, MOLO) keep working unchanged.
 *
 * The "+ Add another player" button is always available so the dealer can
 * promote a regularly-detected single-player card into a multi-player row
 * if Gemini missed an additional name.
 */
export default function PlayersFieldset({ form }: { form: UseFormReturn<CardFormValues> }) {
  const { fields, append, remove, update } = useFieldArray({
    control: form.control,
    name: "players",
  });

  // Initialize the array on first render if the form has legacy fields but
  // no players array yet — the field-array hook only sees what's in form
  // state, so we seed it from playerFirstName/playerLastName.
  const firstName = form.watch("playerFirstName") ?? "";
  const lastName = form.watch("playerLastName") ?? "";
  if (fields.length === 0 && (firstName || lastName)) {
    append({ firstName, lastName });
  }

  const showBadge = fields.length > 1;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-700">Players</span>
        {showBadge && (
          <span
            data-testid="players-count-badge"
            className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800"
          >
            {fields.length} players
          </span>
        )}
      </div>
      {fields.map((field, idx) => (
        <div key={field.id} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[120px]">
            <label className="text-xs text-slate-500">
              First {idx === 0 && <span className="text-red-500">*</span>}
            </label>
            <Input
              placeholder="First name"
              defaultValue={(field as any).firstName ?? ""}
              onChange={(e) => {
                update(idx, { ...(form.getValues(`players.${idx}`) as any), firstName: e.target.value });
                if (idx === 0) form.setValue("playerFirstName", e.target.value);
              }}
            />
          </div>
          <div className="flex-1 min-w-[120px]">
            <label className="text-xs text-slate-500">
              Last {idx === 0 && <span className="text-red-500">*</span>}
            </label>
            <Input
              placeholder="Last name"
              defaultValue={(field as any).lastName ?? ""}
              onChange={(e) => {
                update(idx, { ...(form.getValues(`players.${idx}`) as any), lastName: e.target.value });
                if (idx === 0) form.setValue("playerLastName", e.target.value);
              }}
            />
          </div>
          <div className="w-32">
            <label className="text-xs text-slate-500">Role (optional)</label>
            <Input
              placeholder="e.g. PITCHER"
              defaultValue={(field as any).role ?? ""}
              onChange={(e) => {
                update(idx, { ...(form.getValues(`players.${idx}`) as any), role: e.target.value });
              }}
            />
          </div>
          {idx > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => remove(idx)}
              aria-label={`Remove player ${idx + 1}`}
              data-testid={`players-remove-${idx}`}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => append({ firstName: "", lastName: "" })}
        data-testid="players-add"
      >
        <Plus className="mr-1 h-4 w-4" /> Add another player
      </Button>
    </div>
  );
}
