import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
}

export function calculateEstimatedValue(condition: string): number {
  // Basic value estimation based on condition
  const valueMap: Record<string, number> = {
    'PSA 10': 300,
    'PSA 9': 200,
    'PSA 8': 135,
    'PSA 7': 90,
    'PSA 6': 67,
    'PSA 5': 47,
    'PSA 4': 30,
    'PSA 3': 17,
    'PSA 2': 12,
    'PSA 1': 7,
  };

  return valueMap[condition] || 0;
}

export function getConditionLabel(condition: string): string {
  const labelMap: Record<string, string> = {
    'PSA 10': 'Gem Mint',
    'PSA 9': 'Mint',
    'PSA 8': 'Near Mint-Mint',
    'PSA 7': 'Near Mint',
    'PSA 6': 'Excellent-Near Mint',
    'PSA 5': 'Excellent',
    'PSA 4': 'Very Good-Excellent',
    'PSA 3': 'Very Good',
    'PSA 2': 'Good',
    'PSA 1': 'Poor',
  };

  return labelMap[condition] || '';
}

export function getValueRange(condition: string): string {
  const rangeMap: Record<string, string> = {
    'PSA 10': '$250-350',
    'PSA 9': '$180-220',
    'PSA 8': '$120-150',
    'PSA 7': '$80-100',
    'PSA 6': '$60-75',
    'PSA 5': '$40-55',
    'PSA 4': '$25-35',
    'PSA 3': '$15-20',
    'PSA 2': '$10-15',
    'PSA 1': '$5-10',
  };

  return rangeMap[condition] || '';
}

export function dataURLtoBlob(dataURL: string): Blob {
  const arr = dataURL.split(',');
  const mime = arr[0].match(/:(.*?);/)?.[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  
  return new Blob([u8arr], { type: mime });
}
