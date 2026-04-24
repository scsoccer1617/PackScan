// PSA grade picker — shared between ScanResult edit panel, AddCard form,
// and the VoiceLookup confirm sheet. Users who already know their card is
// slabbed set this, and the eBay at-grade comp tier searches for
// "PSA <n>" graded sales instead of the Holo-predicted grade.
//
// Values are whole-number PSA grades 1-10 (half grades like 9.5 exist but
// are rare and SCP/eBay queries don't key off them cleanly, so we keep the
// picker integer-only). Leaving the field blank means "unset" — the server
// falls back to the Holo-predicted grade.

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface PsaGradeSelectProps {
  value: number | null;
  onChange: (psa: number | null) => void;
  /** Optional override for the field label. Defaults to "PSA grade". */
  label?: string;
  /** Shown when nothing is selected. */
  placeholder?: string;
}

const PSA_OPTIONS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const UNSET_VALUE = "__none__";

export default function PsaGradeSelect({
  value,
  onChange,
  label = "PSA grade",
  placeholder = "Not graded",
}: PsaGradeSelectProps) {
  const selectValue = value == null ? UNSET_VALUE : String(value);

  return (
    <div>
      <Label className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">
        {label}
      </Label>
      <Select
        value={selectValue}
        onValueChange={(v) => {
          if (v === UNSET_VALUE) {
            onChange(null);
            return;
          }
          const n = Number(v);
          onChange(Number.isFinite(n) ? n : null);
        }}
      >
        <SelectTrigger className="mt-1" data-testid="select-psa-grade">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET_VALUE} data-testid="select-psa-none">
            Not graded
          </SelectItem>
          {PSA_OPTIONS.map((n) => (
            <SelectItem
              key={n}
              value={String(n)}
              data-testid={`select-psa-${n}`}
            >
              PSA {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-slate-500 mt-1 leading-snug">
        Set this for slabbed cards to pull graded-only eBay comps.
      </p>
    </div>
  );
}
