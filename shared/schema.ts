import { pgTable, text, serial, integer, boolean, timestamp, jsonb, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { relations } from "drizzle-orm";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

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
  // OCR lookup: brand + year + card_number_raw. year is an integer so it anchors
  // the index scan; the lower() expressions then apply only to the matching subset.
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
