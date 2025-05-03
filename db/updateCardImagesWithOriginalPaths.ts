import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * This script updates the card image paths in the database with the original paths
 * based on the data exported from the database
 */
async function updateCardImagesWithOriginalPaths() {
  console.log('Updating cards with their exact original image paths...');

  try {
    // Original image paths from database export
    const originalImagePaths = [
      { id: 20, front: '/uploads/front_8129dc81-f4b9-437c-ba5d-f44394e712a3.jpg', back: '/uploads/back_e28fcc8f-d43d-447d-94f5-0b90f27b6c0e.jpg' },
      { id: 22, front: '/uploads/front_8f406497-ba8d-4277-94a2-c2f0d6a07d03.jpg', back: '/uploads/back_ccf6c8b3-7ab8-4fa5-b545-06e08876abf9.jpg' },
      { id: 23, front: '/uploads/front_13f82788-ebc8-427f-8a07-2c9b300c775d.jpg', back: '/uploads/back_e0163a54-9032-43ec-88fd-cf673a632c30.jpg' },
      { id: 24, front: '/uploads/front_49f545ba-a01a-4a4e-888f-e112da960ec5.jpg', back: '/uploads/back_c677a2df-4d66-4397-b808-12c7e6213985.jpg' },
      { id: 25, front: '/uploads/front_30a3619b-69a3-49a0-aba8-94ee4d9bf74a.jpg', back: '/uploads/back_ac0c7b2f-722b-400b-bc69-2879ecb9c8ff.jpg' },
      { id: 26, front: '/uploads/front_d0f137cb-27e5-42f6-b70f-a53e59fa47e9.jpg', back: '/uploads/back_e52dbdbf-d207-4da8-8e13-0321da15c516.jpg' },
      { id: 27, front: '/uploads/1745782254517_Trout_front.jpg', back: '/uploads/1745782254523_Trout_back.jpg' },
      { id: 28, front: '/uploads/1745785721118_Machado_front.jpg', back: '/uploads/1745785721128_Machado_back.jpg' },
      { id: 29, front: '/uploads/1745790593490_Volpe_front.jpg', back: '/uploads/1745790593497_Volpe_back.jpg' },
      { id: 30, front: '/uploads/1745791833108_Schanuel_front.jpg', back: '/uploads/1745791833113_Schanuel_back.jpg' },
      { id: 31, front: '/uploads/1745792025505_Lewis_front.jpg', back: '/uploads/1745792025510_Lewis_back.jpg' },
      { id: 32, front: '/uploads/1745796442080_Rutschman_front.jpg', back: '/uploads/1745796442086_Rutschman_back.jpg' },
      { id: 33, front: '/uploads/1745796845930_Bregman_front.jpg', back: '/uploads/1745796845936_Bregman_back.jpg' },
      { id: 34, front: '/uploads/1745797140216_Gray_front.jpg', back: '/uploads/1745797140221_Gray_back.jpg' },
      { id: 35, front: '/uploads/1745841448384_Frelick_front.jpg', back: '/uploads/1745841448392_Frelick_back.jpg' },
      { id: 36, front: '/uploads/1745841615200_Ohtani_front.jpg', back: '/uploads/1745841615206_Ohtani_back.jpg' },
      { id: 37, front: '/uploads/1745866266968_Winn_front.jpg', back: '/uploads/1745866266992_Winn_back.jpg' },
      { id: 38, front: '/uploads/1745866766706_Ramirez_front.jpg', back: '/uploads/1745866766728_Ramirez_back.jpg' },
      { id: 39, front: '/uploads/1745867110234_Correa_front.jpg', back: '/uploads/1745867110248_Correa_back.jpg' },
      { id: 40, front: '/uploads/1745867368006_Rafaela_front.jpg', back: '/uploads/1745867368012_Rafaela_back.jpg' },
      { id: 41, front: '/uploads/1745868308634_Arenado_front.jpg', back: '/uploads/1745868308654_Arenado_back.jpg' },
      { id: 42, front: '/uploads/1745868308634_Arenado_front.jpg', back: '/uploads/1745868308654_Arenado_back.jpg' },
      { id: 43, front: '/uploads/1745868675251_Arenado_front.jpg', back: '/uploads/1745868675272_Arenado_back.jpg' },
      { id: 44, front: '/uploads/1745869132483_Machado_front.jpg', back: '/uploads/1745869132489_Machado_back.jpg' },
      { id: 45, front: '/uploads/1745871754339_Lindor_front.jpg', back: '/uploads/1745871754347_Lindor_back.jpg' }
    ];

    // Update each card in the database with its exact original paths
    for (const imagePath of originalImagePaths) {
      await db.update(cards)
        .set({
          frontImage: imagePath.front,
          backImage: imagePath.back
        })
        .where(eq(cards.id, imagePath.id));
      
      console.log(`Updated card ${imagePath.id} with original paths:
        Front: ${imagePath.front}
        Back: ${imagePath.back}`);
    }

    console.log('Successfully updated all card images with their original paths');
  } catch (error) {
    console.error('Error updating card images:', error);
  }
}

// Run the function
updateCardImagesWithOriginalPaths()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });