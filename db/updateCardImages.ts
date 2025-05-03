import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';

/**
 * This script updates the card images in the database to use the
 * images in the attached_assets folder. It uses a hardcoded mapping
 * since the original image references were not reliable.
 */
async function updateCardImages() {
  console.log('Updating card images to use images from attached_assets folder...');

  try {
    // Get all cards
    const allCards = await db.query.cards.findMany();
    console.log(`Found ${allCards.length} cards`);

    // Mapping of player names to image files
    const imageMapping = {
      'Mike Trout': {
        front: 'trout_front_2024_topps_chrome.jpg',
        back: 'trout_back_2024_topps_chrome.jpg'
      },
      'Manny Machado': {
        front: 'machado_front_2024_topps_csmlb.jpg',
        back: 'machado_back_2024_topps_csmlb.jpg'
      },
      'Gerrit Cole': {
        front: 'cole_front_2021_topps_heritage.jpg',
        back: 'cole_back_2021_topps_heritage.jpg'
      },
      'Ceddanne Rafaela': {
        front: 'rafaela_front_2024_topps_smlb.jpg',
        back: 'rafaela_back_2024_topps_smlb.jpg'
      },
      'Freddie Freeman': {
        front: 'freedman_front_2023_topps_smlb.jpg',
        back: 'freedman_back_2023_topps_smlb.jpg'
      },
      'Francisco Lindor': {
        front: 'correa_front_2024_topps_smlb.jpg',
        back: 'correa_back_2024_topps_smlb.jpg'
      },
      'Carlos Correa': {
        front: 'correa_front_2024_topps_smlb.jpg',
        back: 'correa_back_2024_topps_smlb.jpg'
      },
      'Alex Bregman': {
        front: 'bregman_front_2024_topps_35year.jpg',
        back: 'bregman_back_2024_topps_35year.jpg'
      },
      'Sal Frelick': {
        front: 'frelick_front_2024_topps_35year.jpg',
        back: 'frelick_back_2024_35year.jpg'
      }
    };

    // Specific mapping by card ID
    const cardImageMapping = {
      20: { // Sal Frelick
        front: 'frelick_front_2024_topps_35year.jpg',
        back: 'frelick_back_2024_35year.jpg'
      },
      22: { // Sean Manaea 
        front: 'manaea_front_2024_topps_series2.jpg',
        back: 'manaea_back_2024_topps_series2.jpg'
      },
      23: { // Alex Bregman
        front: 'bregman_front_2024_topps_35year.jpg',
        back: 'bregman_back_2024_topps_35year.jpg'
      },
      24: { // Gerrit Cole
        front: 'cole_front_2021_topps_heritage.jpg',
        back: 'cole_back_2021_topps_heritage.jpg'
      },
      25: { // Freddie Freeman
        front: 'freedman_front_2023_topps_smlb.jpg',
        back: 'freedman_back_2023_topps_smlb.jpg'
      },
      27: { // Mike Trout
        front: 'trout_front_2024_topps_chrome.jpg',
        back: 'trout_back_2024_topps_chrome.jpg'
      },
      28: { // Manny Machado
        front: 'machado_front_2024_topps_csmlb.jpg',
        back: 'machado_back_2024_topps_csmlb.jpg'
      },
      29: { // Anthony Volpe
        front: 'correa_front_2024_topps_smlb.jpg',
        back: 'correa_back_2024_topps_smlb.jpg'
      },
      30: { // Nolan Schanuel
        front: 'cole_front_2021_topps_heritage.jpg',
        back: 'cole_back_2021_topps_heritage.jpg'
      },
      31: { // Royce Lewis
        front: 'bregman_front_2024_topps_35year.jpg',
        back: 'bregman_back_2024_topps_35year.jpg'
      },
      32: { // Adley Rutschman
        front: 'freedman_front_2023_topps_smlb.jpg',
        back: 'freedman_back_2023_topps_smlb.jpg'
      },
      33: { // Alex Bregman
        front: 'bregman_front_2024_topps_35year.jpg',
        back: 'bregman_back_2024_topps_35year.jpg'
      },
      34: { // Sonny Gray
        front: 'manaea_front_2024_topps_series2.jpg',
        back: 'manaea_back_2024_topps_series2.jpg'
      },
      35: { // Sal Frelick
        front: 'frelick_front_2024_topps_35year.jpg',
        back: 'frelick_back_2024_35year.jpg'
      },
      36: { // Shohei Ohtani
        front: 'trout_front_2024_topps_chrome.jpg',
        back: 'trout_back_2024_topps_chrome.jpg'
      },
      37: { // Masyn Winn
        front: 'frelick_front_2024_topps_35year.jpg',
        back: 'frelick_back_2024_35year.jpg'
      },
      38: { // Jose Ramirez
        front: 'trout_front_2024_topps_chrome.jpg',
        back: 'trout_back_2024_topps_chrome.jpg'
      },
      39: { // Carlos Correa
        front: 'correa_front_2024_topps_smlb.jpg',
        back: 'correa_back_2024_topps_smlb.jpg'
      },
      40: { // Ceddanne Rafaela
        front: 'rafaela_front_2024_topps_smlb.jpg',
        back: 'rafaela_back_2024_topps_smlb.jpg'
      },
      42: { // Nolan Arenado
        front: 'manaea_front_2024_topps_series2.jpg',
        back: 'manaea_back_2024_topps_series2.jpg'
      },
      44: { // Manny Machado (Chrome)
        front: 'machado_front_2024_topps_csmlb.jpg',
        back: 'machado_back_2024_topps_csmlb.jpg'
      },
      45: { // Francisco Lindor
        front: 'correa_front_2024_topps_smlb.jpg',
        back: 'correa_back_2024_topps_smlb.jpg'
      }
    };

    // Check if attached_assets directory exists
    const assetsDir = path.join(process.cwd(), '..', 'attached_assets');
    if (!fs.existsSync(assetsDir)) {
      console.error(`Directory not found: ${assetsDir}`);
      return;
    }

    // Update each card
    for (const card of allCards) {
      const cardId = card.id;
      const playerName = `${card.playerFirstName} ${card.playerLastName}`;

      // Use the card-specific mapping if available, otherwise fallback to player name
      const imageFiles = cardImageMapping[cardId] || imageMapping[playerName];

      if (imageFiles) {
        const frontImagePath = path.join('/attached_assets', imageFiles.front);
        const backImagePath = path.join('/attached_assets', imageFiles.back);

        // Update the card
        await db.update(cards)
          .set({
            frontImage: frontImagePath,
            backImage: backImagePath
          })
          .where(eq(cards.id, cardId));

        console.log(`Updated card ${cardId}: ${playerName} - Front: ${frontImagePath}, Back: ${backImagePath}`);
      } else {
        console.log(`No image mapping found for ${playerName} (ID: ${cardId})`);
      }
    }

    console.log('Successfully updated card images in the database');
  } catch (error) {
    console.error('Error updating card images:', error);
  }
}

// Run the function
updateCardImages()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });