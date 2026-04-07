import { useState, useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";

interface FoilTypeSelectProps {
  brand?: string;
  year?: number | string;
  collection?: string;
  value: string;
  onChange: (value: string) => void;
}

const CUSTOM_VALUE = "__custom__";

export default function FoilTypeSelect({ brand, year, collection, value, onChange }: FoilTypeSelectProps) {
  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState("");

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
  }, [brand, year, collection]);

  // Determine if current value is in the list or is custom
  const isInList = !value || options.includes(value);

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

  // Always show a Select dropdown (even when no DB options — "None detected" + "Custom..." are always available)
  const selectValue = customMode ? CUSTOM_VALUE : (value || "");

  return (
    <div className="space-y-2">
      <Select
        value={selectValue}
        onValueChange={(v) => {
          if (v === CUSTOM_VALUE) {
            setCustomMode(true);
            setCustomText("");
            onChange("");
          } else if (v === "") {
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
          <SelectValue placeholder="Select foil type..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">None detected</SelectItem>
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
          placeholder="Type custom foil type..."
          autoFocus
        />
      )}
    </div>
  );
}
