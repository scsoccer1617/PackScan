/**
 * Functions for interacting with Google Sheets API
 */

/**
 * Saves card data to Google Sheets
 * @param cardData - The card data to save
 * @returns Promise with the response from the API
 */
export async function saveCardToGoogleSheets(cardData: any): Promise<any> {
  try {
    const response = await fetch('/api/sheets/add-card', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cardData),
    });
    
    if (!response.ok) {
      throw new Error(`Failed to save to Google Sheets: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error saving card to Google Sheets:', error);
    throw error;
  }
}

/**
 * Gets all cards from Google Sheets
 * @returns Promise with the cards data
 */
export async function getCardsFromGoogleSheets(): Promise<any[]> {
  try {
    const response = await fetch('/api/sheets/get-cards');
    
    if (!response.ok) {
      throw new Error(`Failed to get cards from Google Sheets: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error getting cards from Google Sheets:', error);
    throw error;
  }
}

/**
 * Updates an existing card in Google Sheets
 * @param cardId - The ID of the card to update
 * @param cardData - The updated card data
 * @returns Promise with the response from the API
 */
export async function updateCardInGoogleSheets(cardId: string, cardData: any): Promise<any> {
  try {
    const response = await fetch(`/api/sheets/update-card/${cardId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cardData),
    });
    
    if (!response.ok) {
      throw new Error(`Failed to update card in Google Sheets: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error updating card in Google Sheets:', error);
    throw error;
  }
}

/**
 * Deletes a card from Google Sheets
 * @param cardId - The ID of the card to delete
 * @returns Promise with the response from the API
 */
export async function deleteCardFromGoogleSheets(cardId: string): Promise<any> {
  try {
    const response = await fetch(`/api/sheets/delete-card/${cardId}`, {
      method: 'DELETE',
    });
    
    if (!response.ok) {
      throw new Error(`Failed to delete card from Google Sheets: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error deleting card from Google Sheets:', error);
    throw error;
  }
}
