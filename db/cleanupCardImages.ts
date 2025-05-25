import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * This script cleans up incorrect image references and sets proper images for cards
 */
async function cleanupCardImages() {
  console.log('Cleaning up incorrect card image references...');

  try {
    // Define the cards to fix with their correct image paths
    const cardsToFix = [
      {
        id: 31, // Bobby Thigpen
        frontImage: '/uploads/1748182904641_Thigpen_front.jpg',
        backImage: '/uploads/1748182904644_Thigpen_back.jpg' // Assuming this is the back image path
      },
      {
        id: 32, // Chris James
        frontImage: '/uploads/1748183764583_James_front.jpg',
        backImage: '/uploads/1748183764586_James_back.jpg' // Assuming this is the back image path
      }
    ];

    for (const cardToFix of cardsToFix) {
      // Get the current card data
      const card = await db.query.cards.findFirst({
        where: eq(cards.id, cardToFix.id)
      });

      if (card) {
        console.log(`Fixing image paths for card ${cardToFix.id}: ${card.playerFirstName} ${card.playerLastName}`);
        console.log(`  Old front image: ${card.frontImage}`);
        console.log(`  New front image: ${cardToFix.frontImage}`);
        
        // Update the card with correct image paths
        await db.update(cards)
          .set({
            frontImage: cardToFix.frontImage,
            backImage: cardToFix.backImage
          })
          .where(eq(cards.id, cardToFix.id));
          
        console.log(`Successfully updated card ${cardToFix.id}`);
      } else {
        console.log(`Card ${cardToFix.id} not found, skipping`);
      }
    }

    // Find any other cards still using deleted card images
    const problematicImages = [
      '/uploads/1745792025505_Lewis_front.jpg',
      '/uploads/1745796442080_Rutschman_front.jpg'
    ];

    for (const imagePath of problematicImages) {
      const cardsWithProblematicImage = await db.query.cards.findMany({
        where: eq(cards.frontImage, imagePath)
      });

      if (cardsWithProblematicImage.length > 0) {
        console.log(`WARNING: Found ${cardsWithProblematicImage.length} cards still using problematic image: ${imagePath}`);
        
        for (const card of cardsWithProblematicImage) {
          console.log(`  Card ID ${card.id}: ${card.playerFirstName} ${card.playerLastName}`);
        }
      } else {
        console.log(`No cards found using problematic image: ${imagePath}`);
      }
    }

    console.log('Successfully cleaned up card image references');
  } catch (error) {
    console.error('Error cleaning up card image references:', error);
  }
}

// Run the function
cleanupCardImages()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });