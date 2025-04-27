import { db } from './index';
import { cards } from '@shared/schema';
import { eq } from 'drizzle-orm';

/**
 * This script updates existing "Chrome Stars of MLB" cards to use
 * "Stars of MLB" as the collection and "Chrome" as the variant.
 */
async function updateChromeCards() {
  try {
    console.log('Starting Chrome card collection update...');
    
    // Find all cards with "Chrome Stars of MLB" collection
    const chromeCards = await db.query.cards.findMany({
      where: eq(cards.collection, 'Chrome Stars of MLB')
    });
    
    console.log(`Found ${chromeCards.length} Chrome Stars of MLB cards to update`);
    
    // Update each card to use Stars of MLB collection with Chrome variant
    for (const card of chromeCards) {
      console.log(`Updating card ID ${card.id}: ${card.playerFirstName} ${card.playerLastName} #${card.cardNumber}`);
      
      await db.update(cards)
        .set({
          collection: 'Stars of MLB',
          variant: 'Chrome'
        })
        .where(eq(cards.id, card.id));
    }
    
    console.log('Chrome card update completed successfully');
  } catch (error) {
    console.error('Error updating Chrome cards:', error);
  }
}

updateChromeCards().then(() => {
  console.log('Database update script completed');
  process.exit(0);
}).catch((error) => {
  console.error('Script failed with error:', error);
  process.exit(1);
});