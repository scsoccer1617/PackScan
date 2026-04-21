import { useState, useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";

interface FoilTypeSelectProps {
  brand?: string;
  year?: number | string;
  collection?: string;
  set?: string;
  value: string;
  onChange: (value: string) => void;
  // When provided, restricts the dropdown to parallels matching the card's
  // serialization status. `false` (or undefined → defaults to false here when
  // the consumer wires it up) shows only non-serialized parallels — the
  // user-confirmed expectation when the scanned card has no /xxx serial.
  isNumbered?: boolean;
  // Splits the catalog by name. 'parallel' (default) excludes any row whose
  // variation_or_parallel name contains the word "Variation"/"Variations";
  // 'variant' includes ONLY those rows. Drives both the API filter and the
  // user-facing labels/placeholders.
  kind?: 'parallel' | 'variant';
  placeholder?: string;
  noneLabel?: string;
  customPlaceholder?: string;
}

const CUSTOM_VALUE = "__custom__";
const NONE_VALUE   = "__none__";

export default function FoilTypeSelect({
  brand,
  year,
  collection,
  set,
  value,
  onChange,
  isNumbered,
  kind = 'parallel',
  placeholder,
  noneLabel = 'None detected',
  customPlaceholder,
}: FoilTypeSelectProps) {
  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState("");

  const effectivePlaceholder = placeholder
    ?? (kind === 'variant' ? 'Select variant...' : 'Select parallel...');
  const effectiveCustomPlaceholder = customPlaceholder
    ?? (kind === 'variant' ? 'Type custom variant...' : 'Type custom parallel...');

  useEffect(() => {
    if (!brand || !year) {
      setOptions([]);
      setFetched(true);
      return;
    }
    const fetchOptions = async () => {
      setLoading(true);
      setFetched(false);
      try {
        const params = new URLSearchParams({ brand, year: year.toString() });
        if (collection) params.set("collection", collection);
        if (set) params.set("set", set);
        // Default: when isNumbered is unspecified or false, only show
        // non-serialized parallels. Numbered cards explicitly opt in via
        // serialStatus=numbered so the dropdown shows /xxx options.
        // For the variant kind, serial status is not meaningful — variants
        // are always "Photo Variation" / "Image Variation" style entries.
        if (kind !== 'variant') {
          params.set("serialStatus", isNumbered ? "numbered" : "none");
        }
        params.set("kind", kind);
        const resp = await fetch(`/api/card-variations/options?${params}`);
        if (resp.ok) {
          const data = await resp.json();
          const rawOptions: { variationOrParallel: string }[] = data.options || [];
          const unique = Array.from(new Set(rawOptions.map((o) => o.variationOrParallel)));
          setOptions(unique);
        } else {
          setOptions([]);
        }
      } catch {
        setOptions([]);
      } finally {
        setLoading(false);
        setFetched(true);
      }
    };
    fetchOptions();
  }, [brand, year, collection, set, isNumbered, kind]);

  // When value changes externally, check if it needs custom mode
  useEffect(() => {
    if (fetched && value && !options.includes(value)) {
      setCustomMode(true);
      setCustomText(value);
    } else {
      setCustomMode(false);
    }
  }, [value, options, fetched]);

  if (loading) {
    return <div className="h-9 w-full animate-pulse rounded-md border border-input bg-muted" />;
  }

  const selectValue = customMode ? CUSTOM_VALUE : (value || NONE_VALUE);

  return (
    <div className="space-y-2">
      <Select
        value={selectValue}
        onValueChange={(v) => {
          if (v === CUSTOM_VALUE) {
            setCustomMode(true);
            setCustomText("");
            onChange("");
          } else if (v === NONE_VALUE) {
            setCustomMode(false);
            setCustomText("");
            onChange("");
          } else {
            setCustomMode(false);
            setCustomText("");
            onChange(v);
          }
        }}
      >
        <SelectTrigger>
          <SelectValue placeholder={effectivePlaceholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>{noneLabel}</SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt} value={opt}>{opt}</SelectItem>
          ))}
          <SelectItem value={CUSTOM_VALUE}>Other / Custom...</SelectItem>
        </SelectContent>
      </Select>
      {customMode && (
        <Input
          value={customText}
          onChange={(e) => {
            setCustomText(e.target.value);
            onChange(e.target.value);
          }}
          placeholder={effectiveCustomPlaceholder}
          autoFocus
        />
      )}
    </div>
  );
}
