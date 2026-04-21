import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
  httpOptions: {
    apiVersion: "",
    baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  },
});

export interface GeminiCardResult {
  playerFirstName?: string | null;
  playerLastName?: string | null;
  year?: number | null;
  brand?: string | null;
  collection?: string | null;
  set?: string | null;
  cardNumber?: string | null;
  team?: string | null;
  sport?: string | null;
  isRookie?: boolean | null;
  isAutograph?: boolean | null;
  serialNumber?: string | null;
  parallel?: string | null;
  variant?: string | null;
  cmpNumber?: string | null;
  confidence?: number | null;
  notes?: string | null;
}

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    playerFirstName: { type: Type.STRING, nullable: true },
    playerLastName: { type: Type.STRING, nullable: true },
    year: { type: Type.INTEGER, nullable: true },
    brand: { type: Type.STRING, nullable: true },
    collection: { type: Type.STRING, nullable: true },
    set: { type: Type.STRING, nullable: true },
    cardNumber: { type: Type.STRING, nullable: true },
    team: { type: Type.STRING, nullable: true },
    sport: { type: Type.STRING, nullable: true },
    isRookie: { type: Type.BOOLEAN, nullable: true },
    isAutograph: { type: Type.BOOLEAN, nullable: true },
    serialNumber: { type: Type.STRING, nullable: true },
    parallel: { type: Type.STRING, nullable: true },
    variant: { type: Type.STRING, nullable: true },
    cmpNumber: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER, nullable: true },
    notes: { type: Type.STRING, nullable: true },
  },
};

const PROMPT = `You are a sports card identification expert. Analyze the provided card image(s) (front and optionally back) and extract structured metadata.

Extract these fields when visible:
- playerFirstName / playerLastName: The featured player's name
- year: Card RELEASE year (4-digit integer). Use this priority order — DO NOT skip steps:
  (1) An explicit year printed next to the brand/set name on the FRONT or BACK (e.g. "2025 Topps Chrome", "2024 Bowman Holiday"). Strongest signal.
  (2) MOST RECENT STAT YEAR + 1. The back almost always shows a stat table whose left column is "YR" or "YEAR" with two-digit seasons (e.g. "21, 22, 22, 22"). The card's release year is ONE year AFTER the most recent stat year. Examples: stats end in "22" → card year 2023. Stats end in "24" → card year 2025. Stats end in "20" → card year 2021. This is the most reliable signal when no explicit year is on the front.
  (3) The copyright "© YEAR" line on the back. WARNING: this is often 1 year EARLIER than the actual release year (a 2023 Topps Series 1 card frequently reads "© 2022 The Topps Company"). Only use this if rules (1) and (2) both fail, and prefer (release_year_inferred_from_stats) over (©_year) if they disagree.
  (4) Card-code/SKU on the back (e.g. "CODE#TMP12...") — last-resort tiebreaker only.
  CRITICAL — NEVER use these as the year:
   - Career milestone dates, draft year ("DRAFTED 2023"), birth year ("BORN 11-15-01"), debut year, or any year mentioned in the player bio paragraph.
   - Trademark / "established" dates in small legal text (e.g. "MLBPA® est. 1954").
   - Stadium-built / franchise-history dates.
- brand: Manufacturer (Topps, Panini, Upper Deck, Donruss, Fleer, Bowman, etc.)
- collection: Product line (e.g. "Chrome", "Prizm", "Update", "Traded", "Series 1", "Heritage", "Stadium Club"). Omit if brand IS the collection.
- set: Full set name if printed (e.g. "Topps Series 1 Baseball")
- cardNumber: Exact card number as printed. Include any letter suffixes (e.g. "8T", "US150", "RC-5"). Do NOT invent one — leave null if not visible.
- team: Team name if shown
- sport: "Baseball", "Basketball", "Football", "Hockey", "Soccer", etc.
- isRookie: true if "RC", "Rookie Card", or a rookie logo is visible
- isAutograph: true if signed or marked "AUTO"
- serialNumber: Serial number if numbered (e.g. "10/399", "0456/2024", "/499"). Look CAREFULLY — these are often:
   - Foil-stamped (gold/silver/coloured ink) on the front, frequently near the bottom edge, side border, or under the player image.
   - Hand-numbered or printed in small text on the back.
   - Format is ALWAYS "NNNN/NNNN" or "/NNNN" — a number-over-number. The denominator is the print run (e.g. /150, /299, /2024).
   - The print run can numerically match the card's year (e.g. a 2024 Topps Gold parallel is /2024). DO NOT skip the serial just because the denominator looks like a year — if you see "0456/2024" on the card, that IS the serial number, even on a 2024 card. Extract the full string exactly as printed.
   - If you can only see the denominator (e.g. "/2024" because the numerator is too blurry), still return "/2024".
- parallel: A foil/refractor/colour-parallel name ONLY (e.g. "Gold", "Refractor", "X-Fractor", "Sky Blue", "Prizm Silver", "Mojo", "Holo"). These are alternate printings that differ visually (foil, color, texture). Leave null if the card is the base version.
- variant: Non-parallel variations ONLY (e.g. "Short Print", "Photo Variation", "Pre-Production Sample", "Error", "Corrected", "Update", "Traded"). Things printed on the card that distinguish it from the base but are NOT a foil/colour parallel. Leave null if none.
- cmpNumber: The internal product/CMP code printed on the back, usually labelled "CODE#" or "CMP" (e.g. "CMP1234", "CODE#TMP12...", "BCP123"). Capture the full code exactly as printed (letters + digits). Leave null if not visible.
- confidence: 0.0–1.0 your overall confidence
- notes: Any relevant observations (OCR ambiguity, unusual formatting, etc.)

Rules:
- Only return values you can actually see. Use null for fields you are not confident about.
- Do NOT hallucinate card numbers, player names, or years.
- For the card number, prefer the small printed number on the card (often on the back, sometimes in a circle). Never output jersey numbers or stat totals.
- NEVER put a parallel name in "variant" or a variation in "parallel". When in doubt, leave both null.
- Return ONLY the structured JSON; no prose outside it.`;

function toInlinePart(buffer: Buffer, mimeType: string) {
  return {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType,
    },
  };
}

export async function analyzeCardWithGemini(
  frontImage: Buffer,
  backImage?: Buffer | null,
  frontMime: string = "image/jpeg",
  backMime: string = "image/jpeg",
): Promise<GeminiCardResult> {
  const parts: any[] = [{ text: PROMPT }];
  parts.push({ text: "FRONT IMAGE:" });
  parts.push(toInlinePart(frontImage, frontMime));
  if (backImage && backImage.length > 0) {
    parts.push({ text: "BACK IMAGE:" });
    parts.push(toInlinePart(backImage, backMime));
  }

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts }],
    config: {
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      temperature: 0.1,
    },
  });

  const raw = response.text || "";
  if (!raw.trim()) {
    throw new Error("Gemini returned empty response");
  }

  let parsed: GeminiCardResult;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Gemini returned non-JSON response: ${raw.slice(0, 200)}`);
  }

  // Normalise: trim strings, coerce year to integer
  const clean = <T>(v: T): T | null => {
    if (v == null) return null;
    if (typeof v === "string") {
      const t = v.trim();
      return (t === "" ? null : (t as any));
    }
    return v;
  };

  return {
    playerFirstName: clean(parsed.playerFirstName),
    playerLastName: clean(parsed.playerLastName),
    year: parsed.year != null ? Number(parsed.year) || null : null,
    brand: clean(parsed.brand),
    collection: clean(parsed.collection),
    set: clean(parsed.set),
    cardNumber: clean(parsed.cardNumber),
    team: clean(parsed.team),
    sport: clean(parsed.sport),
    isRookie: parsed.isRookie ?? null,
    isAutograph: parsed.isAutograph ?? null,
    serialNumber: clean(parsed.serialNumber),
    parallel: clean(parsed.parallel),
    variant: clean(parsed.variant),
    cmpNumber: clean(parsed.cmpNumber),
    confidence: parsed.confidence ?? null,
    notes: clean(parsed.notes),
  };
}
