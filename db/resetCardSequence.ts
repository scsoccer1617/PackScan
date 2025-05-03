import { db } from '.';
import { sql } from 'drizzle-orm';

/**
 * This script resets the card ID sequence to start from 1
 * It should be run only after all cards have been deleted
 */
async function resetCardSequence() {
  console.log('Resetting card ID sequence to start from 1...');

  try {
    // In PostgreSQL, we need to use the ALTER SEQUENCE command to reset the sequence
    // The sequence name follows the pattern: tablename_columnname_seq
    
    // Execute the SQL command to reset the sequence
    await db.execute(sql`ALTER SEQUENCE cards_id_seq RESTART WITH 1`);
    
    console.log('Successfully reset card ID sequence. New cards will start from ID #1');
  } catch (error) {
    console.error('Error resetting card ID sequence:', error);
  }
}

// Run the function
resetCardSequence()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });