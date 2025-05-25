import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * This script updates card images to use only the correct user-provided images
 * Any cards not in the list will be fixed or removed
 */
async function updateWithCorrectUserImages() {
  console.log('Updating card images to use only the correct user-provided images...');

  try {
    // List of valid front images provided by the user
    const validFrontImages = [
      '/uploads/1748048494981_Rafaela_front.jpg',
      '/uploads/1748048678781_Frelick_front.jpg',
      '/uploads/1748098999257_Machado_front.jpg',
      '/uploads/1748117697563_Bell_front.jpg',
      '/uploads/1748119546246_Wicks_front.jpg',
      '/uploads/1748119870910_Ramirez_front.jpg',
      '/uploads/1748120190492_Rodriguez_front.jpg',
      '/uploads/1748121530946_Votto_front.jpg',
      '/uploads/1748122748796_Bart_front.jpg',
      '/uploads/1748123845706_Gallen_front.jpg',
      '/uploads/1748131267927_Encarnacion-Strand_front.jpg',
      '/uploads/1748131671690_Tatis Jr._front.jpg',
      '/uploads/1748132139341_Renfroe_front.jpg',
      '/uploads/1748132522619_Grisham_front.jpg',
      '/uploads/1748132924215_Acuña Jr._front.jpg',
      '/uploads/1748133634522_Dunning_front.jpg',
      '/uploads/1748133932010_LEAGUE BASEBALL®_front.jpg',
      '/uploads/1748134059644_Blue Jays_front.jpg',
      '/uploads/1748134305932_Harper_front.jpg',
      '/uploads/1748135529468_Frazier_front.jpg',
      '/uploads/1748136695127_Charlton_front.jpg',
      '/uploads/1748179343891_Bergman_front.jpg'
    ];

    // Get all cards
    const allCards = await db.query.cards.findMany();
    console.log(`Found ${allCards.length} cards in database`);

    // Keep track of which cards we've updated
    const updatedCardIds = new Set<number>();

    // For each card, check if its front image is in the valid list
    for (const card of allCards) {
      const cardId = card.id;
      const currentFrontImage = card.frontImage;
      
      // Skip if the card already has a valid front image
      if (validFrontImages.includes(currentFrontImage)) {
        console.log(`Card ${cardId} (${card.playerFirstName} ${card.playerLastName}) already has valid image: ${currentFrontImage}`);
        updatedCardIds.add(cardId);
        continue;
      }
      
      // For cards with invalid images, find a potential match based on player name
      const playerName = `${card.playerFirstName} ${card.playerLastName}`.trim();
      
      // Find an image that might match this player
      const matchingImage = validFrontImages.find(img => {
        const imgName = img.split('/').pop().split('_')[0];
        return imgName && playerName.includes(imgName) || (imgName && playerName.includes(imgName.replace(' Jr.', '')));
      });
      
      if (matchingImage) {
        // Update the card with the matching image
        await db.update(cards)
          .set({
            frontImage: matchingImage,
            // Derive the back image path from the front image
            backImage: matchingImage.replace('_front.', '_back.')
          })
          .where(eq(cards.id, cardId));
          
        console.log(`Updated card ${cardId} (${playerName}) with matching image: ${matchingImage}`);
        updatedCardIds.add(cardId);
      } else {
        console.log(`No matching image found for card ${cardId} (${playerName}), current image: ${currentFrontImage}`);
      }
    }
    
    // Check for any cards that weren't updated
    const nonUpdatedCards = allCards.filter(card => !updatedCardIds.has(card.id));
    
    if (nonUpdatedCards.length > 0) {
      console.log(`Found ${nonUpdatedCards.length} cards without valid images:`);
      for (const card of nonUpdatedCards) {
        console.log(`- Card ${card.id}: ${card.playerFirstName} ${card.playerLastName}, current image: ${card.frontImage}`);
      }
    } else {
      console.log('All cards have valid images');
    }

    console.log('Successfully updated card images');
  } catch (error) {
    console.error('Error updating card images:', error);
  }
}

// Run the function
updateWithCorrectUserImages()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });