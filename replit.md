# Sports Card Inventory Management System

## Overview
This project provides a web application for sports card price lookup, leveraging eBay data and automated card detection. Its core purpose is to assist users in identifying sports cards and determining their current market value through real-time price analysis. The system uses Google Cloud Vision API for optical character recognition (OCR) to automatically identify card details from uploaded images.

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
- **Database ORM**: Drizzle ORM with PostgreSQL (Neon serverless)
- **File Upload**: Multer
- **Image Processing**: Google Cloud Vision API for OCR
- **External APIs**: eBay API for price analysis

### Database
- **Schema**: `cards`, `sports`, `brands`, `confirmed_cards` tables with foreign key relationships.
- **Technology**: PostgreSQL hosted on Neon.
- **Migrations**: Drizzle Kit.
- **confirmed_cards**: Stores user-verified card data for building a reference database. Serial numbers are stored as generic limits (e.g., "/399" instead of "010/399"). Duplicate detection uses cardNumber + year + brand + playerLastName + variant. Confirmation count increments on repeat confirmations.

### Key Features
- **Automated Card Detection**: Utilizes Google Cloud Vision API for OCR and advanced text analysis to identify player names, card numbers, brands, collections, and years, including special cases like rookie cards, autographs, and serial numbers.
- **Image Management**: Supports uploading front and back card images, storing them locally, and proper MIME type handling.
- **Price Lookup**: Integrates with the eBay API to fetch and display the 5 most recent sold listings for accurate market value estimation, with optimized search queries.
- **Dynamic Variant Detection**: Systematically identifies card variants (e.g., foil types, parallels, textures) through visual analysis and eBay listing title analysis.
- **Generic Detection Logic**: Card processing relies on dynamic, generic detection methods (line-based, regex-based, positional scoring) rather than hard-coded rules for specific cards.
- **Editable Data**: Users can manually edit detected card fields and re-run eBay searches.

## External Dependencies

- **Google Cloud Services**:
    - **Vision API**: For OCR and visual analysis.
    - **Sheets API**: Optional for data synchronization.
- **eBay API**: For real-time price lookup and market analysis, using the Finding Service and automated OAuth token management.
- **Neon Database**: Serverless PostgreSQL for data persistence.