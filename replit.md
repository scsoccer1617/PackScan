# ScanDeck - Sports Card Price Lookup

## Overview
ScanDeck (scandeck.io) is a web application for sports card price lookup, leveraging eBay data and automated card detection. Its core purpose is to assist users in identifying sports cards and determining their current market value through real-time price analysis. The system uses Google Cloud Vision API for optical character recognition (OCR) to automatically identify card details from uploaded images.

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
- **card_database**: Reference catalog imported from CSV. Contains brand, year, collection, card number, player name, team, rookie flag. Currently holds 12,892 cards.
- **card_variations**: Parallel/variation catalog imported from CSV. Contains brand, year, collection, variation name, serial number limit, pack odds. Currently holds 95,138 entries.

### Key Features
- **Automated Card Detection**: Utilizes Google Cloud Vision API for OCR and advanced text analysis to identify player names, card numbers, brands, collections, and years, including special cases like rookie cards, autographs, and serial numbers.
- **DB-Driven Card Lookup**: After OCR extracts brand + year + card number, the system looks these up in the card_database table for authoritative player name, team, collection, and rookie status. If no DB match, falls back to OCR-only results. Variation lookup (by serial number) identifies the specific parallel (e.g., /499 → Sky Blue).
- **Image Management**: Supports uploading front and back card images, storing them locally, and proper MIME type handling.
- **Price Lookup**: Integrates with the eBay API to fetch and display the 5 most recent sold listings for accurate market value estimation, with optimized search queries.
- **Dynamic Variant Detection**: Systematically identifies card variants (e.g., foil types, parallels, textures) through visual analysis and eBay listing title analysis.
- **Generic Detection Logic**: Card processing relies on dynamic, generic detection methods (line-based, regex-based, positional scoring) rather than hard-coded rules for specific cards.
- **Editable Data**: Users can manually edit detected card fields and re-run eBay searches.
- **User Feedback**: Thumbs up/down confirmation system to verify OCR accuracy and build a reference database of confirmed cards.
- **Admin Panel**: Available at `/admin/card-database` — shows DB stats and supports uploading new CSV files to refresh the card/variation catalog. Also has a clear-all button for re-importing from scratch.

### Card Database Admin
- Route: `/admin/card-database` (database icon in header)
- API: `GET /api/card-database/stats`, `POST /api/card-database/import-cards`, `POST /api/card-database/import-variations`, `DELETE /api/card-database/clear`
- Seeding script: `npx tsx db/seedCardDatabase.ts` (skips if tables already populated)

## External Dependencies

- **Google Cloud Services**:
    - **Vision API**: For OCR and visual analysis.
    - **Sheets API**: Optional for data synchronization.
- **eBay API**: For real-time price lookup and market analysis, using the Finding Service and automated OAuth token management.
- **Custom Domain**: scandeck.io
