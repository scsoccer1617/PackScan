import { db } from '.';
import { cards } from '../shared/schema';

/**
 * This script adds the missing cards with correct image paths
 */
async function addMissingCards() {
  console.log('Adding missing cards with correct image paths...');

  try {
    // List of cards to add
    const cardsToAdd = [
      {
        playerFirstName: 'George',
        playerLastName: 'Frazier',
        brand: 'Topps',
        collection: '',
        cardNumber: '207',
        year: 1987,
        sport: 'Baseball',
        serialNumber: '',
        condition: 'PSA 8',
        estimatedValue: 0.75,
        isRookieCard: false,
        isAutographed: false,
        isNumbered: false,
        frontImage: '/uploads/1748135529468_Frazier_front.jpg',
        backImage: '/uploads/1748135529471_Frazier_back.jpg',
        notes: 'Correctly identified card number 207'
      },
      {
        playerFirstName: 'Norm',
        playerLastName: 'Charlton',
        brand: 'Leaf',
        collection: '',
        cardNumber: '544',
        year: 1988,
        sport: 'Baseball',
        serialNumber: '',
        condition: 'PSA 8',
        estimatedValue: 0.99,
        isRookieCard: false,
        isAutographed: false,
        isNumbered: false,
        frontImage: '/uploads/1748136695127_Charlton_front.jpg',
        backImage: '/uploads/1748136695130_Charlton_back.jpg',
        notes: 'Correctly identified card number 544'
      },
      {
        playerFirstName: 'Dave',
        playerLastName: 'Bergman',
        brand: 'Score',
        collection: '',
        cardNumber: '254',
        year: 1990,
        sport: 'Baseball',
        serialNumber: '',
        condition: 'PSA 8',
        estimatedValue: 0.75,
        isRookieCard: false,
        isAutographed: false,
        isNumbered: false,
        frontImage: '/uploads/1748179343891_Bergman_front.jpg',
        backImage: '/uploads/1748179343894_Bergman_back.jpg',
        notes: 'Correctly identified card number 254'
      }
    ];

    // Add each card
    for (const cardData of cardsToAdd) {
      const [newCard] = await db.insert(cards).values(cardData).returning();
      console.log(`Added card ID ${newCard.id}: ${cardData.playerFirstName} ${cardData.playerLastName}`);
    }

    console.log('Successfully added all missing cards');
  } catch (error) {
    console.error('Error adding missing cards:', error);
  }
}

// Run the function
addMissingCards()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });