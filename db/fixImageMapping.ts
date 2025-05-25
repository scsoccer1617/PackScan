import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';

/**
 * This script fixes the image paths for the problematic cards
 */
async function fixImageMapping() {
  console.log('Fixing image paths for problematic cards...');

  try {
    // Cards to fix - map of ID to correct image paths
    const cardsToFix = {
      27: { // George Frazier
        frontImage: '/uploads/1748135529468_Frazier_front.jpg',
        backImage: '/uploads/1748135529471_Frazier_back.jpg'
      },
      28: { // Norm Charlton
        frontImage: '/uploads/1748136695127_Charlton_front.jpg',
        backImage: '/uploads/1748136695130_Charlton_back.jpg'
      },
      29: { // Dave Bergman
        frontImage: '/uploads/1748179343891_Bergman_front.jpg',
        backImage: '/uploads/1748179343894_Bergman_back.jpg'
      }
    };

    // Update each card with the correct paths
    for (const [idStr, imagePaths] of Object.entries(cardsToFix)) {
      const id = parseInt(idStr, 10);
      console.log(`Updating image paths for card ${id}...`);

      // Get the card to verify it exists
      const card = await db.query.cards.findFirst({
        where: eq(cards.id, id)
      });

      if (!card) {
        console.log(`Card ${id} not found, skipping`);
        continue;
      }

      console.log(`Found card: ${card.playerFirstName} ${card.playerLastName}`);
      console.log(`Current front image: ${card.frontImage}`);
      console.log(`Current back image: ${card.backImage}`);
      console.log(`New front image: ${imagePaths.frontImage}`);
      console.log(`New back image: ${imagePaths.backImage}`);

      // Make sure the new image files exist
      const frontExists = fs.existsSync(path.join(process.cwd(), imagePaths.frontImage.replace(/^\//, '')));
      const backExists = fs.existsSync(path.join(process.cwd(), imagePaths.backImage.replace(/^\//, '')));

      console.log(`Front image exists: ${frontExists}`);
      console.log(`Back image exists: ${backExists}`);

      if (frontExists && backExists) {
        // Update the database with the correct paths
        await db.update(cards)
          .set({
            frontImage: imagePaths.frontImage,
            backImage: imagePaths.backImage
          })
          .where(eq(cards.id, id));
        console.log(`Successfully updated card ${id}`);
      } else {
        console.log(`Image files not found for card ${id}, skipping update`);
      }
    }

    console.log('Successfully fixed all image mappings');
  } catch (error) {
    console.error('Error fixing image mappings:', error);
  }
}

// Run the function
fixImageMapping()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });