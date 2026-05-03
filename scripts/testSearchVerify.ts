/**
 * Standalone manual test runner for `verifyIdentificationWithSearch`.
 *
 * Usage:
 *   GEMINI_API_KEY=... npx tsx scripts/testSearchVerify.ts
 *
 * Hits the live Gemini API with `googleSearch` grounding enabled. Burns a
 * few search-grounded calls and roughly 5-15s of wall clock; intended for
 * the user (Daniel) to run by hand when validating prompt changes or
 * gauging whether the verifier catches a specific failure mode.
 */

import {
  verifyIdentificationWithSearch,
  type SearchVerifyInput,
  type SearchVerifyResult,
} from '../server/vlmSearchVerify';

interface TestCase {
  label: string;
  input: SearchVerifyInput;
  expectation: string;
}

const CASES: TestCase[] = [
  {
    label: 'Pokey Reese 1994 → expect year correction to 1995',
    input: {
      player: 'Pokey Reese',
      year: 1994,
      brand: 'Upper Deck',
      set: 'Upper Deck',
      cardNumber: '28',
      subset: 'Reds Top Prospect',
      sport: 'Baseball',
    },
    expectation: 'year corrected 1994 → 1995',
  },
  {
    label: 'Mike Trout 2011 Topps Update US175 → expect no corrections',
    input: {
      player: 'Mike Trout',
      year: 2011,
      brand: 'Topps',
      set: 'Update',
      cardNumber: 'US175',
      sport: 'Baseball',
    },
    expectation: 'no corrections',
  },
  {
    label: 'Quinton McCracken set=Top Prospect → expect set correction',
    input: {
      player: 'Quinton McCracken',
      year: 1995,
      brand: 'Upper Deck',
      set: 'Top Prospect',
      cardNumber: '119',
      sport: 'Baseball',
    },
    expectation: 'set corrected to Upper Deck / Upper Deck Minor League',
  },
  {
    label: 'Aaron Judge 2024 Topps Series One #1 → expect no corrections',
    input: {
      player: 'Aaron Judge',
      year: 2024,
      brand: 'Topps',
      set: 'Series One',
      cardNumber: '1',
      sport: 'Baseball',
    },
    expectation: 'no corrections',
  },
  {
    label: 'Mike Trout 2011 Topps Update #100 (wrong card #) → expect cardNumber correction to US175',
    input: {
      player: 'Mike Trout',
      year: 2011,
      brand: 'Topps',
      set: 'Update',
      cardNumber: '100',
      sport: 'Baseball',
    },
    expectation: 'cardNumber corrected 100 → US175',
  },
];

function summarize(input: SearchVerifyInput): string {
  return `${input.player} | ${input.year} ${input.brand} ${input.set ?? ''} #${input.cardNumber}${input.subset ? ` (subset: ${input.subset})` : ''}`;
}

function correctionsLine(result: SearchVerifyResult): string {
  if (result.corrections.length === 0) return 'Corrections: 0';
  const parts = result.corrections.map((c) => `${c.field}: "${c.oldValue}" → "${c.newValue}"`);
  return `Corrections: ${result.corrections.length} (${parts.join(', ')})`;
}

interface RunRow {
  label: string;
  latencyMs: number;
  corrections: number;
  confidence: string;
  error?: string;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set. Export it before running this script.');
    process.exit(2);
  }

  const rows: RunRow[] = [];

  for (const tc of CASES) {
    console.log('═'.repeat(80));
    console.log(`▶ ${tc.label}`);
    console.log(`  Expected: ${tc.expectation}`);
    console.log(`  Input:    ${summarize(tc.input)}`);

    const start = Date.now();
    try {
      const result = await verifyIdentificationWithSearch(tc.input);
      const latency = Date.now() - start;
      const printable: SearchVerifyResult = { ...result };
      // Trim raw response in console output to keep the log readable; the
      // full text is still on the returned object if a caller needs it.
      if (printable.rawResponse && printable.rawResponse.length > 600) {
        printable.rawResponse = `${printable.rawResponse.slice(0, 600)}…[truncated]`;
      }
      console.log(`  Output:   ${JSON.stringify(printable, null, 2).split('\n').join('\n            ')}`);
      console.log(`  Latency:  ${latency} ms`);
      console.log(`  ${correctionsLine(result)}`);
      rows.push({
        label: tc.label,
        latencyMs: latency,
        corrections: result.corrections.length,
        confidence: result.confidence,
      });
    } catch (err: any) {
      const latency = Date.now() - start;
      console.log(`  ERROR after ${latency} ms: ${String(err?.message ?? err).slice(0, 400)}`);
      rows.push({
        label: tc.label,
        latencyMs: latency,
        corrections: 0,
        confidence: 'low',
        error: String(err?.message ?? err).slice(0, 200),
      });
    }
  }

  console.log('═'.repeat(80));
  console.log('Summary');
  console.log('═'.repeat(80));
  const labelW = Math.max(...rows.map((r) => r.label.length), 5);
  const header = `${'Case'.padEnd(labelW)} | ${'Latency'.padStart(8)} | ${'Corrections'.padStart(11)} | Confidence`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    const lat = `${r.latencyMs} ms`;
    console.log(
      `${r.label.padEnd(labelW)} | ${lat.padStart(8)} | ${String(r.corrections).padStart(11)} | ${r.confidence}${r.error ? ` (ERR: ${r.error.slice(0, 60)})` : ''}`,
    );
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
