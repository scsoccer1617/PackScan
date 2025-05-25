import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * This script removes specific cards that have been deleted by the user
 */
async function removeDeletedCards() {
  console.log('Removing cards with incorrect image paths...');

  try {
    // List of card IDs to be removed
    const cardsToRemove = [
      20, // "MAJOR LEAGUE BASEBALL®" with front_8129dc81 image
      23, // George Frazier with front_13f82788 image
      24, // Norm Charlton with front_49f545ba image
      25  // Dave Bergman with front_30a3619b image
    ];

    for (const cardId of cardsToRemove) {
      // Get the card first to log what we're removing
      const cardToRemove = await db.query.cards.findFirst({
        where: eq(cards.id, cardId)
      });

      if (cardToRemove) {
        console.log(`Removing card ${cardId}: ${cardToRemove.playerFirstName} ${cardToRemove.playerLastName}, image: ${cardToRemove.frontImage}`);
        
        // Delete the card
        await db.delete(cards).where(eq(cards.id, cardId));
        console.log(`Successfully removed card ${cardId}`);
      } else {
        console.log(`Card ${cardId} not found, skipping`);
      }
    }

    console.log('Successfully removed all specified cards');
  } catch (error) {
    console.error('Error removing cards:', error);
  }
}

// Run the function
removeDeletedCards()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });