import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * This script fixes the image paths for specific cards
 */
async function fixCardImages() {
  console.log('Fixing card image paths...');

  try {
    // Specific image path corrections
    const imageCorrections = [
      {
        id: 27, // George Frazier
        frontImage: '/uploads/1748135529468_Frazier_front.jpg',
        backImage: '/uploads/1748135529471_Frazier_back.jpg'
      },
      {
        id: 28, // Norm Charlton
        frontImage: '/uploads/1748136695127_Charlton_front.jpg',
        backImage: '/uploads/1748136695130_Charlton_back.jpg'
      },
      {
        id: 29, // Dave Bergman
        frontImage: '/uploads/1748179343891_Bergman_front.jpg',
        backImage: '/uploads/1748179343894_Bergman_back.jpg'
      }
    ];

    for (const correction of imageCorrections) {
      // Get the card first to log what we're updating
      const cardToUpdate = await db.query.cards.findFirst({
        where: eq(cards.id, correction.id)
      });

      if (cardToUpdate) {
        console.log(`Fixing image paths for card ${correction.id}: ${cardToUpdate.playerFirstName} ${cardToUpdate.playerLastName}`);
        console.log(`  Old front image: ${cardToUpdate.frontImage}`);
        console.log(`  New front image: ${correction.frontImage}`);
        
        // Update the card images
        await db.update(cards)
          .set({
            frontImage: correction.frontImage,
            backImage: correction.backImage
          })
          .where(eq(cards.id, correction.id));
          
        console.log(`Successfully updated card ${correction.id}`);
      } else {
        console.log(`Card ${correction.id} not found, skipping`);
      }
    }

    console.log('Successfully fixed all card image paths');
  } catch (error) {
    console.error('Error fixing card image paths:', error);
  }
}

// Run the function
fixCardImages()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });