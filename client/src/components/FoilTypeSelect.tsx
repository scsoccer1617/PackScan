import { useState, useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface FoilTypeSelectProps {
  brand?: string;
  year?: number | string;
  collection?: string;
  value: string;
  onChange: (value: string) => void;
}

const NONE_VALUE = "__none__";

export default function FoilTypeSelect({ brand, year, value, onChange }: FoilTypeSelectProps) {
  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!brand || !year) {
      setOptions([]);
      return;
    }
    const fetchOptions = async () => {
      setLoading(true);
      try {
        // Query by brand+year only (no collection) to surface all parallels for that set year
        const params = new URLSearchParams({ brand, year: year.toString() });
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
      }
    };
    fetchOptions();
  }, [brand, year]);

  if (loading) {
    return <div className="h-9 w-full animate-pulse rounded-md border border-input bg-muted" />;
  }

  // If there's a current value not in the list, include it so the Select doesn't show blank
  const allOptions = value && value !== "" && !options.includes(value)
    ? [value, ...options]
    : options;

  const selectValue = value || NONE_VALUE;

  return (
    <Select
      value={selectValue}
      onValueChange={(v) => onChange(v === NONE_VALUE ? "" : v)}
    >
      <SelectTrigger>
        <SelectValue placeholder="Select foil type..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_VALUE}>None detected</SelectItem>
        {allOptions.map((opt) => (
          <SelectItem key={opt} value={opt}>{opt}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
