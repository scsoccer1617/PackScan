# PackScan - Sports Card Price Lookup

## Overview
PackScan (packscan.io) is a web application for sports card price lookup, leveraging eBay data and automated card detection. Its core purpose is to assist users in identifying sports cards and determining their current market value through real-time price analysis. The system uses Google Cloud Vision API for optical character recognition (OCR) to automatically identify card details from uploaded images.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React with TypeScript
- **UI/UX**: Radix UI components, shadcn/ui styling, Tailwind CSS
- **State Management**: TanStack React Query
- **Build Tool**: Vite
- **Form Handling**: React Hook Form with Zod validation

### Backend
- **Runtime**: Node.js with Express.js (TypeScript, ESM)
- **Database ORM**: Drizzle ORM with PostgreSQL (Replit built-in)
- **Database Driver**: Standard `pg` package (node-postgres)
- **File Upload**: Multer
- **Image Processing**: Google Cloud Vision API for OCR
- **External APIs**: eBay API for price analysis

### Database
- **Schema**: `cards`, `sports`, `brands`, `confirmed_cards`, `card_database`, `card_variations` tables.
- **Technology**: Replit built-in PostgreSQL (Neon-backed).
- **Migrations**: Drizzle Kit. Run `npm run db:push` after schema changes.
- **confirmed_cards**: Stores user-verified card data for building a reference database. Serial numbers are stored as generic limits (e.g., "/399" instead of "010/399"). Duplicate detection uses cardNumber + year + brand + playerLastName + variant. Confirmation count increments on repeat confirmations.
- **card_database**: Reference catalog imported from CSV. Contains brand, year, collection, set, card number, player name, team, rookie flag. Currently holds 12,892 cards. The `set` column is populated from the CSV `set` column and represents the product set name (e.g. "Topps Series 1").
- **card_variations**: Parallel/variation catalog imported from CSV. Contains brand, year, collection, set, variation name, serial number limit, pack odds. Currently holds 95,138 entries. The `set` column mirrors the card_database set value.

### Key Features
- **Gemini Vision Fallback**: When the OCR+DB cascade leaves the card # low-confidence (`_cardNumberLowConfidence=true`), `server/geminiCardAnalyzer.ts` re-analyses the front+back images with `gemini-2.5-flash` (via Replit AI Integrations — no API key, billed to credits) using a structured JSON response schema. It only **fills empty fields** from the OCR result (never overwrites confident OCR values) and clears the low-confidence flag when it recovers a card number. Controlled by env vars `AI_INTEGRATIONS_GEMINI_BASE_URL` / `AI_INTEGRATIONS_GEMINI_API_KEY` (auto-provisioned).
- **Gemini-First Engine (opt-in)**: `POST /api/analyze-card-dual-images` accepts an `engine` form/query param (`ocr` default, `gemini` opt-in). When set to `gemini`, the handler runs `analyzeCardWithGemini` on the raw images first, enriches the result via `lookupCard` (authoritative player/team/collection/set/rookie/variation), then runs the visual foil detector only if Gemini didn't already name a variant. If Gemini errors or returns an unusable result (missing brand/year/#), it transparently falls back to the OCR+DB pipeline. The UI exposes a "Try Gemini first (beta)" toggle on `/` above the upload area. The response includes a `_engine: 'gemini'` marker when Gemini produced the result. Logs are prefixed with `[Engine] gemini-first START/END` / `[Engine] ocr-first START` for telemetry.
- **Automated Card Detection**: Utilizes Google Cloud Vision API for OCR and advanced text analysis to identify player names, card numbers, brands, collections, and years, including special cases like rookie cards, autographs, and serial numbers. Uses `DOCUMENT_TEXT_DETECTION` mode (better than `TEXT_DETECTION` for dense, structured card text) with `languageHints: ['en']` to reduce misreads. Front and back images are batched into a single Vision API request (reducing calls from 4 → 1 per scan), with results cached per-request so downstream analysers pay zero additional API cost.
- **DB-Driven Card Lookup**: After OCR extracts brand + year + card number, the system looks these up in the card_database table for authoritative player name, team, collection, and rookie status. If no DB match, falls back to OCR-only results. Variation lookup (by serial number) identifies the specific parallel (e.g., /499 → Sky Blue).
- **Image Management**: Supports uploading front and back card images, storing them locally, and proper MIME type handling.
- **Price Lookup**: Integrates with the eBay API (Finding API `findCompletedItems` for sold listings; Browse API OAuth fallback for active listings when rate-limited) to display up to 5 relevant eBay results for market value estimation. UI clearly distinguishes sold vs active listing mode.
- **Dynamic Variant Detection**: Systematically identifies card variants (e.g., foil types, parallels, textures) through visual analysis and eBay listing title analysis.
- **Generic Detection Logic**: Card processing relies on dynamic, generic detection methods (line-based, regex-based, positional scoring) rather than hard-coded rules for specific cards.
- **Editable Data**: Users can manually edit detected card fields and re-run eBay searches.
- **User Feedback**: Thumbs up/down on a scan. Thumbs-up records a positive feedback row in `confirmed_cards` (for analytics/auditing only) — it no longer overrides future scans. Thumbs-down opens the edit flow so the user can correct the detected fields. The `card_database` lookup is the authoritative source of truth for catalog identity (player, brand, year, collection, set, card number, rookie/auto flags).
- **Edit Card Form (scan results & stored cards)**: Collection and Set fields are dropdowns populated from `card_database`, filtered live by the selected Brand + Year (Set additionally narrows by Collection when set). Falls back to a free-text input when no DB matches exist for the chosen brand/year. Backed by `GET /api/card-database/collections?brand=&year=` and `GET /api/card-database/sets?brand=&year=&collection=`.
- **Admin Panel**: Available at `/admin/card-database` — shows DB stats and supports uploading new CSV files to refresh the card/variation catalog. Also has a clear-all button for re-importing from scratch.
- **Holo Grading Engine**: Every call to `POST /api/analyze-card-dual-images` auto-runs an AI condition grader (Anthropic Claude vision) in parallel with OCR + eBay. Holo produces a PSA-style half-step overall grade (1.0–10.0), four sub-grades (centering front, centering back when provided, corners, edges, surface), per-sub-grade notes, up to three overall takeaways, and a PSA label (GEM MT 10 / MINT 9 / NM-MT 8 / etc.). Grades are attached to the scan response as `data.holo` and rendered by `<HoloGradeCard>` on `/` above the eBay results. All grades are persisted in the `scan_grades` table (indexed by user + created_at), and `GET /api/scan-grades?limit=25` returns the authenticated user's most-recent grades. Implementation: `server/holo/cardGrader.ts` (Claude wrapper), `server/holo/storage.ts` (Drizzle persistence), `client/src/components/HoloGradeCard.tsx` (UI). Holo is fully optional — if `ANTHROPIC_API_KEY` is not set or grading fails, the scan still succeeds and `data.holo = null`. Model is `claude-sonnet-4-5` by default, overridable via the `HOLO_MODEL` env var.

### Holo Grading
- **Required env var**: `ANTHROPIC_API_KEY` — set as a Replit secret to enable grading. Without it, scans still work but `data.holo` will always be `null`.
- **Optional env var**: `HOLO_MODEL` — override the Claude model (defaults to `claude-sonnet-4-5`).
- **Schema**: `scan_grades` table lives in `shared/schema.ts` and was added via Drizzle migration — run `npm run db:push` after pulling this branch to create it.
- **Persistence**: Each grade is saved with the authenticated user's id (nullable, so anonymous scans also grade), an optional `card_id` link, numeric sub-grades, JSON notes, the overall grade/label, confidence, and the model that produced it.
- **Parallelism**: Grading kicks off immediately when the route handler starts and is awaited just before each `res.json` return, so it overlaps OCR+eBay and adds minimal latency on the success path.

### Card Database Admin
- Route: `/admin/card-database` (database icon in header)
- API: `GET /api/card-database/stats`, `POST /api/card-database/import-cards`, `POST /api/card-database/import-variations`, `DELETE /api/card-database/clear`
- Seeding script: `npx tsx db/seedCardDatabase.ts` (skips if tables already populated)
- **Push Dev → Prod**: `POST /api/card-database/push-to-prod` + `GET /api/card-database/push-to-prod-status/:jobId` stream `card_database` and `card_variations` from this app's DB into the database pointed at by the `PROD_DATABASE_URL` secret using Postgres `COPY ... (FORMAT binary)`. Each table is replaced inside its own transaction (`TRUNCATE ... RESTART IDENTITY CASCADE` then `COPY FROM`), so a mid-copy failure leaves prod untouched. Refuses to run if `PROD_DATABASE_URL` equals `DATABASE_URL`. Triggered from a "Push to Production" button on the admin page; runs as a background job with per-table progress polling. Implementation lives in `server/pushToProd.ts`.

## External Dependencies

- **Google Cloud Services**:
    - **Vision API**: For OCR and visual analysis.
    - **Sheets API**: Optional for data synchronization.
- **eBay API**: For real-time price lookup and market analysis, using the Finding Service and automated OAuth token management.
- **Custom Domain**: scandeck.io
