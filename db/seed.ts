import { db } from "./index";
import * as schema from "@shared/schema";

async function seed() {
  try {
    console.log("Seeding database...");

    // Add sports
    const sports = ["Baseball", "Football", "Basketball", "Hockey", "Soccer", "Other"];
    for (const sport of sports) {
      const existingSport = await db.query.sports.findFirst({
        where: (s, { eq }) => eq(s.name, sport),
      });
      
      if (!existingSport) {
        await db.insert(schema.sports).values({ name: sport });
        console.log(`Added sport: ${sport}`);
      }
    }

    // Add brands
    const brands = ["Topps", "Upper Deck", "Panini", "Bowman", "Fleer", "Donruss", "Other"];
    for (const brand of brands) {
      const existingBrand = await db.query.brands.findFirst({
        where: (b, { eq }) => eq(b.name, brand),
      });
      
      if (!existingBrand) {
        await db.insert(schema.brands).values({ name: brand });
        console.log(`Added brand: ${brand}`);
      }
    }

    // Add sample cards only if the table is empty
    const existingCards = await db.query.cards.findMany({
      limit: 1,
    });

    if (existingCards.length === 0) {
      // Get sport and brand IDs
      const baseballSport = await db.query.sports.findFirst({
        where: (s, { eq }) => eq(s.name, "Baseball"),
      });

      const toppsBrand = await db.query.brands.findFirst({
        where: (b, { eq }) => eq(b.name, "Topps"),
      });

      const bowmanBrand = await db.query.brands.findFirst({
        where: (b, { eq }) => eq(b.name, "Bowman"),
      });

      const upperDeckBrand = await db.query.brands.findFirst({
        where: (b, { eq }) => eq(b.name, "Upper Deck"),
      });

      if (baseballSport && toppsBrand && bowmanBrand && upperDeckBrand) {
        const sampleCards = [
          {
            sportId: baseballSport.id,
            playerFirstName: "Mike",
            playerLastName: "Trout",
            brandId: toppsBrand.id,
            collection: "Series 1",
            cardNumber: "27",
            year: 2021,
            variant: "Base",
            serialNumber: null,
            condition: "PSA 9",
            estimatedValue: 180,
            frontImage: null,
            backImage: null,
            googleSheetId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            userId: null,
          },
          {
            sportId: baseballSport.id,
            playerFirstName: "Aaron",
            playerLastName: "Judge",
            brandId: toppsBrand.id,
            collection: "Chrome",
            cardNumber: "52",
            year: 2020,
            variant: "Refractor",
            serialNumber: null,
            condition: "PSA 8",
            estimatedValue: 65,
            frontImage: null,
            backImage: null,
            googleSheetId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            userId: null,
          },
          {
            sportId: baseballSport.id,
            playerFirstName: "Fernando",
            playerLastName: "Tatis Jr.",
            brandId: bowmanBrand.id,
            collection: "Chrome",
            cardNumber: "14",
            year: 2021,
            variant: "Base",
            serialNumber: null,
            condition: "PSA 10",
            estimatedValue: 95,
            frontImage: null,
            backImage: null,
            googleSheetId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            userId: null,
          },
          {
            sportId: baseballSport.id,
            playerFirstName: "Shohei",
            playerLastName: "Ohtani",
            brandId: upperDeckBrand.id,
            collection: "Heritage",
            cardNumber: "65",
            year: 2022,
            variant: "Base",
            serialNumber: null,
            condition: "PSA 7",
            estimatedValue: 42,
            frontImage: null,
            backImage: null,
            googleSheetId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            userId: null,
          },
        ];

        for (const card of sampleCards) {
          await db.insert(schema.cards).values(card);
        }

        console.log(`Added ${sampleCards.length} sample cards`);
      }
    }

    console.log("Seeding completed successfully");
  } catch (error) {
    console.error("Error seeding database:", error);
  }
}

seed();
