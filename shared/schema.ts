import { pgTable, text, serial, integer, boolean, timestamp, jsonb, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { relations } from "drizzle-orm";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").unique(),
  password: text("password"),
  email: text("email").unique(),
  passwordHash: text("password_hash"),
  googleId: text("google_id").unique(),
  displayName: text("display_name"),
  emailVerifiedAt: timestamp("email_verified_at"),
  googleAccessToken: text("google_access_token"),
  googleRefreshToken: text("google_refresh_token"),
  googleTokenExpiresAt: timestamp("google_token_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const authTokens = pgTable("auth_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
  kind: text("kind", { enum: ['verify_email', 'reset_password'] }).notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("auth_tokens_token_hash_idx").on(table.tokenHash),
  index("auth_tokens_user_kind_idx").on(table.userId, table.kind),
]);
export type AuthToken = typeof authTokens.$inferSelect;

export const userSheets = pgTable("user_sheets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
  googleSheetId: text("google_sheet_id").notNull(),
  title: text("title").notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("user_sheets_user_idx").on(table.userId),
]);
export type UserSheet = typeof userSheets.$inferSelect;

// Postgres-backed session storage table for connect-pg-simple.
// Schema matches the default expected by connect-pg-simple.
export const sessionsTable = pgTable("session", {
  sid: text("sid").primaryKey(),
  sess: jsonb("sess").notNull(),
  expire: timestamp("expire", { precision: 6 }).notNull(),
}, (table) => [
  index("session_expire_idx").on(table.expire),
]);

// Sports cards table
export const sports = pgTable("sports", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
});

export const brands = pgTable("brands", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
});

export const cards = pgTable("cards", {
  id: serial("id").primaryKey(),
  sportId: integer("sport_id").references(() => sports.id).notNull(),
  playerFirstName: text("player_first_name").notNull(),
  playerLastName: text("player_last_name").notNull(),
  brandId: integer("brand_id").references(() => brands.id).notNull(),
  collection: text("collection"),
  cardNumber: text("card_number").notNull(),
  year: integer("year").notNull(),
  variant: text("variant"),
  serialNumber: text("serial_number"),
  condition: text("condition"),
  estimatedValue: numeric("estimated_value", { precision: 10, scale: 2 }),
  isRookieCard: boolean("is_rookie_card").default(false),
  isAutographed: boolean("is_autographed").default(false),
  isNumbered: boolean("is_numbered").default(false),
  isFoil: boolean("is_foil").default(false),
  foilType: text("foil_type"),
  notes: text("notes"),
  frontImage: text("front_image"),
  backImage: text("back_image"),
  googleSheetId: text("google_sheet_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  userId: integer("user_id").references(() => users.id),
});

// Relations
export const sportsRelations = relations(sports, ({ many }) => ({
  cards: many(cards),
}));

export const brandsRelations = relations(brands, ({ many }) => ({
  cards: many(cards),
}));

export const cardsRelations = relations(cards, ({ one }) => ({
  sport: one(sports, { fields: [cards.sportId], references: [sports.id] }),
  brand: one(brands, { fields: [cards.brandId], references: [brands.id] }),
  user: one(users, { fields: [cards.userId], references: [users.id] }),
}));

export const confirmedCards = pgTable("confirmed_cards", {
  id: serial("id").primaryKey(),
  sport: text("sport").notNull(),
  playerFirstName: text("player_first_name").notNull(),
  playerLastName: text("player_last_name").notNull(),
  brand: text("brand").notNull(),
  collection: text("collection"),
  cardNumber: text("card_number").notNull(),
  year: integer("year").notNull(),
  variant: text("variant"),
  serialLimit: text("serial_limit"),
  team: text("team"),
  isRookieCard: boolean("is_rookie_card").default(false),
  isAutographed: boolean("is_autographed").default(false),
  isNumbered: boolean("is_numbered").default(false),
  confirmCount: integer("confirm_count").default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const confirmedCardsInsertSchema = createInsertSchema(confirmedCards, {
  playerFirstName: (schema) => schema.min(1, "First name is required"),
  playerLastName: (schema) => schema.min(1, "Last name is required"),
  cardNumber: (schema) => schema.min(1, "Card number is required"),
});
export type ConfirmedCardInsert = z.infer<typeof confirmedCardsInsertSchema>;
export type ConfirmedCard = typeof confirmedCards.$inferSelect;

// Validation schemas
export const sportInsertSchema = createInsertSchema(sports);
export type SportInsert = z.infer<typeof sportInsertSchema>;
export type Sport = typeof sports.$inferSelect;

export const brandInsertSchema = createInsertSchema(brands);
export type BrandInsert = z.infer<typeof brandInsertSchema>;
export type Brand = typeof brands.$inferSelect;

export const cardInsertSchema = createInsertSchema(cards, {
  playerFirstName: (schema) => schema.min(1, "First name is required"),
  playerLastName: (schema) => schema.min(1, "Last name is required"),
  cardNumber: (schema) => schema.min(1, "Card number is required"),
  year: (schema) => schema.min(1900, "Year must be after 1900").max(new Date().getFullYear(), "Year cannot be in the future"),
});

export const cardSchema = z.object({
  id: z.number().optional(),
  sport: z.string().min(1, "Sport is required"),
  playerFirstName: z.string().min(1, "First name is required"),
  playerLastName: z.string().min(1, "Last name is required"),
  brand: z.string().min(1, "Brand is required"),
  collection: z.string().optional(),
  cardNumber: z.string().min(1, "Card number is required"),
  year: z.number().min(1900, "Year must be after 1900").max(new Date().getFullYear(), "Year cannot be in the future"),
  variant: z.string().optional(),
  serialNumber: z.string().optional(),
  condition: z.string().optional(),
  /**
   * User-supplied PSA grade (1–10, half-steps allowed). When set, it overrides
   * the Holo-predicted grade for the eBay at-grade tier. Use this when the
   * user knows the card is already slabbed — a PSA-10 Arenado's comps look
   * nothing like a raw or PSA-8 Arenado, so this field steers the comp pool.
   */
  psaGrade: z.number().min(1).max(10).optional().nullable(),
  estimatedValue: z.number().optional(),
  isRookieCard: z.boolean().optional().default(false),
  isAutographed: z.boolean().optional().default(false),
  isNumbered: z.boolean().optional().default(false),
  isFoil: z.boolean().optional().default(false),
  foilType: z.string().optional().nullable(),
  notes: z.string().optional(),
  frontImage: z.string().optional(),
  backImage: z.string().optional(),
  googleSheetId: z.string().optional(),
  cmpNumber: z.string().optional(),
  set: z.string().optional(),
  team: z.string().optional(),
  _engine: z.literal('ocr').optional(),
});

export type CardInsert = z.infer<typeof cardInsertSchema>;
export type Card = typeof cards.$inferSelect;
export type CardWithRelations = Card & {
  sport?: Sport;
  brand?: Brand;
  user?: User;
};
export type CardFormValues = z.infer<typeof cardSchema>;

// =============================================
// Card Reference Database (imported from CSV)
// =============================================

export const cardDatabase = pgTable("card_database", {
  id: serial("id").primaryKey(),
  brandId: text("brand_id").notNull(),         // e.g. "bowman_baseball"
  brand: text("brand").notNull(),               // e.g. "Bowman"
  year: integer("year").notNull(),
  collection: text("collection").notNull(),     // e.g. "Bowman Base"
  set: text("set"),                            // e.g. "Topps Series 1" — the product set name
  cardNumberRaw: text("card_number_raw").notNull(), // e.g. "1", "TOG-20"
  cmpNumber: text("cmp_number"),               // internal CMP reference
  playerName: text("player_name").notNull(),   // full name, e.g. "Mike Trout"
  team: text("team"),
  rookieFlag: text("rookie_flag"),             // "Rookie Card" or empty
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  // OCR lookup: (year, brand, card_number_raw). year leads because it is an integer
  // equality predicate and the most selective anchor — PostgreSQL uses it to jump to
  // just the rows for that year (~10–20K), then applies the lower() filters on
  // brand and card_number_raw only within that small slice. brand leads in the task
  // spec wording but year-first is intentionally used here for this reason.
  index("card_db_year_brand_cardnum_idx").on(table.year, table.brand, table.cardNumberRaw),
  // Import delete step filters on brand_id + year — index makes batch deletes fast.
  index("card_db_brandid_year_idx").on(table.brandId, table.year),
]);

export const cardDatabaseInsertSchema = createInsertSchema(cardDatabase);
export type CardDatabaseInsert = z.infer<typeof cardDatabaseInsertSchema>;
export type CardDatabaseEntry = typeof cardDatabase.$inferSelect;

export const cardVariations = pgTable("card_variations", {
  id: serial("id").primaryKey(),
  brandId: text("brand_id").notNull(),
  brand: text("brand").notNull(),
  year: integer("year").notNull(),
  collection: text("collection").notNull(),
  set: text("set"),                            // product set name, mirrors card_database.set
  variationOrParallel: text("variation_or_parallel").notNull(), // e.g. "Sky Blue", "Gold Refractor"
  serialNumber: text("serial_number"),         // e.g. "/499", "Not serialized", "None detected"
  cmpNumber: text("cmp_number"),
  hobbyOdds: text("hobby_odds"),
  jumboOdds: text("jumbo_odds"),
  breakerOdds: text("breaker_odds"),
  valueOdds: text("value_odds"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  // Variation lookup filters on brand_id + year + collection.
  // Also covers the import delete step (brand_id + year prefix).
  index("card_var_brandid_year_collection_idx").on(table.brandId, table.year, table.collection),
]);

export const cardVariationsInsertSchema = createInsertSchema(cardVariations);
export type CardVariationsInsert = z.infer<typeof cardVariationsInsertSchema>;
export type CardVariation = typeof cardVariations.$inferSelect;

// =============================================
// Holo — AI Condition Grading
// =============================================
// One row per Holo grading run. A grade can stand alone (attached to a scan
// that wasn't saved as a Card yet) OR be linked to a saved Card via cardId.
// The overall_grade uses half-step values (1.0..10.0) per PSA convention.

export const scanGrades = pgTable("scan_grades", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: 'cascade' }),
  cardId: integer("card_id").references(() => cards.id, { onDelete: 'set null' }),
  frontImagePath: text("front_image_path"),
  backImagePath: text("back_image_path"),
  // Sub-grades (1..10, half-steps). centeringBack is null when back image
  // wasn't provided.
  centering: numeric("centering", { precision: 3, scale: 1 }).notNull(),
  centeringBack: numeric("centering_back", { precision: 3, scale: 1 }),
  corners: numeric("corners", { precision: 3, scale: 1 }).notNull(),
  edges: numeric("edges", { precision: 3, scale: 1 }).notNull(),
  surface: numeric("surface", { precision: 3, scale: 1 }).notNull(),
  overallGrade: numeric("overall_grade", { precision: 3, scale: 1 }).notNull(),
  gradeLabel: text("grade_label").notNull(),            // e.g. "NM-MT 8"
  // Free-form per-sub-grade notes + overall bullets, stored as JSON text.
  // Shape: { centering: string, centeringBack: string|null, corners: string,
  //         edges: string, surface: string, overall: string[] }
  notes: jsonb("notes").notNull(),
  model: text("model").notNull(),                       // e.g. "claude-sonnet-4-5"
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  // Identification captured alongside the grade in the same Claude call.
  // Shape: { player, brand, setName, collection, year, cardNumber,
  //          serialNumber, parallel, variant, cmpCode, sport, confidence }
  // Null on legacy rows written before identification was added.
  identification: jsonb("identification"),
  identificationConfidence: numeric("identification_confidence", { precision: 4, scale: 3 }),
  // External catalog linkage. Set when a scan is successfully matched to a
  // third-party catalog (currently SportsCardsPro). `externalCatalogId` is
  // the vendor's product ID (opaque string), `externalCatalogSource` is the
  // vendor slug (e.g. "sportscardspro") so we can add more sources later
  // without re-reading every row.
  externalCatalogId: text("external_catalog_id"),
  externalCatalogSource: text("external_catalog_source"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("scan_grades_user_idx").on(table.userId),
  index("scan_grades_card_idx").on(table.cardId),
  index("scan_grades_created_idx").on(table.createdAt),
  index("scan_grades_ext_catalog_idx").on(table.externalCatalogSource, table.externalCatalogId),
]);

export const scanGradesInsertSchema = createInsertSchema(scanGrades);
export type ScanGradeInsert = z.infer<typeof scanGradesInsertSchema>;
export type ScanGrade = typeof scanGrades.$inferSelect;

// =============================================
// Import History (tracks each CSV import event)
// =============================================

export const importHistory = pgTable("import_history", {
  id: serial("id").primaryKey(),
  type: text("type", { enum: ["cards", "variations"] }).notNull(),
  countBefore: integer("count_before").notNull(),
  countAfter: integer("count_after").notNull(),
  delta: integer("delta").notNull(),
  importedAt: timestamp("imported_at").defaultNow().notNull(),
});

export type ImportHistoryEntry = typeof importHistory.$inferSelect;

// =============================================
// SportsCardsPro miss log (diagnostic)
// =============================================
// One row per catalog lookup that failed to find a confident match. Used
// for tuning the match-score threshold and for an admin report of cards
// SCP doesn't cover. Never contains PII beyond user_id; the query we sent
// and the top-N candidates SCP returned (if any) are stored for
// reproduction. Intentionally append-only — we never update rows.

export const scpMissLog = pgTable("scp_miss_log", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: 'set null' }),
  // Copy of the scan fields we built the query from. Intentionally denormalized
  // so a miss row still makes sense after the scan is edited or deleted.
  playerName: text("player_name"),
  year: integer("year"),
  brand: text("brand"),
  collection: text("collection"),
  setName: text("set_name"),
  cardNumber: text("card_number"),
  parallel: text("parallel"),
  // The exact query string sent to SCP (/api/products?q=...) and the
  // outcome. reason is one of: "no_results", "below_threshold", "api_error".
  query: text("query").notNull(),
  reason: text("reason", { enum: ["no_results", "below_threshold", "api_error"] }).notNull(),
  // Top candidates returned by SCP (if any) with their match scores, for
  // reproduction. Shape: [{ id, productName, consoleName, score }]
  candidates: jsonb("candidates"),
  // Score of the best candidate that still fell below the threshold. Null
  // for no_results / api_error. Scores are 0..100 (see
  // server/sportscardspro/match.ts — rankCandidates clamps to that range),
  // so we need at least three integer digits. Previous schema used
  // NUMERIC(4,3) = max 9.999 which overflowed on any real miss and threw
  // "numeric field overflow" from the log-insert. NUMERIC(6,3) gives
  // headroom up to 999.999 while preserving 3-decimal precision for the
  // breakdown analytics.
  bestScore: numeric("best_score", { precision: 6, scale: 3 }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("scp_miss_log_created_idx").on(table.createdAt),
  index("scp_miss_log_reason_idx").on(table.reason),
]);

export type ScpMissLogEntry = typeof scpMissLog.$inferSelect;
export type ScpMissLogInsert = typeof scpMissLog.$inferInsert;

// ── scp_product_cache ──────────────────────────────────────────────────────
// Read-through cache for SCP API responses, keyed by a deterministic query
// hash. Makes repeat scans of the same card free (no outbound API call, no
// rate-limit cost) and gives us a resilient local copy of SCP data even if
// their API is briefly unreachable. SCP regenerates their own data once per
// 24h, so a 24h TTL matches upstream freshness exactly.
//
// Cache is keyed per *kind* of call ("search" vs "product") so we don't risk
// collisions between a search for "michael jordan" and a product lookup for
// product id 72584 that happens to hash to the same string.
//
// Writers set fetchedAt=now() on insert and on refresh. Readers treat rows
// older than 24h as stale and trigger a refresh. A daily cron can prune rows
// older than ~7 days; we keep stale rows around briefly as an emergency
// fallback if SCP is unreachable (graceful degradation > hard failure).
export const scpProductCache = pgTable("scp_product_cache", {
  id: serial("id").primaryKey(),
  // "search" (for /api/products?q=...) or "product" (for /api/product?id=...)
  kind: text("kind", { enum: ["search", "product"] }).notNull(),
  // Deterministic hash of the normalized query (lowercased, whitespace-collapsed).
  // sha256 hex truncated to 32 chars — collision-proof enough for a cache.
  queryHash: text("query_hash").notNull(),
  // The exact query string or product id that produced this hash, for debugging.
  queryText: text("query_text").notNull(),
  // The full SCP response body as returned. For "search", this is the
  // `products` array. For "product", this is the single product object.
  responseJson: jsonb("response_json").notNull(),
  fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
}, (table) => [
  index("scp_cache_kind_hash_idx").on(table.kind, table.queryHash),
  index("scp_cache_fetched_idx").on(table.fetchedAt),
]);

export type ScpProductCacheEntry = typeof scpProductCache.$inferSelect;
export type ScpProductCacheInsert = typeof scpProductCache.$inferInsert;
