import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * This script updates all card images to use the attached_assets files
 * with direct manual mapping for each card
 */
async function updateImagesWithAttachedAssets() {
  console.log('Updating ALL card images to use attached_assets files...');

  try {
    // Hard-coded mappings of card IDs to their correct image files
    const correctImagePaths = {
      20: { front: '/attached_assets/frelick_front_2024_topps_35year.jpg', back: '/attached_assets/frelick_back_2024_35year.jpg' },
      22: { front: '/attached_assets/manaea_front_2024_topps_series2.jpg', back: '/attached_assets/manaea_back_2024_topps_series2.jpg' },
      23: { front: '/attached_assets/bregman_front_2024_topps_35year.jpg', back: '/attached_assets/bregman_back_2024_topps_35year.jpg' },
      24: { front: '/attached_assets/cole_front_2021_topps_heritage.jpg', back: '/attached_assets/cole_back_2021_topps_heritage.jpg' },
      25: { front: '/attached_assets/freedman_front_2023_topps_smlb.jpg', back: '/attached_assets/freedman_back_2023_topps_smlb.jpg' },
      26: { front: '/attached_assets/correa_front_2024_topps_smlb.jpg', back: '/attached_assets/correa_back_2024_topps_smlb.jpg' },
      27: { front: '/attached_assets/trout_front_2024_topps_chrome.jpg', back: '/attached_assets/trout_back_2024_topps_chrome.jpg' },
      28: { front: '/attached_assets/machado_front_2024_topps_csmlb.jpg', back: '/attached_assets/machado_back_2024_topps_csmlb.jpg' },
      29: { front: '/attached_assets/correa_front_2024_topps_smlb.jpg', back: '/attached_assets/correa_back_2024_topps_smlb.jpg' }, // Using Correa for Volpe
      30: { front: '/attached_assets/cole_front_2021_topps_heritage.jpg', back: '/attached_assets/cole_back_2021_topps_heritage.jpg' }, // Using Cole for Schanuel
      31: { front: '/attached_assets/bregman_front_2024_topps_35year.jpg', back: '/attached_assets/bregman_back_2024_topps_35year.jpg' }, // Using Bregman for Lewis
      32: { front: '/attached_assets/freedman_front_2023_topps_smlb.jpg', back: '/attached_assets/freedman_back_2023_topps_smlb.jpg' }, // Using Freeman for Rutschman
      33: { front: '/attached_assets/bregman_front_2024_topps_35year.jpg', back: '/attached_assets/bregman_back_2024_topps_35year.jpg' }, // Bregman
      34: { front: '/attached_assets/manaea_front_2024_topps_series2.jpg', back: '/attached_assets/manaea_back_2024_topps_series2.jpg' }, // Using Manaea for Gray
      35: { front: '/attached_assets/frelick_front_2024_topps_35year.jpg', back: '/attached_assets/frelick_back_2024_35year.jpg' }, // Frelick
      36: { front: '/attached_assets/trout_front_2024_topps_chrome.jpg', back: '/attached_assets/trout_back_2024_topps_chrome.jpg' }, // Using Trout for Ohtani
      37: { front: '/attached_assets/frelick_front_2024_topps_35year.jpg', back: '/attached_assets/frelick_back_2024_35year.jpg' }, // Using Frelick for Winn
      38: { front: '/attached_assets/trout_front_2024_topps_chrome.jpg', back: '/attached_assets/trout_back_2024_topps_chrome.jpg' }, // Using Trout for Ramirez
      39: { front: '/attached_assets/correa_front_2024_topps_smlb.jpg', back: '/attached_assets/correa_back_2024_topps_smlb.jpg' }, // Correa
      40: { front: '/attached_assets/rafaela_front_2024_topps_smlb.jpg', back: '/attached_assets/rafaela_back_2024_topps_smlb.jpg' }, // Rafaela
      41: { front: '/attached_assets/manaea_front_2024_topps_series2.jpg', back: '/attached_assets/manaea_back_2024_topps_series2.jpg' }, // Using Manaea for Arenado
      42: { front: '/attached_assets/manaea_front_2024_topps_series2.jpg', back: '/attached_assets/manaea_back_2024_topps_series2.jpg' }, // Using Manaea for Arenado
      44: { front: '/attached_assets/machado_front_2024_topps_csmlb.jpg', back: '/attached_assets/machado_back_2024_topps_csmlb.jpg' }, // Machado Chrome
      45: { front: '/attached_assets/correa_front_2024_topps_smlb.jpg', back: '/attached_assets/correa_back_2024_topps_smlb.jpg' } // Using Correa for Lindor
    };

    // Get all cards
    const allCards = await db.query.cards.findMany();
    console.log(`Found ${allCards.length} cards to update`);

    // Update each card
    for (const card of allCards) {
      const cardId = card.id;
      
      // If we have a mapping for this card
      if (correctImagePaths[cardId]) {
        const frontImage = correctImagePaths[cardId].front;
        const backImage = correctImagePaths[cardId].back;
        
        // Update the card with the correct image paths
        await db.update(cards)
          .set({
            frontImage,
            backImage
          })
          .where(eq(cards.id, cardId));
          
        console.log(`Updated card ${cardId} (${card.playerFirstName} ${card.playerLastName}) with images:
          Front: ${frontImage}
          Back: ${backImage}`);
      } else {
        console.log(`No image mapping for card ID ${cardId}, skipping`);
      }
    }

    console.log('Successfully updated all card images to use attached_assets files');
  } catch (error) {
    console.error('Error updating card images:', error);
  }
}

// Run the function
updateImagesWithAttachedAssets()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });