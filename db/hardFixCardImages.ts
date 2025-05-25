import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';

/**
 * This script forces the correct image paths directly
 */
async function hardFixCardImages() {
  console.log('Forcing correct image paths for problematic cards...');

  try {
    // Define the problematic cards and their correct image paths
    const cardsToFix = [
      {
        id: 31, // Bobby Thigpen
        frontImage: '/uploads/1748182904641_Thigpen_front.jpg',
        backImage: '/uploads/1748182904644_Thigpen_back.jpg',
        copyFileTo: 'Thigpen_front.jpg'
      },
      {
        id: 32, // Chris James
        frontImage: '/uploads/1748183726973_James_front.jpg',
        backImage: '/uploads/1748183726976_James_back.jpg',
        copyFileTo: 'James_front.jpg'
      }
    ];

    // Create a copy of the image files to a persistent location
    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    for (const card of cardsToFix) {
      // Get current card info
      const currentCard = await db.query.cards.findFirst({
        where: eq(cards.id, card.id)
      });

      if (!currentCard) {
        console.log(`Card ${card.id} not found, skipping`);
        continue;
      }

      console.log(`Fixing card ${card.id}: ${currentCard.playerFirstName} ${currentCard.playerLastName}`);
      console.log(`Current front image: ${currentCard.frontImage}`);
      console.log(`New front image: ${card.frontImage}`);

      // Get the source file path
      const sourcePath = path.join(process.cwd(), card.frontImage);
      
      // Create a destination file path in uploads directory
      const fixedImageName = `fixed_${card.copyFileTo}`;
      const destPath = path.join(uploadsDir, fixedImageName);
      
      // Copy the file to ensure it exists
      try {
        if (fs.existsSync(sourcePath)) {
          console.log(`Copying image from ${sourcePath} to ${destPath}`);
          fs.copyFileSync(sourcePath, destPath);
          
          // Update the card with the new fixed image path
          const fixedImagePath = `/uploads/${fixedImageName}`;
          
          await db.update(cards)
            .set({
              frontImage: fixedImagePath,
              backImage: card.backImage
            })
            .where(eq(cards.id, card.id));
            
          console.log(`Updated card ${card.id} with fixed image path: ${fixedImagePath}`);
        } else {
          console.log(`Source image not found at ${sourcePath}`);
        }
      } catch (error) {
        console.error(`Error copying image for card ${card.id}:`, error);
      }
    }

    console.log('Successfully fixed problematic card images');
  } catch (error) {
    console.error('Error fixing card images:', error);
  }
}

// Run the function
hardFixCardImages()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });