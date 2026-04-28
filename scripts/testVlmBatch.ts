/**
 * Batch VLM test runner.
 *
 * Scans the test-images-tmp/ folder for *_front.jpg and *_back.jpg pairs,
 * runs each pair through Gemini (the new VLM path) AND through the
 * existing Google-Vision-OCR + extractCardMetadata pipeline (the legacy
 * regex path), then prints a side-by-side comparison table.
 *
 * Usage:
 *   npx tsx scripts/testVlmBatch.ts                         # all pairs
 *   npx tsx scripts/testVlmBatch.ts lb jt tt                 # specific IDs
 *   IMAGES_DIR=/some/other/path npx tsx scripts/testVlmBatch.ts
 *
 * Requires GEMINI_API_KEY in env (Replit Secrets injects it automatically).
 * Google Vision auth uses whatever credentials your existing pipeline
 * already has — no extra setup. If Vision isn't configured, the legacy
 * column will simply show "—" and the runner continues with Gemini alone.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { analyzeCardWithGemini, type GeminiCardResult } from '../server/vlmGemini';

interface CardPair {
  id: string;
  frontPath: string;
  backPath: string;
}

interface LegacyResult {
  player?: string | null;
  year?: number | string | null;
  brand?: string | null;
  set?: string | null;
  cardNumber?: string | null;
  parallel?: string | null;
  sport?: string | null;
  error?: string;
}

interface RunResult {
  id: string;
  gemini?: GeminiCardResult;
  geminiError?: string;
  legacy?: LegacyResult;
  legacyError?: string;
  geminiMs?: number;
  legacyMs?: number;
}

async function findPairs(dir: string, idFilter?: Set<string>): Promise<CardPair[]> {
  const files = await fs.readdir(dir);
  const fronts = new Map<string, string>();
  const backs = new Map<string, string>();

  for (const f of files) {
    // Allow .jpg / .jpeg / .png / .webp
    const m = f.match(/^(.+?)_(front|back)\.(jpe?g|png|webp)$/i);
    if (!m) continue;
    const [, id, side] = m;
    if (side.toLowerCase() === 'front') fronts.set(id, f);
    else backs.set(id, f);
  }

  const pairs: CardPair[] = [];
  for (const [id, frontFile] of Array.from(fronts).sort(([a], [b]) => a.localeCompare(b))) {
    const backFile = backs.get(id);
    if (!backFile) continue;
    if (idFilter && !idFilter.has(id)) continue;
    pairs.push({
      id,
      frontPath: path.join(dir, frontFile),
      backPath: path.join(dir, backFile),
    });
  }
  return pairs;
}

async function runLegacyForPair(frontPath: string, backPath: string): Promise<LegacyResult> {
  // Lazy-load the legacy pipeline so a missing Vision setup doesn't block
  // the Gemini-only path. Each side is OCR'd + extracted independently
  // and the back's fields fill in any gaps the front leaves null —
  // a simplified version of dualSideOCR's merge logic that's good enough
  // for an A/B harness.
  const { analyzeSportsCardImage } = await import('../server/googleVisionFetch');

  const [frontBuf, backBuf] = await Promise.all([
    fs.readFile(frontPath),
    fs.readFile(backPath),
  ]);

  const [frontResult, backResult] = await Promise.all([
    analyzeSportsCardImage(frontBuf.toString('base64')).catch((e: any) => ({ _err: e.message })),
    analyzeSportsCardImage(backBuf.toString('base64')).catch((e: any) => ({ _err: e.message })),
  ]);

  const fr = frontResult as any;
  const br = backResult as any;
  if (fr._err && br._err) {
    return { error: `front: ${fr._err}; back: ${br._err}` };
  }

  // CardFormValues (shared/schema.ts) splits the player name into
  // playerFirstName + playerLastName, and uses 'collection' (not 'set').
  // Read from both sides; back side usually has the cleaner set + cardNumber,
  // front usually has the cleaner player name.
  const pick = (k: string) => fr?.[k] ?? br?.[k] ?? null;
  const first = pick('playerFirstName');
  const last = pick('playerLastName');
  const player = [first, last].filter(Boolean).join(' ').trim() || null;

  // Distinguish the "Vision returned its hardcoded fallback" case (year =
  // current year, all string fields empty) from a real extraction. The
  // fallback at googleVisionFetch.ts:1372 returns { year: getFullYear(),
  // sport: '', brand: '' } when extraction fails entirely.
  const currentYear = new Date().getFullYear();
  const looksLikeFallback = (r: any) =>
    r &&
    !r._err &&
    r.year === currentYear &&
    !r.playerFirstName &&
    !r.playerLastName &&
    !r.cardNumber &&
    !r.collection;
  const bothFallback = looksLikeFallback(fr) && looksLikeFallback(br);

  if (bothFallback) {
    return {
      error: 'Vision returned default fallback for both sides (no text extracted)',
      player: null,
      year: null,
      brand: null,
      set: null,
      cardNumber: null,
      parallel: null,
      sport: null,
    };
  }

  return {
    player,
    year: pick('year') === currentYear && !player ? null : pick('year'),
    brand: pick('brand') || null,
    set: pick('collection') || null,
    cardNumber: pick('cardNumber'),
    parallel: pick('foilType') || pick('variant') || null,
    sport: pick('sport') || null,
  };
}

async function runGeminiForPair(p: CardPair): Promise<{ result?: GeminiCardResult; error?: string; ms: number }> {
  const start = Date.now();
  try {
    const result = await analyzeCardWithGemini(p.frontPath, p.backPath);
    return { result, ms: Date.now() - start };
  } catch (err: any) {
    return { error: err.message, ms: Date.now() - start };
  }
}

function trunc(s: any, n: number): string {
  if (s === null || s === undefined || s === '') return '—';
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function printRow(id: string, label: string, src: 'GEMINI' | 'LEGACY', cells: string[]): void {
  const padded = [
    id.padEnd(4),
    label.padEnd(7),
    src.padEnd(7),
    ...cells,
  ];
  console.log('│ ' + padded.join(' │ ') + ' │');
}

function printResult(r: RunResult): void {
  // Header row for this card
  console.log('├──────┴─────────┴─────────┴──────────────────────┴──────┴──────────┴───────────────────────┴────────┴──────────────────┤');

  const widths = [22, 6, 10, 23, 8, 18];
  const cols = ['Player', 'Year', 'Brand', 'Set', 'Card #', 'Parallel'];

  const g = r.gemini;
  const l = r.legacy;

  const geminiCells = [
    trunc(g?.player, widths[0]).padEnd(widths[0]),
    trunc(g?.year, widths[1]).padEnd(widths[1]),
    trunc(g?.brand, widths[2]).padEnd(widths[2]),
    trunc(g?.set, widths[3]).padEnd(widths[3]),
    trunc(g?.cardNumber, widths[4]).padEnd(widths[4]),
    trunc(g?.parallel?.name, widths[5]).padEnd(widths[5]),
  ];
  const legacyCells = [
    trunc(l?.player, widths[0]).padEnd(widths[0]),
    trunc(l?.year, widths[1]).padEnd(widths[1]),
    trunc(l?.brand, widths[2]).padEnd(widths[2]),
    trunc(l?.set, widths[3]).padEnd(widths[3]),
    trunc(l?.cardNumber, widths[4]).padEnd(widths[4]),
    trunc(l?.parallel, widths[5]).padEnd(widths[5]),
  ];

  printRow(r.id, `${r.geminiMs ?? '?'}ms`, 'GEMINI', geminiCells);
  printRow('', `${r.legacyMs ?? '?'}ms`, 'LEGACY', legacyCells);

  if (r.geminiError) console.log(`│   gemini error: ${trunc(r.geminiError, 100)}`);
  if (r.legacyError) console.log(`│   legacy error: ${trunc(r.legacyError, 100)}`);
}

async function main() {
  const dir = process.env.IMAGES_DIR || path.resolve(process.cwd(), 'test-images-tmp');
  const filterArgs = process.argv.slice(2);
  const idFilter = filterArgs.length > 0 ? new Set(filterArgs) : undefined;

  console.log(`\nScanning ${dir} for *_front + *_back image pairs...`);
  const pairs = await findPairs(dir, idFilter).catch((e: any) => {
    console.error(`Failed to read ${dir}: ${e.message}`);
    process.exit(1);
  });

  if (!pairs.length) {
    console.error(`No *_front.jpg + *_back.jpg pairs found in ${dir}.`);
    if (idFilter) console.error(`(Filter active: ${[...idFilter].join(', ')})`);
    process.exit(1);
  }

  console.log(`Found ${pairs.length} pair(s): ${pairs.map(p => p.id).join(', ')}\n`);

  const widths = [22, 6, 10, 23, 8, 18];
  const cols = ['Player', 'Year', 'Brand', 'Set', 'Card #', 'Parallel'];
  console.log('┌──────┬─────────┬─────────┬' + cols.map((c, i) => '─'.repeat(widths[i] + 2)).join('┬') + '┐');
  const header = ['ID  ', 'Time   ', 'Source ', ...cols.map((c, i) => c.padEnd(widths[i]))];
  console.log('│ ' + header.join(' │ ') + ' │');
  console.log('├──────┼─────────┼─────────┼' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤');

  const results: RunResult[] = [];
  for (const pair of pairs) {
    const [gem, leg] = await Promise.all([
      runGeminiForPair(pair),
      runLegacyForPair(pair.frontPath, pair.backPath).then(
        r => ({ result: r, ms: 0 }),
        (e: any) => ({ error: e.message, ms: 0 })
      ),
    ]);
    const r: RunResult = {
      id: pair.id,
      gemini: gem.result,
      geminiError: gem.error,
      geminiMs: gem.ms,
      legacy: (leg as any).result?.error ? undefined : (leg as any).result,
      legacyError: (leg as any).error || (leg as any).result?.error,
      legacyMs: (leg as any).ms,
    };
    results.push(r);
    printResult(r);
  }

  console.log('└──────┴─────────┴─────────┴' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘\n');

  // Save full JSON dump for later inspection
  const dumpPath = path.resolve(process.cwd(), 'test-images-tmp', '_results.json');
  await fs.writeFile(dumpPath, JSON.stringify(results, null, 2));
  console.log(`Full JSON results saved to ${dumpPath}`);

  const errors = results.filter(r => r.geminiError).length;
  console.log(`\nSummary: ${results.length - errors}/${results.length} cards processed by Gemini successfully.`);
  if (errors) console.log(`         ${errors} card(s) had Gemini errors — see _results.json for details.`);
}

main().catch((e: any) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
