import { db } from '.';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * This script enforces the correct image paths for all cards in the database
 * by explicitly mapping each card ID to its proper image paths
 */
async function enforceCorrectCardImages() {
  console.log('Enforcing correct image paths for all cards...');

  try {
    // Create a mapping of card IDs to their correct image paths
    const correctImagePaths = {
      4: { 
        front: '/uploads/1746536468855_Rafaela_front.jpg',
        back: '/uploads/1746536468858_Rafaela_back.jpg'
      },
      5: { 
        front: '/uploads/1745841448384_Frelick_front.jpg',
        back: '/uploads/1745841448387_Frelick_back.jpg'
      },
      6: { 
        front: '/uploads/1748098999257_Machado_front.jpg',
        back: '/uploads/1748098999260_Machado_back.jpg'
      },
      7: { 
        front: '/uploads/1748117697563_Bell_front.jpg',
        back: '/uploads/1748117697566_Bell_back.jpg'
      },
      8: { 
        front: '/uploads/1748119546246_Wicks_front.jpg',
        back: '/uploads/1748119546249_Wicks_back.jpg'
      },
      9: { 
        front: '/uploads/1748119870910_Ramirez_front.jpg',
        back: '/uploads/1748119870913_Ramirez_back.jpg'
      },
      10: { 
        front: '/uploads/1748120190492_Rodriguez_front.jpg',
        back: '/uploads/1748120190495_Rodriguez_back.jpg'
      },
      11: { 
        front: '/uploads/1748121530946_Votto_front.jpg',
        back: '/uploads/1748121530949_Votto_back.jpg'
      },
      12: { 
        front: '/uploads/1748122748796_Bart_front.jpg',
        back: '/uploads/1748122748799_Bart_back.jpg'
      },
      13: { 
        front: '/uploads/1748123845706_Gallen_front.jpg',
        back: '/uploads/1748123845709_Gallen_back.jpg'
      },
      14: { 
        front: '/uploads/1748131267927_Encarnacion-Strand_front.jpg',
        back: '/uploads/1748131267930_Encarnacion-Strand_back.jpg'
      },
      15: { 
        front: '/uploads/1748131671690_Tatis Jr._front.jpg',
        back: '/uploads/1748131671693_Tatis Jr._back.jpg'
      },
      16: { 
        front: '/uploads/1748132139341_Renfroe_front.jpg',
        back: '/uploads/1748132139344_Renfroe_back.jpg'
      },
      17: { 
        front: '/uploads/1748132522619_Grisham_front.jpg',
        back: '/uploads/1748132522622_Grisham_back.jpg'
      },
      18: { 
        front: '/uploads/1748132924215_Acuña Jr._front.jpg',
        back: '/uploads/1748132924218_Acuña Jr._back.jpg'
      },
      19: { 
        front: '/uploads/1748133634522_Dunning_front.jpg',
        back: '/uploads/1748133634525_Dunning_back.jpg'
      },
      21: { 
        front: '/uploads/1748134059644_Blue Jays_front.jpg',
        back: '/uploads/1748134059647_Blue Jays_back.jpg'
      },
      22: { 
        front: '/uploads/1748134305932_Harper_front.jpg',
        back: '/uploads/1748134305935_Harper_back.jpg'
      },
      27: { 
        front: '/uploads/1748135529468_Frazier_front.jpg',
        back: '/uploads/1748135529471_Frazier_back.jpg'
      },
      28: { 
        front: '/uploads/1748136695127_Charlton_front.jpg',
        back: '/uploads/1748136695130_Charlton_back.jpg'
      },
      29: { 
        front: '/uploads/1748179343891_Bergman_front.jpg',
        back: '/uploads/1748179343894_Bergman_back.jpg'
      },
      30: { 
        front: '/uploads/1748180820141_LEAGUE BASEBALL®_front.jpg',
        back: '/uploads/1748180820144_LEAGUE BASEBALL®_back.jpg'
      },
      31: { 
        front: '/uploads/1748182904641_Thigpen_front.jpg',
        back: '/uploads/1748182904644_Thigpen_back.jpg'
      },
      32: { 
        front: '/uploads/1748183726973_James_front.jpg',
        back: '/uploads/1748183726976_James_back.jpg'
      }
    };

    // Get all cards from the database
    const allCards = await db.query.cards.findMany();
    console.log(`Found ${allCards.length} cards in the database`);

    // Update each card with its correct image paths
    for (const card of allCards) {
      const cardId = card.id;
      
      // Check if we have correct image paths for this card
      if (correctImagePaths[cardId]) {
        const correctFrontImage = correctImagePaths[cardId].front;
        const correctBackImage = correctImagePaths[cardId].back;
        
        // Only update if the current paths are different from the correct ones
        if (card.frontImage !== correctFrontImage || card.backImage !== correctBackImage) {
          console.log(`Updating card ${cardId} (${card.playerFirstName} ${card.playerLastName}):`);
          console.log(`  Old front image: ${card.frontImage}`);
          console.log(`  New front image: ${correctFrontImage}`);
          
          // Update the card with correct image paths
          await db.update(cards)
            .set({
              frontImage: correctFrontImage,
              backImage: correctBackImage
            })
            .where(eq(cards.id, cardId));
            
          console.log(`  Card ${cardId} updated successfully`);
        } else {
          console.log(`Card ${cardId} (${card.playerFirstName} ${card.playerLastName}) already has correct image paths`);
        }
      } else {
        console.log(`WARNING: No correct image paths defined for card ${cardId} (${card.playerFirstName} ${card.playerLastName})`);
      }
    }

    console.log('Successfully enforced correct image paths for all cards');
  } catch (error) {
    console.error('Error enforcing correct image paths:', error);
  }
}

// Run the function
enforceCorrectCardImages()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });