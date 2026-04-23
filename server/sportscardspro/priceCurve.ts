/**
 * Convert SportsCardsPro's opaque price fields into a named, self-documenting
 * grade curve.
 *
 * SCP's field names are an unholy legacy from PriceCharting's video-game
 * origins (hence `cib-price`, `box-only-price`, `manual-only-price`).
 * Their docs map these to card grades but the mapping isn't obvious, so
 * we collapse the whole thing into a single struct the rest of the app
 * can reason about.
 *
 * Grade mapping (from SCP docs, Feb 2026):
 *   loose-price            -> Raw / ungraded
 *   cib-price              -> Graded 7 or 7.5 (any company)
 *   new-price              -> Graded 8 or 8.5 (any company)
 *   graded-price           -> Graded 9 (any company)
 *   box-only-price         -> Graded 9.5 (any company)
 *   manual-only-price      -> PSA 10 specifically
 *   bgs-10-price           -> BGS 10 specifically
 *   condition-17-price     -> CGC 10
 *   condition-18-price     -> SGC 10
 *
 * Prices come back in integer pennies. We convert to decimal dollars
 * (as numbers) since all downstream UI uses dollars.
 */

import type { ScpProduct } from "./client";

export interface GradedPrice {
  /** Display label, e.g. "PSA 10", "BGS 10", "Raw". */
  label: string;
  /** Short key for programmatic use (matches the interface below). */
  key: string;
  /** Price in dollars. Zero means SCP has no data for this tier. */
  price: number;
}

export interface PriceCurve {
  /** Raw / ungraded. */
  raw: GradedPrice;
  /** Grade 7 or 7.5 (company-agnostic). */
  grade7: GradedPrice;
  /** Grade 8 or 8.5 (company-agnostic). */
  grade8: GradedPrice;
  /** Grade 9 (company-agnostic). */
  grade9: GradedPrice;
  /** Grade 9.5 (company-agnostic, e.g. BGS 9.5). */
  grade95: GradedPrice;
  /** PSA 10 specifically. The "top dollar" for most modern cards. */
  psa10: GradedPrice;
  /** BGS 10 (Pristine). */
  bgs10: GradedPrice;
  /** CGC 10. */
  cgc10: GradedPrice;
  /** SGC 10. */
  sgc10: GradedPrice;
  // Dealer-focused retail recommendations. Only surfaced for admins for
  // now — the regular UI shows market prices.
  retail: {
    looseBuy: number;   // What a dealer should pay a customer for ungraded
    looseSell: number;  // What a dealer should charge a customer for ungraded
    grade7Buy: number;
    grade7Sell: number;
    grade8Buy: number;
    grade8Sell: number;
  };
  /** Yearly sales volume per SCP. Higher number = more liquid = more
   *  confidence in the price. */
  salesVolume: number | null;
  /** Release date string from SCP ("YYYY-MM-DD") or null. */
  releaseDate: string | null;
}

function penniesToDollars(p: number | undefined): number {
  if (!p || p <= 0) return 0;
  return Math.round(p) / 100;
}

/**
 * Map a raw SCP product response into a PriceCurve. All missing prices
 * become 0 — callers should check `.price > 0` before displaying.
 */
export function buildPriceCurve(product: ScpProduct): PriceCurve {
  return {
    raw: {
      label: "Raw",
      key: "raw",
      price: penniesToDollars(product["loose-price"]),
    },
    grade7: {
      label: "Grade 7",
      key: "grade7",
      price: penniesToDollars(product["cib-price"]),
    },
    grade8: {
      label: "Grade 8",
      key: "grade8",
      price: penniesToDollars(product["new-price"]),
    },
    grade9: {
      label: "Grade 9",
      key: "grade9",
      price: penniesToDollars(product["graded-price"]),
    },
    grade95: {
      label: "Grade 9.5",
      key: "grade95",
      price: penniesToDollars(product["box-only-price"]),
    },
    psa10: {
      label: "PSA 10",
      key: "psa10",
      price: penniesToDollars(product["manual-only-price"]),
    },
    bgs10: {
      label: "BGS 10",
      key: "bgs10",
      price: penniesToDollars(product["bgs-10-price"]),
    },
    cgc10: {
      label: "CGC 10",
      key: "cgc10",
      price: penniesToDollars(product["condition-17-price"]),
    },
    sgc10: {
      label: "SGC 10",
      key: "sgc10",
      price: penniesToDollars(product["condition-18-price"]),
    },
    retail: {
      looseBuy: penniesToDollars(product["retail-loose-buy"]),
      looseSell: penniesToDollars(product["retail-loose-sell"]),
      grade7Buy: penniesToDollars(product["retail-cib-buy"]),
      grade7Sell: penniesToDollars(product["retail-cib-sell"]),
      grade8Buy: penniesToDollars(product["retail-new-buy"]),
      grade8Sell: penniesToDollars(product["retail-new-sell"]),
    },
    salesVolume: product["sales-volume"] ? parseInt(product["sales-volume"], 10) || null : null,
    releaseDate: product["release-date"] ?? null,
  };
}

/**
 * Pick the four tiers we show in the compact overlay strip. Dealers
 * care most about the Raw → PSA 10 progression; BGS/SGC/CGC are
 * available via a details expander (not part of the strip).
 */
export function strip4Tier(curve: PriceCurve): GradedPrice[] {
  return [curve.raw, curve.grade8, curve.grade9, curve.psa10];
}
