import { db } from '.';
import { cards, sports, brands } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * This script properly updates the card images by handling sport and brand references correctly
 */
async function updateCardImagesAndSportBrands() {
  console.log('Updating card images and properly setting sport/brand references...');

  try {
    // First, make sure we have all the necessary sports
    console.log('Ensuring sports exist in the database...');
    const existingSports = await db.query.sports.findMany();
    
    // Create a map of sport names to IDs
    const sportMap = new Map(existingSports.map(sport => [sport.name, sport.id]));
    
    // Add Baseball if it doesn't exist
    if (!sportMap.has('Baseball')) {
      const [newSport] = await db.insert(sports).values({ name: 'Baseball' }).returning();
      sportMap.set('Baseball', newSport.id);
      console.log(`Added sport: Baseball with ID ${newSport.id}`);
    }
    
    // Now handle brands
    console.log('Ensuring brands exist in the database...');
    const existingBrands = await db.query.brands.findMany();
    
    // Create a map of brand names to IDs
    const brandMap = new Map(existingBrands.map(brand => [brand.name, brand.id]));
    
    // Add necessary brands if they don't exist
    const requiredBrands = ['Topps', 'Score', 'Leaf'];
    for (const brandName of requiredBrands) {
      if (!brandMap.has(brandName)) {
        const [newBrand] = await db.insert(brands).values({ name: brandName }).returning();
        brandMap.set(brandName, newBrand.id);
        console.log(`Added brand: ${brandName} with ID ${newBrand.id}`);
      }
    }
    
    // Now update the correct image paths for cards that need fixing
    console.log('Adding cards with proper sport/brand references...');
    
    // Get the IDs
    const baseballId = sportMap.get('Baseball');
    const toppsId = brandMap.get('Topps');
    const scoreId = brandMap.get('Score');
    const leafId = brandMap.get('Leaf');
    
    // The updated card data
    const cardsToAdd = [
      {
        sportId: baseballId,
        playerFirstName: 'George',
        playerLastName: 'Frazier',
        brandId: toppsId,
        collection: '',
        cardNumber: '207',
        year: 1987,
        variant: '',
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
        sportId: baseballId,
        playerFirstName: 'Norm',
        playerLastName: 'Charlton',
        brandId: leafId,
        collection: '',
        cardNumber: '544',
        year: 1988,
        variant: '',
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
        sportId: baseballId,
        playerFirstName: 'Dave',
        playerLastName: 'Bergman',
        brandId: scoreId,
        collection: '',
        cardNumber: '254',
        year: 1990,
        variant: '',
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

    console.log('Successfully updated all card images and references');
  } catch (error) {
    console.error('Error updating card images and references:', error);
  }
}

// Run the function
updateCardImagesAndSportBrands()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });