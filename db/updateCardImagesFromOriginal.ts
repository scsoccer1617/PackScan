import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';

/**
 * This script updates the card images in the database to use 
 * the original image paths from the time they were added
 */
async function updateCardImagesFromOriginal() {
  console.log('Updating card images to use original upload paths...');

  try {
    // Get all cards
    const allCards = await db.query.cards.findMany();
    console.log(`Found ${allCards.length} cards`);

    // Original image paths from uploads
    const originalImagePaths = [
      { 
        front: '/uploads/front_8129dc81-f4b9-437c-ba5d-f44394e712a3.jpg',
        back: '/uploads/back_e28fcc8f-d43d-447d-94f5-0b90f27b6c0e.jpg',
        lastUpdated: '2025-04-26T17:23:55.213Z',
        cardId: 20  // Sal Frelick
      },
      { 
        front: '/uploads/front_8f406497-ba8d-4277-94a2-c2f0d6a07d03.jpg',
        back: '/uploads/back_ccf6c8b3-7ab8-4fa5-b545-06e08876abf9.jpg',
        lastUpdated: '2025-04-26T18:07:44.214Z',
        cardId: 22  // Sean Manaea
      },
      { 
        front: '/uploads/front_13f82788-ebc8-427f-8a07-2c9b300c775d.jpg',
        back: '/uploads/back_e0163a54-9032-43ec-88fd-cf673a632c30.jpg',
        lastUpdated: '2025-04-26T18:28:56.601Z',
        cardId: 23  // Alex Bregman
      },
      { 
        front: '/uploads/front_49f545ba-a01a-4a4e-888f-e112da960ec5.jpg',
        back: '/uploads/back_c677a2df-4d66-4397-b808-12c7e6213985.jpg',
        lastUpdated: '2025-04-26T21:36:37.446Z',
        cardId: 24  // Gerrit Cole
      },
      { 
        front: '/uploads/front_30a3619b-69a3-49a0-aba8-94ee4d9bf74a.jpg',
        back: '/uploads/back_ac0c7b2f-722b-400b-bc69-2879ecb9c8ff.jpg',
        lastUpdated: '2025-04-27T14:04:11.549Z',
        cardId: 25  // Freddie Freeman
      },
      { 
        front: '/uploads/front_d0f137cb-27e5-42f6-b70f-a53e59fa47e9.jpg',
        back: '/uploads/back_e52dbdbf-d207-4da8-8e13-0321da15c516.jpg',
        lastUpdated: '2025-04-27T14:44:55.842Z',
        cardId: 26  // Carlos Correa
      },
      { 
        front: '/uploads/1745782254517_Trout_front.jpg',
        back: '/uploads/1745782254523_Trout_back.jpg',
        lastUpdated: '2025-04-27T19:30:55.008Z',
        cardId: 27  // Mike Trout
      },
      { 
        front: '/uploads/1745785721118_Machado_front.jpg',
        back: '/uploads/1745785721128_Machado_back.jpg',
        lastUpdated: '2025-04-27T20:28:42.188Z',
        cardId: 28  // Manny Machado
      },
      { 
        front: '/uploads/1745790593490_Volpe_front.jpg',
        back: '/uploads/1745790593497_Volpe_back.jpg',
        lastUpdated: '2025-04-27T21:49:54.241Z',
        cardId: 29  // Anthony Volpe
      },
      { 
        front: '/uploads/1745791833108_Schanuel_front.jpg',
        back: '/uploads/1745791833113_Schanuel_back.jpg',
        lastUpdated: '2025-04-27T22:10:33.788Z',
        cardId: 30  // Nolan Schanuel
      },
      { 
        front: '/uploads/1745792025505_Lewis_front.jpg',
        back: '/uploads/1745792025510_Lewis_back.jpg',
        lastUpdated: '2025-04-27T22:13:45.812Z',
        cardId: 31  // Royce Lewis
      },
      { 
        front: '/uploads/1745796442080_Rutschman_front.jpg',
        back: '/uploads/1745796442086_Rutschman_back.jpg',
        lastUpdated: '2025-04-27T23:27:22.836Z',
        cardId: 32  // Adley Rutschman
      },
      { 
        front: '/uploads/1745796845930_Bregman_front.jpg',
        back: '/uploads/1745796845936_Bregman_back.jpg',
        lastUpdated: '2025-04-27T23:34:06.469Z',
        cardId: 33  // Alex Bregman
      },
      { 
        front: '/uploads/1745797140216_Gray_front.jpg',
        back: '/uploads/1745797140221_Gray_back.jpg',
        lastUpdated: '2025-04-27T23:39:00.545Z',
        cardId: 34  // Sonny Gray
      },
      { 
        front: '/uploads/1745841448384_Frelick_front.jpg',
        back: '/uploads/1745841448392_Frelick_back.jpg',
        lastUpdated: '2025-04-28T11:57:29.260Z',
        cardId: 35  // Sal Frelick
      },
      { 
        front: '/uploads/1745841615200_Ohtani_front.jpg',
        back: '/uploads/1745841615206_Ohtani_back.jpg',
        lastUpdated: '2025-04-28T12:00:15.791Z',
        cardId: 36  // Shohei Ohtani
      },
      { 
        front: '/uploads/1745866266968_Winn_front.jpg',
        back: '/uploads/1745866266992_Winn_back.jpg',
        lastUpdated: '2025-04-28T18:51:07.796Z',
        cardId: 37  // Masyn Winn
      },
      { 
        front: '/uploads/1745866766706_Ramirez_front.jpg',
        back: '/uploads/1745866766728_Ramirez_back.jpg',
        lastUpdated: '2025-04-28T18:59:27.468Z',
        cardId: 38  // Jose Ramirez
      },
      { 
        front: '/uploads/1745867110234_Correa_front.jpg',
        back: '/uploads/1745867110248_Correa_back.jpg',
        lastUpdated: '2025-04-28T19:05:10.984Z',
        cardId: 39  // Carlos Correa
      },
      { 
        front: '/uploads/1745867368006_Rafaela_front.jpg',
        back: '/uploads/1745867368012_Rafaela_back.jpg',
        lastUpdated: '2025-04-28T19:09:28.903Z',
        cardId: 40  // Ceddanne Rafaela
      },
      { 
        front: '/uploads/1745868675251_Arenado_front.jpg',
        back: '/uploads/1745868675272_Arenado_back.jpg',
        lastUpdated: '2025-04-28T19:31:16.029Z',
        cardId: 41  // Nolan Arenado
      },
      { 
        front: '/uploads/1745868308634_Arenado_front.jpg',
        back: '/uploads/1745868308654_Arenado_back.jpg',
        lastUpdated: '2025-04-28T19:25:09.405Z',
        cardId: 42  // Nolan Arenado (extra entry)
      },
      { 
        front: '/uploads/1745869132483_Machado_front.jpg',
        back: '/uploads/1745869132489_Machado_back.jpg',
        lastUpdated: '2025-04-28T19:38:53.496Z',
        cardId: 44  // Manny Machado (Chrome)
      },
      { 
        front: '/uploads/1745871754339_Lindor_front.jpg',
        back: '/uploads/1745871754347_Lindor_back.jpg',
        lastUpdated: '2025-04-28T20:22:35.174Z',
        cardId: 45  // Francisco Lindor
      }
    ];

    // Update each card in the database
    for (const card of allCards) {
      const cardId = card.id;
      
      // Find the original image paths for this card
      const originalImages = originalImagePaths.find(img => img.cardId === cardId);
      
      if (originalImages) {
        // Update the card in the database
        await db.update(cards)
          .set({
            frontImage: originalImages.front,
            backImage: originalImages.back
          })
          .where(eq(cards.id, cardId));

        console.log(`Updated card ${cardId}: Front: ${originalImages.front}, Back: ${originalImages.back}`);
      } else {
        console.log(`No original image mapping found for card ID: ${cardId}`);
      }
    }

    console.log('Successfully updated card images in the database');
  } catch (error) {
    console.error('Error updating card images:', error);
  }
}

// Run the function
updateCardImagesFromOriginal()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });