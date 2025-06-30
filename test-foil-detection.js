// Quick test of foil detection logic
const { detectFoilVariant } = require('./server/foilVariantDetector.ts');

// Test with text that should detect green foil
const testText = `
DONRUSS
Jayson Tatum
Boston Celtics
Basketball
197
2023-24
GREEN
FOIL
PANINI
`;

console.log('Testing foil detection with green foil text...');
const result = detectFoilVariant(testText);
console.log('Result:', result);