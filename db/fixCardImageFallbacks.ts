import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';

/**
 * This script fixes the card image fallbacks in the server code
 */
async function fixCardImageFallbacks() {
  console.log('Setting up correct image fallbacks for problematic cards...');

  try {
    // Check if the images actually exist in the uploads directory
    const uploadsDir = path.join(process.cwd(), 'uploads');
    const filesInUploads = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
    
    // Get the attached assets directory
    const assetsDir = path.join(process.cwd(), 'attached_assets');
    const filesInAssets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
    
    console.log(`Found ${filesInUploads.length} files in uploads directory`);
    console.log(`Found ${filesInAssets.length} files in attached_assets directory`);
    
    // Get all cards with George Frazier, Norm Charlton, and Dave Bergman
    const cardsToFix = await db.query.cards.findMany({
      where: eq(cards.id, 27) || eq(cards.id, 28) || eq(cards.id, 29)
    });

    // For each card, check if the image files exist
    for (const card of cardsToFix) {
      const frontImagePath = card.frontImage?.replace(/^\//, '');
      const backImagePath = card.backImage?.replace(/^\//, '');
      
      console.log(`Checking card ${card.id}: ${card.playerFirstName} ${card.playerLastName}`);
      console.log(`  Front image: ${frontImagePath}`);
      console.log(`  Back image: ${backImagePath}`);
      
      const frontExists = frontImagePath ? fs.existsSync(path.join(process.cwd(), frontImagePath)) : false;
      const backExists = backImagePath ? fs.existsSync(path.join(process.cwd(), backImagePath)) : false;
      
      console.log(`  Front image exists: ${frontExists}`);
      console.log(`  Back image exists: ${backExists}`);
      
      // Look for fallback images in attached_assets
      let frontFallback = null;
      let backFallback = null;
      
      // Map card IDs to fallback images
      if (card.id === 27) { // George Frazier
        frontFallback = 'bregman_front_2024_topps_35year.jpg';
        backFallback = 'bregman_back_2024_topps_35year.jpg';
      } else if (card.id === 28) { // Norm Charlton
        frontFallback = 'machado_front_2024_topps_csmlb.jpg';
        backFallback = 'machado_back_2024_topps_csmlb.jpg';
      } else if (card.id === 29) { // Dave Bergman
        frontFallback = 'frelick_front_2024_topps_35year.jpg';
        backFallback = 'frelick_back_2024_35year.jpg';
      }
      
      console.log(`  Front fallback: ${frontFallback}`);
      console.log(`  Back fallback: ${backFallback}`);
      
      // Verify fallbacks exist
      const frontFallbackExists = frontFallback ? filesInAssets.includes(frontFallback) : false;
      const backFallbackExists = backFallback ? filesInAssets.includes(backFallback) : false;
      
      console.log(`  Front fallback exists: ${frontFallbackExists}`);
      console.log(`  Back fallback exists: ${backFallbackExists}`);
      
      // If original image doesn't exist but fallback does, update the database
      if (!frontExists && frontFallbackExists) {
        const newFrontPath = `/attached_assets/${frontFallback}`;
        console.log(`  Updating front image to: ${newFrontPath}`);
        await db.update(cards)
          .set({ frontImage: newFrontPath })
          .where(eq(cards.id, card.id));
      }
      
      if (!backExists && backFallbackExists) {
        const newBackPath = `/attached_assets/${backFallback}`;
        console.log(`  Updating back image to: ${newBackPath}`);
        await db.update(cards)
          .set({ backImage: newBackPath })
          .where(eq(cards.id, card.id));
      }
    }

    console.log('Successfully fixed all card image fallbacks');
  } catch (error) {
    console.error('Error fixing card image fallbacks:', error);
  }
}

// Run the function
fixCardImageFallbacks()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });