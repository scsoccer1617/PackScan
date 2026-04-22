// Shared helpers for the Scan → ScanResult flow.
//
// Extracted from the pre-split PriceLookup.tsx so both the capture page
// (Scan) and the results page (ScanResult) can share the same logic
// without round-tripping through a monolithic component.

import type { ParallelOption } from "@/components/ParallelPickerSheet";

/**
 * Resize + JPEG-compress a dataURL before upload.
 * Caps the longer edge at maxPx and encodes at the given quality.
 *
 * 1800 px @ q=0.88 is the tuned balance between foil-serial recovery
 * (small hand-stamped serials need enough pixels) and upload size
 * (typically ~700-900 KB per side). See original PriceLookup.tsx
 * comment history for the full rationale.
 */
export async function compressImage(
  dataUrl: string,
  maxPx = 1800,
  quality = 0.88,
): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { naturalWidth: w, naturalHeight: h } = img;
      if (w > maxPx || h > maxPx) {
        if (w >= h) {
          h = Math.round((h * maxPx) / w);
          w = maxPx;
        } else {
          w = Math.round((w * maxPx) / h);
          h = maxPx;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => resolve(blob!), "image/jpeg", quality);
    };
    img.src = dataUrl;
  });
}

/**
 * Extract the primary search keyword from a detected parallel string.
 * e.g. "Green Foil" → "Green",  "Gold Prizm" → "Gold",  "Rainbow" → "Rainbow"
 */
export function extractKeyword(foilType: string): string {
  const words = foilType.trim().split(/\s+/);
  return words.find((w) => w.length >= 3) ?? words[0] ?? "";
}

/** Filter a list of DB parallel options to those matching the detected keyword. */
export function filterByKeyword(
  options: ParallelOption[],
  foilType: string,
): ParallelOption[] {
  if (!foilType.trim()) return [];
  const keyword = extractKeyword(foilType).toLowerCase();
  if (!keyword) return [];
  const wordBoundary = new RegExp(
    `\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i",
  );
  return options.filter((o) => wordBoundary.test(o.variationOrParallel));
}

/**
 * Filter parallel options by serialization status.
 * Non-numbered card → only show non-serialized parallels (no /NNN limit).
 * Numbered card → only show serialized parallels.
 */
export function filterBySerialStatus(
  options: ParallelOption[],
  isNumbered: boolean,
): ParallelOption[] {
  if (isNumbered) {
    return options.filter(
      (o) => o.serialNumber && o.serialNumber.trim() !== "",
    );
  }
  return options.filter((o) => !o.serialNumber || o.serialNumber.trim() === "");
}

/**
 * Merge a "primary" list (keyword-matched parallels) with a broader "all"
 * list (same serial-status), keeping primary entries first and deduplicating
 * by parallel name.
 */
export function mergePreferringPrimary(
  primary: ParallelOption[],
  all: ParallelOption[],
): ParallelOption[] {
  const seen = new Set<string>();
  const merged: ParallelOption[] = [];
  for (const o of [...primary, ...all]) {
    if (!seen.has(o.variationOrParallel)) {
      seen.add(o.variationOrParallel);
      merged.push(o);
    }
  }
  return merged;
}

/**
 * Extract the serial limit (denominator) from detected serial strings.
 * "487/499" → "499",  "/499" → "499",  "499" → "499"
 */
export function extractSerialLimit(serial: string): string {
  const afterSlash = serial.match(/\/(\d+)\s*$/);
  if (afterSlash) return afterSlash[1];
  const bareDigits = serial.match(/^(\d+)$/);
  if (bareDigits) return bareDigits[1];
  return "";
}

/** Filter parallel options to those whose serial number limit matches the detected one. */
export function filterBySerialNumber(
  options: ParallelOption[],
  detectedSerial: string,
): ParallelOption[] {
  const limit = extractSerialLimit(detectedSerial);
  if (!limit) return [];
  return options.filter((o) => {
    if (!o.serialNumber) return false;
    return extractSerialLimit(o.serialNumber) === limit;
  });
}

/**
 * Fetch parallel options from the DB for a given card.
 *
 * Parallels often live in a DIFFERENT collection than the base card. We
 * run a collection/set-precise query first and fall back to a broader
 * brand+year query only when the precise query returned nothing.
 */
export async function fetchParallels(
  brand: string,
  year: number,
  collection?: string,
  set?: string,
): Promise<ParallelOption[]> {
  const fetchOne = async (extraParams: Record<string, string>) => {
    const params = new URLSearchParams({
      brand,
      year: year.toString(),
      ...extraParams,
    });
    const resp = await fetch(`/api/card-variations/options?${params}`);
    if (!resp.ok)
      return [] as {
        variationOrParallel: string;
        serialNumber: string | null;
      }[];
    const data = await resp.json();
    return (data.options || []) as {
      variationOrParallel: string;
      serialNumber: string | null;
    }[];
  };

  const preciseParams: Record<string, string> = {};
  if (collection) preciseParams.collection = collection;
  if (set) preciseParams.set = set;

  let raw: { variationOrParallel: string; serialNumber: string | null }[] = [];
  if (Object.keys(preciseParams).length > 0) {
    raw = await fetchOne(preciseParams);
  }
  if (raw.length === 0) {
    raw = await fetchOne({}); // brand+year only — last-resort fallback
  }

  const seen = new Set<string>();
  const merged: ParallelOption[] = [];
  for (const o of raw) {
    if (!seen.has(o.variationOrParallel)) {
      seen.add(o.variationOrParallel);
      merged.push({
        variationOrParallel: o.variationOrParallel,
        serialNumber: o.serialNumber,
      });
    }
  }
  return merged;
}
