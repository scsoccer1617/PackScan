import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * This script fixes the George Frazier card image
 */
async function fixFrazierImage() {
  console.log('Fixing George Frazier card image...');

  try {
    // Update the George Frazier card (ID 23)
    await db.update(cards)
      .set({
        frontImage: '/uploads/1748135529468_Frazier_front.jpg',
        backImage: '/uploads/1748135529471_Frazier_back.jpg'
      })
      .where(eq(cards.id, 23));
    
    console.log('Successfully updated George Frazier card image');
  } catch (error) {
    console.error('Error updating George Frazier card image:', error);
  }
}

// Run the function
fixFrazierImage()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });