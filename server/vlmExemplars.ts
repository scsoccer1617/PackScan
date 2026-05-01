// VLM exemplar loader (Parallel Exemplar Library v1, MOLO-grounded).
//
// When VLM_EXEMPLARS_ENABLED=true, the bulk + single-scan VLM call paths
// append a small reference set of known parallel images (Refractor, Red
// Shattered, Disco, Mojo, …) to Gemini's `parts` array so the model can
// disambiguate the scanned card's parallel/foilType using visual
// matches against canonical exemplars.
//
// Default off — when the flag is unset behavior is byte-identical to
// pre-flag main. The prompt text in vlmPrompts.ts is NOT modified; the
// exemplar instruction is appended at the call site as a separate text
// part (see vlmGemini.ts).
//
// Manifest + JPEGs live under attached_assets/exemplars/. The static
// middleware in server/index.ts:74-77 already exposes attached_assets/
// for unrelated reasons; we use the same directory so deploys ship the
// images automatically.

import * as fs from 'fs';
import * as path from 'path';

const EXEMPLARS_DIR = path.join(process.cwd(), 'attached_assets', 'exemplars');
const MANIFEST_PATH = path.join(EXEMPLARS_DIR, 'manifest.json');

export interface ExemplarManifestEntry {
  parallel: string;
  brand: string;
  filename: string;
  molo_frequency?: number | null;
  card_description?: string | null;
  notes?: string | null;
  source_image_url?: string | null;
  source_page?: string | null;
  source_site?: string | null;
  image_width?: number | null;
  image_height?: number | null;
  image_bytes?: number | null;
  user_supplied?: boolean;
  expansion?: boolean;
}

export type ExemplarPart = { inlineData: { mimeType: string; data: string } };

let cachedManifest: ExemplarManifestEntry[] | null = null;
let cachedParts: ExemplarPart[] | null = null;

/** True when VLM_EXEMPLARS_ENABLED is the literal string "true". */
export function isExemplarsEnabled(): boolean {
  return process.env.VLM_EXEMPLARS_ENABLED === 'true';
}

/**
 * Read attached_assets/exemplars/manifest.json once and cache. Returns
 * an empty array on any read/parse failure — exemplars are best-effort,
 * a missing manifest must NOT break scanning.
 */
export function loadExemplarManifest(): ExemplarManifestEntry[] {
  if (cachedManifest) return cachedManifest;
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    cachedManifest = Array.isArray(parsed) ? (parsed as ExemplarManifestEntry[]) : [];
  } catch (err: any) {
    console.warn(`[vlmExemplars] manifest load failed (${MANIFEST_PATH}): ${err?.message || err}`);
    cachedManifest = [];
  }
  return cachedManifest;
}

/**
 * Return Gemini-compatible inlineData parts for every exemplar in the
 * manifest. Each JPEG is read once and the base64 string is cached in
 * memory; subsequent calls hit no disk. Entries whose file is missing
 * or unreadable are skipped (logged once, not thrown).
 */
export function getExemplarParts(): ExemplarPart[] {
  if (cachedParts) return cachedParts;
  const entries = loadExemplarManifest();
  const parts: ExemplarPart[] = [];
  for (const entry of entries) {
    if (!entry?.filename) continue;
    const filePath = path.join(EXEMPLARS_DIR, entry.filename);
    try {
      const buf = fs.readFileSync(filePath);
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: buf.toString('base64'),
        },
      });
    } catch (err: any) {
      console.warn(`[vlmExemplars] skipping ${entry.filename}: ${err?.message || err}`);
    }
  }
  cachedParts = parts;
  return cachedParts;
}

/** Short text part prepended before the inline exemplar parts. */
export function getExemplarTextPrefix(): string {
  return 'Reference exemplars: 54 known parallel patterns from MOLO. Use these images to disambiguate the card\'s parallel/foilType when filling your output.';
}
