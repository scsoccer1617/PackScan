import fs from 'fs';
import path from 'path';

interface ChecklistEntry {
  brand: string;
  year: number;
  collection: string;
  variant: string;
  cardNumber: string;
  playerName: string;
  team: string;
  cardDetails: string;
}

interface ChecklistLookupResult {
  found: boolean;
  playerFirstName?: string;
  playerLastName?: string;
  brand?: string;
  collection?: string;
  variant?: string;
  team?: string;
  source: 'checklist';
}

const checklistData: ChecklistEntry[] = [];
let loaded = false;

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

const NAME_SUFFIXES = new Set(['JR.', 'JR', 'SR.', 'SR', 'II', 'III', 'IV', 'V']);

function splitPlayerName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) {
    return { firstName: '', lastName: '' };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '' };
  }

  const firstName = parts[0];
  const rest = parts.slice(1);

  if (rest.length >= 2) {
    const lastToken = rest[rest.length - 1].toUpperCase().replace(/\.$/, '') + '.';
    const lastTokenNoDot = rest[rest.length - 1].toUpperCase().replace(/\.$/, '');
    if (NAME_SUFFIXES.has(lastTokenNoDot) || NAME_SUFFIXES.has(lastToken)) {
      const lastName = rest.join(' ');
      return { firstName, lastName };
    }
  }

  const lastName = rest.join(' ');
  return { firstName, lastName };
}

export function loadChecklist(): void {
  if (loaded) return;

  const csvDir = path.join(process.cwd(), 'attached_assets');
  const csvFiles = [
    'Baseball_Card_Database_-_2024_Bowman_Draft_1770830973586.csv',
  ];

  for (const csvFile of csvFiles) {
    const csvPath = path.join(csvDir, csvFile);
    if (!fs.existsSync(csvPath)) {
      console.log('Checklist CSV not found at:', csvPath);
      continue;
    }

    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(line => line.trim());

    let startIndex = 0;
    if (lines[0] && lines[0].startsWith('Brand,')) {
      startIndex = 1;
    }

    for (let i = startIndex; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length < 6) continue;

      const entry: ChecklistEntry = {
        brand: fields[0] || '',
        year: parseInt(fields[1]) || 0,
        collection: fields[2] || '',
        variant: fields[3] || '',
        cardNumber: fields[4] || '',
        playerName: fields[5] || '',
        team: fields[6] || '',
        cardDetails: fields[7] || '',
      };

      if (entry.cardNumber && entry.playerName) {
        checklistData.push(entry);
      }
    }
  }

  loaded = true;
  console.log(`Checklist loaded: ${checklistData.length} entries`);
}

function normalizeCardNumber(cardNum: string): string {
  let normalized = cardNum.replace(/\s+/g, '').toUpperCase();
  normalized = normalized.replace(/#/g, '');
  normalized = normalized.replace(/^([A-Z]+)(\d)/, '$1-$2');
  if (!normalized.includes('-')) {
    const match = normalized.match(/^([A-Z]+)(\d+)$/);
    if (match) {
      normalized = `${match[1]}-${match[2]}`;
    }
  }
  return normalized;
}

export function lookupByCardNumber(
  cardNumber: string,
  year?: number
): ChecklistLookupResult {
  if (!loaded) loadChecklist();
  if (!cardNumber) return { found: false, source: 'checklist' };

  const normalizedInput = normalizeCardNumber(cardNumber);

  const matches = checklistData.filter(entry => {
    const normalizedEntry = normalizeCardNumber(entry.cardNumber);
    if (normalizedEntry !== normalizedInput) return false;
    if (year && entry.year && entry.year !== year) return false;
    return true;
  });

  if (matches.length === 0) {
    return { found: false, source: 'checklist' };
  }

  const match = matches[0];
  const { firstName, lastName } = splitPlayerName(match.playerName);

  console.log(`[Checklist] Match found for card #${cardNumber}: ${match.playerName} (${match.brand} ${match.year} ${match.collection} ${match.variant})`);

  return {
    found: true,
    playerFirstName: firstName,
    playerLastName: lastName,
    brand: match.brand,
    collection: match.collection,
    variant: match.variant,
    team: match.team,
    source: 'checklist',
  };
}

export function lookupAllVariants(
  cardNumber: string,
  year?: number
): ChecklistLookupResult[] {
  if (!loaded) loadChecklist();
  if (!cardNumber) return [];

  const normalizedInput = normalizeCardNumber(cardNumber);
  const prefixMatch = normalizedInput.match(/^([A-Z]+)-(\d+)$/);

  if (!prefixMatch) {
    return checklistData
      .filter(entry => {
        const normalizedEntry = normalizeCardNumber(entry.cardNumber);
        return normalizedEntry === normalizedInput && (!year || !entry.year || entry.year === year);
      })
      .map(match => {
        const { firstName, lastName } = splitPlayerName(match.playerName);
        return {
          found: true,
          playerFirstName: firstName,
          playerLastName: lastName,
          brand: match.brand,
          collection: match.collection,
          variant: match.variant,
          team: match.team,
          source: 'checklist' as const,
        };
      });
  }

  const baseNum = prefixMatch[2];

  return checklistData
    .filter(entry => {
      if (year && entry.year && entry.year !== year) return false;
      const entryNorm = normalizeCardNumber(entry.cardNumber);
      const entryMatch = entryNorm.match(/^([A-Z]+)-(\d+)$/);
      return entryMatch && entryMatch[2] === baseNum;
    })
    .map(match => {
      const { firstName, lastName } = splitPlayerName(match.playerName);
      return {
        found: true,
        playerFirstName: firstName,
        playerLastName: lastName,
        brand: match.brand,
        collection: match.collection,
        variant: match.variant,
        team: match.team,
        source: 'checklist' as const,
      };
    });
}

export function getChecklistStats(): { totalEntries: number; loaded: boolean } {
  return { totalEntries: checklistData.length, loaded };
}
