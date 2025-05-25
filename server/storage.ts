import { db } from '@db';
import * as schema from '@shared/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { calculateEstimatedValue } from '../client/src/lib/utils';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';

// Google Sheets API setup
let googleAuth: OAuth2Client | null = null;
export let googleSheetsInstance: any = null;
export let spreadsheetId = process.env.GOOGLE_SHEET_ID || '';

// Initialize Google Sheets API
export async function initGoogleSheetsApi() {
  try {
    // Check if we have the required environment variables
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      console.warn('Google Sheets API credentials not found. Using database storage only.');
      return false;
    }

    // Create a properly formatted private key
    let privateKey = process.env.GOOGLE_PRIVATE_KEY || '';
    
    try {
      // Try to parse the key in case it was literally copied from the JSON file
      if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
        // Remove the outer quotes
        privateKey = privateKey.slice(1, -1);
      }
      
      // Handle various formats of private key
      if (privateKey.includes('\\n')) {
        privateKey = privateKey.replace(/\\n/g, '\n');
      }
      
      // Make sure it begins and ends with the right markers
      if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
        privateKey = '-----BEGIN PRIVATE KEY-----\n' + privateKey;
      }
      if (!privateKey.includes('-----END PRIVATE KEY-----')) {
        privateKey = privateKey + '\n-----END PRIVATE KEY-----';
      }
    } catch (error) {
      console.error('Error processing private key:', error);
    }
    
    // Check key format and log diagnostic info (without exposing sensitive data)
    console.log('Initializing Google Sheets with client email:', process.env.GOOGLE_CLIENT_EMAIL);
    console.log('Private key starts with correct header:', privateKey.startsWith('-----BEGIN PRIVATE KEY-----'));
    console.log('Private key ends with correct footer:', privateKey.endsWith('-----END PRIVATE KEY-----'));
    console.log('Private key length:', privateKey.length);
    console.log('Private key contains newlines:', privateKey.includes('\n'));
    
    // Try with direct JWT approach
    googleAuth = new google.auth.JWT(
      process.env.GOOGLE_CLIENT_EMAIL,
      undefined,
      privateKey,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    
    googleSheetsInstance = google.sheets({
      version: 'v4',
      auth: googleAuth
    });

    // Create or validate spreadsheet
    if (!spreadsheetId) {
      console.log('Creating new Google Sheet for card collection...');
      try {
        const response = await googleSheetsInstance.spreadsheets.create({
          resource: {
            properties: {
              title: 'Sports Card Collection',
            },
            sheets: [
              {
                properties: {
                  title: 'Cards',
                  gridProperties: {
                    frozenRowCount: 1,
                  },
                },
              },
            ],
          },
        });
        
        spreadsheetId = response.data.spreadsheetId;
        console.log(`Created new spreadsheet with ID: ${spreadsheetId}`);
        
        // Add headers
        await googleSheetsInstance.spreadsheets.values.update({
          spreadsheetId,
          range: 'Cards!A1:R1',
          valueInputOption: 'RAW',
          resource: {
            values: [[
              'ID', 'Sport', 'Player First Name', 'Player Last Name', 
              'Brand', 'Collection', 'Card Number', 'Year', 
              'Variant', 'Serial Number', 'Condition', 'Estimated Value',
              'Rookie Card', 'Autographed', 'Numbered',
              'Front Image URL', 'Back Image URL', 'Last Updated'
            ]],
          },
        });
      } catch (err) {
        console.error('Error creating Google Sheet:', err);
        return false;
      }
    }
    
    console.log('Google Sheets API initialized successfully');
    return true;
  } catch (error) {
    console.error('Error initializing Google Sheets API:', error);
    googleAuth = null;
    googleSheetsInstance = null;
    return false;
  }
}

// Database storage
export const storage = {
  // Sports CRUD
  async getSports() {
    return await db.query.sports.findMany({
      orderBy: schema.sports.name,
    });
  },

  async getSportByName(name: string) {
    return await db.query.sports.findFirst({
      where: eq(schema.sports.name, name),
    });
  },

  async createSport(name: string) {
    const [sport] = await db.insert(schema.sports)
      .values({ name })
      .returning();
    return sport;
  },

  // Brands CRUD
  async getBrands() {
    return await db.query.brands.findMany({
      orderBy: schema.brands.name,
    });
  },

  async getBrandByName(name: string) {
    return await db.query.brands.findFirst({
      where: eq(schema.brands.name, name),
    });
  },

  async createBrand(name: string) {
    const [brand] = await db.insert(schema.brands)
      .values({ name })
      .returning();
    return brand;
  },

  // Cards CRUD
  async getCards() {
    return await db.query.cards.findMany({
      orderBy: desc(schema.cards.createdAt),
      with: {
        sport: true,
        brand: true,
      },
    });
  },

  async getCardById(id: number) {
    return await db.query.cards.findFirst({
      where: eq(schema.cards.id, id),
      with: {
        sport: true,
        brand: true,
      },
    });
  },

  async createCard(cardData: Omit<schema.CardInsert, 'id'>) {
    const [card] = await db.insert(schema.cards)
      .values(cardData)
      .returning();
    return card;
  },

  async updateCard(id: number, cardData: Partial<schema.CardInsert>) {
    const [updatedCard] = await db.update(schema.cards)
      .set({
        ...cardData,
        updatedAt: new Date(),
      })
      .where(eq(schema.cards.id, id))
      .returning();
    return updatedCard;
  },

  async deleteCard(id: number) {
    // First retrieve the card to be deleted so we can get its data
    const cardToDelete = await this.getCardById(id);
    
    // Delete the card from the database
    const [deletedCard] = await db.delete(schema.cards)
      .where(eq(schema.cards.id, id))
      .returning();
    
    // Remove from Google Sheets if possible
    if (googleSheetsInstance && spreadsheetId && cardToDelete) {
      try {
        // Find the row with this card ID in the spreadsheet
        const response = await googleSheetsInstance.spreadsheets.values.get({
          spreadsheetId,
          range: 'Cards!A:A', // Get all values in column A (ID column)
        });
        
        const rows = response.data.values || [];
        let rowIndex = -1;
        
        // Find the row with matching card ID
        for (let i = 0; i < rows.length; i++) {
          if (rows[i][0] === id.toString()) {
            rowIndex = i + 1; // +1 because spreadsheet rows are 1-indexed
            break;
          }
        }
        
        if (rowIndex > 1) { // Skip header row (row 1)
          console.log(`Deleting card ${id} from Google Sheets row ${rowIndex}`);
          
          // Clear the row in the spreadsheet
          await googleSheetsInstance.spreadsheets.values.clear({
            spreadsheetId,
            range: `Cards!A${rowIndex}:S${rowIndex}`,
          });
          
          console.log(`Successfully deleted card ${id} from Google Sheets`);
        } else {
          console.log(`Card ${id} not found in Google Sheets, no deletion needed`);
        }
      } catch (error) {
        console.error(`Error deleting card ${id} from Google Sheets:`, error);
        // Continue even if Google Sheets deletion fails
      }
    }
    
    return deletedCard;
  },

  // Stats and analytics
  async getCollectionStats() {
    const allCards = await this.getCards();
    
    // Total value calculation
    const totalValue = allCards.reduce((sum, card) => sum + (card.estimatedValue ? Number(card.estimatedValue) : 0), 0);
    
    // Cards by sport
    const sportDistribution = await db.select({
      name: schema.sports.name,
      count: sql<number>`count(${schema.cards.id})`,
    })
    .from(schema.cards)
    .innerJoin(schema.sports, eq(schema.cards.sportId, schema.sports.id))
    .groupBy(schema.sports.name);
    
    // Value by year
    const valueByYear = await db.select({
      year: schema.cards.year,
      value: sql<string>`sum(CAST(${schema.cards.estimatedValue} AS numeric))`,
    })
    .from(schema.cards)
    .groupBy(schema.cards.year)
    .orderBy(schema.cards.year);
    
    // Most valuable cards
    const topCards = await db.query.cards.findMany({
      orderBy: desc(schema.cards.estimatedValue),
      limit: 5,
      with: {
        sport: true,
        brand: true,
      },
    });
    
    return {
      totalCardCount: allCards.length,
      totalValue,
      sportDistribution: sportDistribution.map(s => ({
        name: s.name,
        value: Number(s.count),
      })),
      valueByYear: valueByYear.map(y => ({
        year: String(y.year),
        value: Number(y.value) || 0,
      })),
      topCards,
    };
  },

  // Google Sheets integration
  async saveCardToGoogleSheets(card: schema.Card, sportName: string, brandName: string, frontImageUrl?: string, backImageUrl?: string) {
    try {
      // Create directory for export data if it doesn't exist
      const exportDir = path.join(process.cwd(), 'exports');
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }
      
      // Create or append to CSV file
      const csvFilePath = path.join(exportDir, 'cards_export.csv');
      const fileExists = fs.existsSync(csvFilePath);
      
      // Prepare CSV row - removed ID column
      const csvRow = [
        sportName,
        card.playerFirstName,
        card.playerLastName,
        brandName,
        card.collection || '',
        card.cardNumber,
        card.year.toString(),
        card.variant || '',
        card.serialNumber || '',
        card.condition || '',
        card.estimatedValue ? card.estimatedValue.toString() : '',
        card.isRookieCard ? 'Yes' : 'No',
        card.isAutographed ? 'Yes' : 'No', 
        card.isNumbered ? 'Yes' : 'No',
        card.notes || '',
        frontImageUrl || '',
        backImageUrl || '',
        new Date().toISOString(),
      ].map(field => `"${field.replace(/"/g, '""')}"`).join(',');
      
      // Write header if file doesn't exist
      if (!fileExists) {
        const headers = [
          'Sport', 'Player First Name', 'Player Last Name', 
          'Brand', 'Collection', 'Card Number', 'Year', 
          'Variant', 'Serial Number', 'Condition', 'Estimated Value',
          'Rookie Card', 'Autographed', 'Numbered', 'Notes',
          'Front Image URL', 'Back Image URL', 'Last Updated'
        ].map(header => `"${header}"`).join(',');
        
        fs.writeFileSync(csvFilePath, headers + '\n');
      }
      
      // Append the data
      fs.appendFileSync(csvFilePath, csvRow + '\n');
      
      // CSV backup success message
      console.log('Card data saved to CSV backup file:', csvFilePath);
      
      // Try to update Google Sheets if available
      let nextRow = 1;
      if (googleSheetsInstance && spreadsheetId) {
        try {
          // Reinitialize Sheets API connection with updated credentials if needed
          if (process.env.GOOGLE_PRIVATE_KEY && !googleAuth) {
            await initGoogleSheetsApi();
            
            // If still not initialized, report error but continue with CSV
            if (!googleSheetsInstance) {
              return { 
                success: false, 
                row: nextRow,
                error: `Failed to initialize Google Sheets client with updated credentials. Data was saved to CSV file.`
              };
            }
          }
          
          // First check if the "Cards" sheet exists
          console.log(`Checking if "Cards" sheet exists in spreadsheet: ${spreadsheetId}`);
          try {
            const spreadsheet = await googleSheetsInstance.spreadsheets.get({
              spreadsheetId,
            });
            
            // Check if the Cards sheet exists
            const sheetsInfo = spreadsheet.data.sheets || [];
            const cardsSheet = sheetsInfo.find((s: any) => 
              s.properties?.title === 'Cards'
            );
            
            if (!cardsSheet) {
              console.log('Creating "Cards" sheet as it does not exist');
              
              // Add the Cards sheet
              await googleSheetsInstance.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                  requests: [
                    {
                      addSheet: {
                        properties: {
                          title: 'Cards',
                          gridProperties: {
                            frozenRowCount: 1,
                          },
                        },
                      },
                    },
                  ],
                },
              });
              
              // Add headers to the new sheet - removed ID column
              await googleSheetsInstance.spreadsheets.values.update({
                spreadsheetId,
                range: 'Cards!A1:R1',
                valueInputOption: 'RAW',
                resource: {
                  values: [[
                    'Sport', 'Player First Name', 'Player Last Name', 
                    'Brand', 'Collection', 'Card Number', 'Year', 
                    'Variant', 'Serial Number', 'Condition', 'Estimated Value',
                    'Rookie Card', 'Autographed', 'Numbered', 'Notes',
                    'Front Image URL', 'Back Image URL', 'Last Updated'
                  ]],
                },
              });
              
              console.log('Created "Cards" sheet with headers');
              nextRow = 2; // Start at row 2 after headers
            } else {
              // If Cards sheet exists, check if we're updating an existing card
              const response = await googleSheetsInstance.spreadsheets.values.get({
                spreadsheetId,
                range: 'Cards!A:R', // Get all columns to search for existing card
              });
              
              const rows = response.data.values || [];
              
              // Try to find existing card to update
              let rowFound = false;
              
              // Skip header row and look for matching cards
              for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (row && row.length >= 7) { // Make sure we have enough columns
                  // Check if this is the same card by matching player name, card number, and year
                  // Index: 1=FirstName, 2=LastName, 5=CardNumber, 6=Year
                  if (row[1] === card.playerFirstName && 
                      row[2] === card.playerLastName && 
                      row[5] === card.cardNumber && 
                      row[6] === card.year.toString()) {
                    
                    // Found the card - update this row
                    nextRow = i + 1; // +1 because sheets are 1-indexed
                    rowFound = true;
                    console.log(`Found existing card in Google Sheets at row ${nextRow}, will update instead of adding new`);
                    break;
                  }
                }
              }
              
              // If card not found, add to end
              if (!rowFound) {
                nextRow = rows.length + 1;
              }
            }
          } catch (sheetCheckError: any) {
            console.error('Error checking/creating Cards sheet:', sheetCheckError);
            // Continue with CSV backup
            return { 
              success: false, 
              error: `Error with Google Sheets: ${sheetCheckError.message}. Data was saved to CSV file.`
            };
          }
          
          // Insert card data - removed ID column
          await googleSheetsInstance.spreadsheets.values.update({
            spreadsheetId,
            range: `Cards!A${nextRow}:R${nextRow}`,
            valueInputOption: 'RAW',
            resource: {
              values: [[
                sportName,
                card.playerFirstName,
                card.playerLastName,
                brandName,
                card.collection || '',
                card.cardNumber,
                card.year.toString(),
                card.variant || '',
                card.serialNumber || '',
                card.condition || '',
                card.estimatedValue ? card.estimatedValue.toString() : '',
                card.isRookieCard ? 'Yes' : 'No',
                card.isAutographed ? 'Yes' : 'No',
                card.isNumbered ? 'Yes' : 'No',
                card.notes || '',
                frontImageUrl || '',
                backImageUrl || '',
                new Date().toISOString(),
              ]],
            },
          });
          
          console.log(`Successfully saved card to Google Sheets in row ${nextRow}`);
        } catch (error: any) {
          console.error('Error writing to Google Sheets directly, but data was saved to CSV:', error);
          
          // Add debug details
          if (spreadsheetId) {
            console.log('Using spreadsheet ID:', spreadsheetId);
          } else {
            console.error('No spreadsheet ID available');
          }
          
          // Try to determine if it's a permission issue
          if (error.message && error.message.includes('permission')) {
            console.error('Google Sheets API permission error. Please make sure the service account has edit access to the spreadsheet.');
          }
          
          // Continue since we saved to CSV
          return { 
            success: false, 
            row: nextRow,
            error: `Google Sheets error: ${error.message}. Data was saved to CSV file.`
          };
        }
      } else {
        console.log('Google Sheets API not initialized, using CSV backup only');
        return { 
          success: false, 
          row: nextRow,
          error: `Google Sheets API not properly initialized. Data was saved to CSV file only.`
        };
      }
      
      return { success: true, row: nextRow };
    } catch (error: any) {
      console.error('Error saving card data:', error);
      // Return a more graceful error that doesn't break the card saving flow
      return { success: false, error: error.message };
    }
  },

  // Save images to file system
  async saveImage(base64Data: string, filename: string): Promise<string> {
    try {
      // Create uploads directory in both locations for compatibility 
      // Main uploads dir
      const uploadsDir = path.join(process.cwd(), 'uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      
      // Also create the old directory structure for backward compatibility
      const oldUploadsDir = path.join(process.cwd(), 'dist', 'public', 'uploads');
      if (!fs.existsSync(oldUploadsDir)) {
        fs.mkdirSync(oldUploadsDir, { recursive: true });
      }
      
      // Extract the actual base64 data (remove the data:image/jpeg;base64, part)
      const base64Image = base64Data.split(';base64,').pop();
      if (!base64Image) {
        throw new Error('Invalid image data');
      }
      
      // Save to both locations for compatibility
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, base64Image, { encoding: 'base64' });
      
      const oldFilePath = path.join(oldUploadsDir, filename);
      fs.writeFileSync(oldFilePath, base64Image, { encoding: 'base64' });
      
      // Return the relative URL for the image
      return `/uploads/${filename}`;
    } catch (error: any) {
      console.error('Error saving image:', error);
      throw error;
    }
  },
};

// Initialize Google Sheets API when this module is imported
initGoogleSheetsApi().catch(console.error);