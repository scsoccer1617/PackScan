import pg from "pg";

let syncPool: pg.Pool | null = null;

function getSyncPool(): pg.Pool | null {
  if (syncPool) return syncPool;

  const syncUrl = process.env.SYNC_DATABASE_URL;
  if (!syncUrl) {
    console.log('SYNC_DATABASE_URL not configured - confirmed card sync disabled');
    return null;
  }

  syncPool = new pg.Pool({
    connectionString: syncUrl,
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  syncPool.on('error', (err) => {
    console.error('Sync database pool error:', err.message);
    syncPool = null;
  });

  console.log('Sync database pool initialized');
  return syncPool;
}

interface ConfirmedCardData {
  sport: string;
  playerFirstName: string;
  playerLastName: string;
  brand: string;
  collection: string | null;
  cardNumber: string;
  year: number;
  variant: string | null;
  serialLimit: string | null;
  isRookieCard: boolean;
  isAutographed: boolean;
  isNumbered: boolean;
}

export async function syncConfirmedCard(data: ConfirmedCardData): Promise<boolean> {
  const pool = getSyncPool();
  if (!pool) return false;

  try {
    const client = await pool.connect();
    try {
      const checkQuery = data.variant
        ? `SELECT id, confirm_count FROM confirmed_cards 
           WHERE card_number = $1 AND year = $2 AND brand = $3 AND player_last_name = $4 AND variant = $5
           LIMIT 1`
        : `SELECT id, confirm_count FROM confirmed_cards 
           WHERE card_number = $1 AND year = $2 AND brand = $3 AND player_last_name = $4 AND variant IS NULL
           LIMIT 1`;

      const checkParams = data.variant
        ? [data.cardNumber, data.year, data.brand, data.playerLastName, data.variant]
        : [data.cardNumber, data.year, data.brand, data.playerLastName];

      const existing = await client.query(checkQuery, checkParams);

      if (existing.rows.length > 0) {
        await client.query(
          `UPDATE confirmed_cards SET confirm_count = confirm_count + 1, updated_at = NOW() WHERE id = $1`,
          [existing.rows[0].id]
        );
        console.log(`Sync DB: Incremented confirm count for ${data.playerFirstName} ${data.playerLastName} #${data.cardNumber}`);
      } else {
        await client.query(
          `INSERT INTO confirmed_cards (sport, player_first_name, player_last_name, brand, collection, card_number, year, variant, serial_limit, is_rookie_card, is_autographed, is_numbered, confirm_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1)`,
          [
            data.sport,
            data.playerFirstName,
            data.playerLastName,
            data.brand,
            data.collection,
            data.cardNumber,
            data.year,
            data.variant,
            data.serialLimit,
            data.isRookieCard,
            data.isAutographed,
            data.isNumbered,
          ]
        );
        console.log(`Sync DB: Inserted new confirmed card for ${data.playerFirstName} ${data.playerLastName} #${data.cardNumber}`);
      }

      client.release();
      return true;
    } catch (queryErr: any) {
      client.release();
      throw queryErr;
    }
  } catch (err: any) {
    console.error('Sync database write failed (non-blocking):', err.message);
    return false;
  }
}
