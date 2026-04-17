import pg from 'pg';
import { pipeline } from 'stream/promises';
import copyStreams from 'pg-copy-streams';

const { to: copyTo, from: copyFrom } = copyStreams;

export type PushTableName = 'card_database' | 'card_variations';

export interface PushTableProgress {
  table: PushTableName;
  status: 'pending' | 'copying' | 'done' | 'error';
  sourceRows: number;
  copiedRows: number;
  error?: string;
}

export interface PushJobState {
  status: 'queued' | 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  tables: PushTableProgress[];
  error?: string;
}

const TABLES: PushTableName[] = ['card_database', 'card_variations'];

// Columns we copy. Excludes primary key `id` so prod assigns its own serial IDs
// and there is no conflict with prod's existing sequence. Kept in sync with
// shared/schema.ts — if you add a column to either table, add it here too.
const TABLE_COLUMNS: Record<PushTableName, string[]> = {
  card_database: [
    'brand_id', 'brand', 'year', 'collection', 'set',
    'card_number_raw', 'cmp_number', 'player_name', 'team',
    'rookie_flag', 'notes', 'created_at',
  ],
  card_variations: [
    'brand_id', 'brand', 'year', 'collection', 'set',
    'variation_or_parallel', 'serial_number', 'cmp_number',
    'hobby_odds', 'jumbo_odds', 'breaker_odds', 'value_odds',
    'created_at',
  ],
};

function colList(cols: string[]): string {
  // Quote each column to handle reserved words like "set".
  return cols.map((c) => `"${c}"`).join(', ');
}

/**
 * Stream one table from source DB to target DB using Postgres COPY.
 * Returns the number of rows copied. Source-side row count is reported via
 * the progress callback before the copy starts.
 */
async function copyTable(
  sourcePool: pg.Pool,
  targetPool: pg.Pool,
  table: PushTableName,
  onProgress: (p: Partial<PushTableProgress>) => void,
): Promise<number> {
  const cols = TABLE_COLUMNS[table];
  const colsSql = colList(cols);

  // Count source rows up front so the UI can show a denominator
  const sourceClient = await sourcePool.connect();
  const targetClient = await targetPool.connect();

  try {
    const countRes = await sourceClient.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    const sourceRows = parseInt(countRes.rows[0]?.count ?? '0', 10);
    onProgress({ status: 'copying', sourceRows, copiedRows: 0 });

    // Truncate target table inside an explicit transaction so any failure
    // mid-copy rolls back and prod is left with its previous data intact.
    await targetClient.query('BEGIN');
    await targetClient.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);

    const sourceStream = sourceClient.query(
      copyTo(`COPY (SELECT ${colsSql} FROM ${table}) TO STDOUT WITH (FORMAT binary)`),
    );
    const targetStream = targetClient.query(
      copyFrom(`COPY ${table} (${colsSql}) FROM STDIN WITH (FORMAT binary)`),
    );

    // Count rough progress from bytes flowing through, but we report rows
    // only at the end (binary COPY doesn't yield per-row events cheaply).
    await pipeline(sourceStream, targetStream);

    await targetClient.query('COMMIT');

    const afterRes = await targetClient.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    const copiedRows = parseInt(afterRes.rows[0]?.count ?? '0', 10);
    onProgress({ status: 'done', copiedRows });
    return copiedRows;
  } catch (err) {
    try { await targetClient.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    sourceClient.release();
    targetClient.release();
  }
}

/**
 * Run a full push of card_database + card_variations from this app's DB to
 * the database pointed at by PROD_DATABASE_URL.
 *
 * Mutates the shared job state object in place so the polling endpoint can
 * report live progress.
 */
export async function runPushToProdJob(
  job: PushJobState,
  prodConnectionString: string,
  sourcePool: pg.Pool,
): Promise<void> {
  job.status = 'running';

  const targetPool = new pg.Pool({
    connectionString: prodConnectionString,
    // Many managed Postgres providers (incl. Neon) require SSL.
    ssl: { rejectUnauthorized: false },
    max: 4,
  });

  try {
    for (const table of TABLES) {
      const tableState = job.tables.find((t) => t.table === table)!;
      try {
        await copyTable(sourcePool, targetPool, table, (p) => {
          Object.assign(tableState, p);
        });
      } catch (err: any) {
        tableState.status = 'error';
        tableState.error = err?.message || String(err);
        throw err;
      }
    }

    job.status = 'done';
    job.finishedAt = Date.now();
  } catch (err: any) {
    job.status = 'error';
    job.error = err?.message || String(err);
    job.finishedAt = Date.now();
  } finally {
    await targetPool.end().catch(() => undefined);
  }
}

export function makeInitialJobState(): PushJobState {
  return {
    status: 'queued',
    startedAt: Date.now(),
    tables: TABLES.map((t) => ({
      table: t,
      status: 'pending',
      sourceRows: 0,
      copiedRows: 0,
    })),
  };
}
