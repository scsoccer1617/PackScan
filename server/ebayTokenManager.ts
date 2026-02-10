import axios from 'axios';

const EBAY_OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;

export async function getEbayAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const appId = process.env.EBAY_APP_ID || '';
  const certId = process.env.EBAY_CERT_ID || '';

  if (!appId || !certId) {
    console.error('Missing EBAY_APP_ID or EBAY_CERT_ID for OAuth token generation');
    const fallback = process.env.EBAY_BROWSE_TOKEN || '';
    if (fallback) {
      console.log('Falling back to static EBAY_BROWSE_TOKEN');
      return fallback;
    }
    throw new Error('No eBay credentials available');
  }

  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');

  try {
    console.log('Requesting new eBay OAuth token via Client Credentials flow...');
    const response = await axios.post(
      EBAY_OAUTH_URL,
      `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`,
        },
        timeout: 10000,
      }
    );

    cachedToken = response.data.access_token;
    const expiresIn = response.data.expires_in || 7200;
    tokenExpiresAt = Date.now() + (expiresIn - 300) * 1000;
    console.log(`eBay OAuth token acquired, expires in ${expiresIn}s (refreshing 5min early)`);
    return cachedToken!;
  } catch (error: any) {
    console.error('Failed to get eBay OAuth token:', error.response?.data || error.message);
    const fallback = process.env.EBAY_BROWSE_TOKEN || '';
    if (fallback) {
      console.log('Falling back to static EBAY_BROWSE_TOKEN');
      return fallback;
    }
    throw new Error('Failed to generate eBay OAuth token');
  }
}

export function clearCachedToken(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
  console.log('eBay OAuth token cache cleared');
}
