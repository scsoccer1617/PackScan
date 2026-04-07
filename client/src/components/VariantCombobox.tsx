import { useState, useEffect, useRef } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface VariantOption {
  variationOrParallel: string;
  serialNumber: string | null;
  cmpNumber: string | null;
}

interface VariantComboboxProps {
  brand?: string;
  year?: number;
  collection?: string;
  value: string;
  onChange: (variant: string, serialNumber?: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export default function VariantCombobox({
  brand,
  year,
  collection,
  value,
  onChange,
  placeholder = "Search or type a variant...",
  disabled,
}: VariantComboboxProps) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<VariantOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const prevBrandYearRef = useRef<string>('');

  // Keep inputValue in sync when value changes externally
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  // Fetch variant options when brand/year/collection change
  useEffect(() => {
    const key = `${brand ?? ''}|${year ?? ''}|${collection ?? ''}`;
    if (key === prevBrandYearRef.current) return;
    prevBrandYearRef.current = key;

    if (!brand || !year) {
      setOptions([]);
      return;
    }

    const fetchOptions = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ brand, year: year.toString() });
        if (collection) params.set('collection', collection);
        const resp = await fetch(`/api/card-variations/options?${params}`);
        if (resp.ok) {
          const data = await resp.json();
          setOptions(data.options || []);
        }
      } catch {
        setOptions([]);
      } finally {
        setLoading(false);
      }
    };
    fetchOptions();
  }, [brand, year, collection]);

  const handleSelect = (opt: VariantOption) => {
    onChange(opt.variationOrParallel, opt.serialNumber ?? undefined);
    setInputValue(opt.variationOrParallel);
    setOpen(false);
  };

  const handleCustomEntry = () => {
    const trimmed = inputValue.trim();
    if (trimmed) {
      onChange(trimmed);
      setOpen(false);
    }
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
    setInputValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      // If there's exactly one match, select it; otherwise commit the typed text
      const matches = options.filter(o =>
        o.variationOrParallel.toLowerCase().includes(inputValue.trim().toLowerCase())
      );
      if (matches.length === 1) {
        handleSelect(matches[0]);
      } else {
        handleCustomEntry();
      }
    }
  };

  // Filter options based on what's typed in CommandInput (cmdk handles this automatically via the value prop)
  const displayLabel = value
    ? (options.find(o => o.variationOrParallel === value)?.serialNumber
        ? `${value} (${options.find(o => o.variationOrParallel === value)?.serialNumber})`
        : value)
    : '';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal h-9 px-3 text-sm"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {displayLabel || placeholder}
          </span>
          <div className="flex items-center gap-1 ml-2 shrink-0">
            {value && (
              <X
                className="h-3.5 w-3.5 opacity-50 hover:opacity-100 cursor-pointer"
                onClick={handleClear}
              />
            )}
            <ChevronsUpDown className="h-4 w-4 opacity-50" />
          </div>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={true} filter={(itemValue, search) =>
          itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
        }>
          <CommandInput
            placeholder="Search variants..."
            value={inputValue}
            onValueChange={setInputValue}
            onKeyDown={handleKeyDown}
          />
          <CommandList>
            {loading ? (
              <div className="py-4 text-center text-sm text-muted-foreground">Loading...</div>
            ) : (
              <>
                <CommandEmpty>
                  <div className="px-3 py-2 text-sm text-muted-foreground space-y-2">
                    <p>No match found.</p>
                    {inputValue.trim() && (
                      <button
                        type="button"
                        onClick={handleCustomEntry}
                        className="text-blue-600 hover:underline text-xs"
                      >
                        Use &quot;{inputValue.trim()}&quot; as custom value
                      </button>
                    )}
                  </div>
                </CommandEmpty>
                {options.length > 0 && (
                  <CommandGroup heading={`${options.length} variant${options.length !== 1 ? 's' : ''}`}>
                    {options.map((opt, idx) => {
                      const label = opt.serialNumber
                        ? `${opt.variationOrParallel} (${opt.serialNumber})`
                        : opt.variationOrParallel;
                      return (
                        <CommandItem
                          key={idx}
                          value={opt.variationOrParallel}
                          onSelect={() => handleSelect(opt)}
                          className="cursor-pointer"
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4 shrink-0",
                              value === opt.variationOrParallel ? "opacity-100" : "opacity-0"
                            )}
                          />
                          <span className="flex-1">{opt.variationOrParallel}</span>
                          {opt.serialNumber && (
                            <span className="ml-2 text-xs text-muted-foreground">{opt.serialNumber}</span>
                          )}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}
                {inputValue.trim() && !options.some(o => o.variationOrParallel.toLowerCase() === inputValue.trim().toLowerCase()) && (
                  <CommandGroup heading="Custom">
                    <CommandItem
                      value={`__use_custom__${inputValue.trim()}`}
                      onSelect={handleCustomEntry}
                      className="cursor-pointer"
                    >
                      <span className="text-blue-600">Use &quot;{inputValue.trim()}&quot;</span>
                    </CommandItem>
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
