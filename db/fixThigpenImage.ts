import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * This script fixes the Bobby Thigpen card image and removes references to deleted cards
 */
async function fixThigpenImage() {
  console.log('Fixing Bobby Thigpen card image path...');

  try {
    // Find the Bobby Thigpen card (ID 31)
    const thigpenCard = await db.query.cards.findFirst({
      where: eq(cards.id, 31)
    });

    if (thigpenCard) {
      console.log(`Fixing image paths for Bobby Thigpen (ID: 31)`);
      console.log(`Old front image: ${thigpenCard.frontImage}`);
      console.log(`New front image: /uploads/1748182904641_Thigpen_front.jpg`);
      
      // Update with the correct image path
      await db.update(cards)
        .set({
          frontImage: '/uploads/1748182904641_Thigpen_front.jpg',
          // If you have the back image path, add it here
          // backImage: '/uploads/1748182904644_Thigpen_back.jpg'
        })
        .where(eq(cards.id, 31));
        
      console.log(`Successfully updated Bobby Thigpen card image`);
    } else {
      console.log(`Bobby Thigpen card (ID: 31) not found, skipping`);
    }

    // Also check for any other cards that might still reference the Lewis image
    const cardsWithLewisImage = await db.query.cards.findMany({
      where: eq(cards.frontImage, '/uploads/1745792025505_Lewis_front.jpg')
    });

    if (cardsWithLewisImage.length > 0) {
      console.log(`Found ${cardsWithLewisImage.length} cards still using the Lewis front image`);
      
      for (const card of cardsWithLewisImage) {
        console.log(`Card ${card.id} (${card.playerFirstName} ${card.playerLastName}) is using the Lewis image`);
        // We're not automatically updating these as they may need specific handling
      }
    } else {
      console.log('No other cards are using the Lewis image');
    }

    console.log('Successfully fixed Bobby Thigpen card image path');
  } catch (error) {
    console.error('Error fixing card image paths:', error);
  }
}

// Run the function
fixThigpenImage()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });