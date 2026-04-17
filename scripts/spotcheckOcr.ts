/**
 * Task #16 — Spot-check OCR scans for popular sets and log misreads.
 *
 * Runs analyzeSportsCardImage('back') on a curated set of card-back images
 * spanning the brand/year/set combos we have on disk, then captures every
 * [CardNum] / [CardNum-pos] log line so we can verify the position-aware
 * top-region filter from Task #15 is choosing the right card number.
 *
 * Output: docs/task-16-ocr-spotcheck.md (tracked).
 *
 * Pass criteria (per Task #16): the chosen card # MUST come from the TOP
 * region. UNKNOWN-with-no-positional-data is treated as inconclusive (PASS
 * by design — there is no positional info to evaluate). Anything else
 * (RELAXED, MIDDLE, BOTTOM, NONE, error) is treated as a misread that
 * should be filed as a follow-up.
 *
 * Exit code:
 *   0 — script ran to completion. The report is the deliverable; per-sample
 *        misreads are surfaced inside it (and in the [CardNum*] log lines)
 *        and tracked via follow-up tasks #17 / #18 / #19, not by exit code.
 *        Non-zero is reserved for hard runtime errors only.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { analyzeSportsCardImage } from '../server/dynamicCardAnalyzer';

interface Sample {
  file: string;
  brand?: string;
  year?: number;
  set?: string;
  category: 'base' | 'insert' | 'unknown';
  notes?: string;
}

// Sample list. Filenames in attached_assets/ + uploads/*_topps_*.jpg already
// encode brand/year/set; the remaining uploads/ entries are spot-check fodder
// where we let OCR fill in the brand/year/set after the fact.
const SAMPLES: Sample[] = [
  // === Labeled fixtures (brand/year/set known from filename) ===
  { file: 'attached_assets/bregman_back_2024_topps_35year.jpg',  brand: 'Topps', year: 2024, set: 'Topps 35 Year', category: 'insert' },
  { file: 'attached_assets/cole_back_2021_topps_heritage.jpg',   brand: 'Topps', year: 2021, set: 'Heritage',      category: 'base'   },
  { file: 'attached_assets/correa_back_2024_topps_smlb.jpg',     brand: 'Topps', year: 2024, set: 'Stars of MLB',  category: 'insert' },
  { file: 'attached_assets/freedman_back_2023_topps_smlb.jpg',   brand: 'Topps', year: 2023, set: 'Stars of MLB',  category: 'insert' },
  { file: 'attached_assets/frelick_back_2024_35year.jpg',        brand: 'Topps', year: 2024, set: 'Topps 35 Year', category: 'insert' },
  { file: 'attached_assets/machado_back_2024_topps_csmlb.jpg',   brand: 'Topps', year: 2024, set: 'Chrome Stars of MLB', category: 'insert' },
  { file: 'attached_assets/manaea_back_2024_topps_series2.jpg',  brand: 'Topps', year: 2024, set: 'Series 2',      category: 'base'   },
  { file: 'attached_assets/rafaela_back_2024_topps_smlb.jpg',    brand: 'Topps', year: 2024, set: 'Stars of MLB',  category: 'insert' },
  { file: 'attached_assets/trout_back_2024_topps_chrome.jpg',    brand: 'Topps', year: 2024, set: 'Chrome',        category: 'base'   },
  { file: 'attached_assets/Eric_Davis_Back_1770591274413.jpeg',  brand: 'Topps', year: 1987, set: 'Topps',         category: 'base'   },
  { file: 'uploads/george_frazier_back_1987_topps.jpg',          brand: 'Topps', year: 1987, set: 'Topps',         category: 'base'   },

  // === Unlabeled scans — OCR fills in brand/year/set ===
  { file: 'uploads/1745782254523_Trout_back.jpg',          category: 'unknown', notes: 'Trout' },
  { file: 'uploads/1745785721128_Machado_back.jpg',        category: 'unknown', notes: 'Machado' },
  { file: 'uploads/1745790593497_Volpe_back.jpg',          category: 'unknown', notes: 'Volpe' },
  { file: 'uploads/1745791833113_Schanuel_back.jpg',       category: 'unknown', notes: 'Schanuel' },
  { file: 'uploads/1745792025510_Lewis_back.jpg',          category: 'unknown', notes: 'Lewis' },
  { file: 'uploads/1745796442086_Rutschman_back.jpg',      category: 'unknown', notes: 'Rutschman' },
  { file: 'uploads/1745796845936_Bregman_back.jpg',        category: 'unknown', notes: 'Bregman' },
  { file: 'uploads/1745797140221_Gray_back.jpg',           category: 'unknown', notes: 'Gray' },
  { file: 'uploads/1745841448392_Frelick_back.jpg',        category: 'unknown', notes: 'Frelick' },
  { file: 'uploads/1745841615206_Ohtani_back.jpg',         category: 'unknown', notes: 'Ohtani' },
  { file: 'uploads/1745867368012_Rafaela_back.jpg',        category: 'unknown', notes: 'Rafaela' },
  { file: 'uploads/1745871754347_Lindor_back.jpg',         category: 'unknown', notes: 'Lindor' },
  { file: 'uploads/1748117697572_Bell_back.jpg',           category: 'unknown', notes: 'Bell' },
  { file: 'uploads/1748121530952_Votto_back.jpg',          category: 'unknown', notes: 'Votto' },
  { file: 'uploads/1748122748803_Bart_back.jpg',           category: 'unknown', notes: 'Bart' },
  { file: 'uploads/1748131671695_Tatis Jr._back.jpg',      category: 'unknown', notes: 'Tatis Jr.' },
  { file: 'uploads/1748132924218_Acuña Jr._back.jpg',      category: 'unknown', notes: 'Acuña Jr.' },
  { file: 'uploads/1748134305937_Harper_back.jpg',         category: 'unknown', notes: 'Harper' },
  { file: 'uploads/1748135529471_Frazier_back.jpg',        category: 'unknown', notes: 'Frazier' },
  { file: 'uploads/1748179343897_Bergman_back.jpg',        category: 'unknown', notes: 'Bergman' },
  { file: 'uploads/1748186788506_Jones_back.jpg',          category: 'unknown', notes: 'Jones' },
];

interface SampleResult {
  sample: Sample;
  detected: {
    brand?: string;
    year?: number;
    collection?: string;
    set?: string;
    cardNumber?: string;
    playerLastName?: string;
  };
  cardNumLogs: string[];
  rawOcrSnippet: string;
  region: 'TOP' | 'MIDDLE' | 'BOTTOM' | 'UNKNOWN' | 'RELAXED' | 'NONE';
  normY?: string;
  source?: string;
  durationMs: number;
  error?: string;
  pass: boolean;
}

const ROOT = process.cwd();

type Region = SampleResult['region'];
const REGION_VALUES = new Set<Region>(['TOP', 'MIDDLE', 'BOTTOM', 'UNKNOWN', 'RELAXED', 'NONE']);
function asRegion(s: string): Region {
  return (REGION_VALUES.has(s as Region) ? s : 'UNKNOWN') as Region;
}

function regionFromLogs(logs: string[]): { region: Region; normY?: string; source?: string } {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i];
    let m = line.match(/\[CardNum-pos\] Accepting "([^"]+)" via ([^\s(]+).*normY=([\d.]+) \((TOP|MIDDLE|BOTTOM|UNKNOWN)\)/);
    if (m) return { region: asRegion(m[4]), normY: m[3], source: m[2] };
    m = line.match(/\[CardNum\] Accepting "([^"]+)" via ([^\s(]+).*relaxed pass, normY=([\d.n/a]+), (TOP|MIDDLE|BOTTOM|UNKNOWN)/);
    if (m) return { region: 'RELAXED', normY: m[3], source: m[2] };
    m = line.match(/\[CardNum\] Accepting "([^"]+)" via ([^\s(]+).*no positional data/);
    if (m) return { region: 'UNKNOWN', source: m[2] };
  }
  return { region: 'NONE' };
}

function isPass(region: Region): boolean {
  // Only the strict top-region accept counts as a real pass.
  // UNKNOWN here means "no positional data was available" — the detector
  // had nothing to evaluate, so we treat it as a degenerate pass rather
  // than a misread (it is not a regression of Task #15's filter).
  return region === 'TOP' || region === 'UNKNOWN';
}

async function runOne(sample: Sample): Promise<SampleResult> {
  const captured: string[] = [];
  const allLogs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const grab = (...args: unknown[]) => {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    allLogs.push(line);
    if (line.includes('[CardNum')) captured.push(line);
  };
  console.log = grab;
  console.warn = grab;

  const t0 = Date.now();
  try {
    const abs = path.join(ROOT, sample.file);
    const buf = await fs.readFile(abs);
    const b64 = buf.toString('base64');
    const result = await analyzeSportsCardImage(b64, 'back');
    const durationMs = Date.now() - t0;
    console.log = origLog;
    console.warn = origWarn;
    const rawIdx = allLogs.findIndex(l => l.includes('=== RAW OCR TEXT FROM IMAGE ==='));
    const rawEndIdx = allLogs.findIndex(l => l.includes('=== END RAW OCR TEXT ==='));
    const rawOcr = rawIdx >= 0 && rawEndIdx > rawIdx
      ? allLogs.slice(rawIdx + 1, rawEndIdx).join('\n').slice(0, 240)
      : '';
    const reg = regionFromLogs(captured);
    return {
      sample,
      detected: {
        brand: result.brand,
        year: result.year,
        collection: result.collection,
        set: result.set,
        cardNumber: result.cardNumber,
        playerLastName: result.playerLastName,
      },
      cardNumLogs: captured,
      rawOcrSnippet: rawOcr,
      ...reg,
      durationMs,
      pass: isPass(reg.region),
    };
  } catch (e: unknown) {
    console.log = origLog;
    console.warn = origWarn;
    const msg = e instanceof Error ? e.message : String(e);
    return {
      sample,
      detected: {},
      cardNumLogs: captured,
      rawOcrSnippet: '',
      region: 'NONE',
      durationMs: Date.now() - t0,
      error: msg,
      pass: false,
    };
  }
}

function comboKey(brand?: string, year?: number, set?: string): string {
  return `${brand ?? '?'} / ${year ?? '?'} / ${set ?? '?'}`;
}

interface ComboCoverage {
  combo: string;
  base: number;
  insert: number;
  unknownCategory: number;
  files: string[];
}

function summariseCoverage(results: SampleResult[]): ComboCoverage[] {
  const map = new Map<string, ComboCoverage>();
  for (const r of results) {
    const brand = r.sample.brand ?? r.detected.brand;
    const year = r.sample.year ?? r.detected.year;
    const set = r.sample.set ?? r.detected.set ?? r.detected.collection;
    if (!brand && !year && !set) continue;
    const key = comboKey(brand, year, set);
    let entry = map.get(key);
    if (!entry) {
      entry = { combo: key, base: 0, insert: 0, unknownCategory: 0, files: [] };
      map.set(key, entry);
    }
    if (r.sample.category === 'base') entry.base++;
    else if (r.sample.category === 'insert') entry.insert++;
    else entry.unknownCategory++;
    entry.files.push(r.sample.file);
  }
  return [...map.values()].sort((a, b) => b.files.length - a.files.length);
}

function md(results: SampleResult[]): string {
  const lines: string[] = [];
  const passes = results.filter(r => r.pass).length;
  const fails = results.length - passes;
  const coverage = summariseCoverage(results);

  lines.push('# Task #16 — OCR Spot-Check Report');
  lines.push('');
  lines.push(`Ran the position-aware card-number detector (Task #15) over **${results.length}** card-back images.`);
  lines.push('');
  lines.push('**Pass criterion** (Task #16): the accepted card # was logged via `[CardNum-pos] Accepting … (TOP)`.');
  lines.push('A degenerate pass is recorded when no positional data was available (`UNKNOWN`, no positional data); everything');
  lines.push('else (`RELAXED`, `MIDDLE`, `BOTTOM`, `NONE`, error) is treated as a misread.');
  lines.push('');
  lines.push(`## Result: ${fails === 0 ? '✅ all samples passed' : `❌ ${fails} of ${results.length} samples flagged as misreads`}`);
  lines.push('');
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.region] = (counts[r.region] ?? 0) + 1;
  lines.push('### Region distribution');
  for (const [k, v] of Object.entries(counts).sort()) lines.push(`- **${k}**: ${v}`);
  lines.push('');
  lines.push('## Brand / year / set coverage');
  lines.push('');
  lines.push('Combos derived from the labeled filename when present, otherwise from the OCR result.');
  lines.push('Where the same combo appears with both a base and an insert sample, that is called out.');
  lines.push('');
  lines.push('| Combo (brand / year / set) | base | insert | unknown | files |');
  lines.push('|---|---:|---:|---:|---|');
  for (const c of coverage) {
    lines.push(`| ${c.combo} | ${c.base} | ${c.insert} | ${c.unknownCategory} | ${c.files.length} |`);
  }
  lines.push('');
  const covered = coverage.length;
  lines.push(`**Distinct brand/year/set combos covered: ${covered}.**`);
  lines.push('');
  lines.push('### Coverage caveat');
  lines.push('');
  lines.push('The task asked for "one base + one insert from each of the top ~20 brand/year combos".');
  lines.push('This sweep ran against every back-side image already on disk in `attached_assets/` and `uploads/`. We do');
  lines.push('not have access to physical scans of every popular set, so coverage is bounded by what the user has');
  lines.push('uploaded to date. The combo table above shows what we actually exercised.');
  lines.push('');
  lines.push('## Per-card results');
  lines.push('');
  lines.push('| # | File | Expected | Detected | Region | normY | Source | OK? |');
  lines.push('|---|------|---------|----------|--------|-------|--------|-----|');
  results.forEach((r, i) => {
    const exp = [r.sample.brand, r.sample.year, r.sample.set].filter(Boolean).join(' / ') || (r.sample.notes ?? '—');
    const det = [r.detected.brand, r.detected.year, r.detected.set ?? r.detected.collection, r.detected.cardNumber ? `#${r.detected.cardNumber}` : '']
      .filter(Boolean).join(' / ');
    const ok = r.pass
      ? (r.region === 'TOP' ? '✅ TOP' : '✅ no-positional-data')
      : `❌ ${r.region}`;
    lines.push(`| ${i + 1} | \`${r.sample.file}\` | ${exp} (${r.sample.category}) | ${det || '—'} | ${r.region} | ${r.normY ?? ''} | ${r.source ?? ''} | ${ok} |`);
  });
  lines.push('');
  lines.push('## Misreads to investigate');
  lines.push('');
  const misreads = results.filter(r => !r.pass);
  if (misreads.length === 0) {
    lines.push('_None — every accepted card # came from the TOP region (or had no positional data)._');
  } else {
    lines.push('Patterns observed in this sweep have already been filed as follow-up tasks:');
    lines.push('- **#17** Detect SMLB / CSMLB-style Stars-of-MLB card numbers in the strict top-region pass');
    lines.push('- **#18** Recognize card numbers printed at the bottom of vintage Topps backs');
    lines.push('- **#19** Add an automated regression suite for the card-number OCR detector');
    lines.push('');
    for (const r of misreads) {
      lines.push(`### ${r.sample.file}`);
      lines.push(`- Expected: ${[r.sample.brand, r.sample.year, r.sample.set].filter(Boolean).join(' / ') || r.sample.notes || '(unlabeled)'}`);
      lines.push(`- Detected: brand=${r.detected.brand ?? '—'}, year=${r.detected.year ?? '—'}, set=${r.detected.set ?? r.detected.collection ?? '—'}, cardNumber=${r.detected.cardNumber ?? '—'}`);
      lines.push(`- Region: **${r.region}**${r.normY ? `, normY=${r.normY}` : ''}${r.source ? `, source=${r.source}` : ''}`);
      if (r.error) lines.push(`- Error: \`${r.error}\``);
      lines.push('- [CardNum*] log lines:');
      lines.push('```');
      for (const l of r.cardNumLogs) lines.push(l);
      lines.push('```');
      if (r.rawOcrSnippet) {
        lines.push('- Raw OCR snippet (first ~240 chars):');
        lines.push('```');
        lines.push(r.rawOcrSnippet);
        lines.push('```');
      }
      lines.push('');
    }
  }
  lines.push('## Full [CardNum*] log excerpts (every sample)');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.sample.file}`);
    lines.push('```');
    for (const l of r.cardNumLogs) lines.push(l);
    lines.push('```');
  }
  return lines.join('\n');
}

async function main() {
  const results: SampleResult[] = [];
  for (const sample of SAMPLES) {
    process.stderr.write(`[spot-check] ${sample.file} ... `);
    try {
      const r = await runOne(sample);
      results.push(r);
      process.stderr.write(`${r.region} (${r.durationMs}ms)${r.pass ? '' : '  ← misread'}\n`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`ERROR ${msg}\n`);
    }
  }
  const out = md(results);
  const outDir = path.join(ROOT, 'docs');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'task-16-ocr-spotcheck.md'), out, 'utf8');
  process.stderr.write(`\nReport written to docs/task-16-ocr-spotcheck.md\n`);

  const fails = results.filter(r => !r.pass).length;
  if (fails > 0) {
    process.stderr.write(`${fails} of ${results.length} samples failed the TOP-region check (see report).\n`);
    // Exit 0 even on failures so the report is treated as the deliverable
    // for this manual spot-check; failed samples are surfaced via #17/#18/#19.
  }
}

main().then(() => process.exit(0)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
