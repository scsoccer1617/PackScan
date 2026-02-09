# Sports Card Inventory Management System

## Overview

This is a streamlined web application focused on sports card price lookup using eBay data. The system features automated card detection using Google Cloud Vision API with OCR capabilities and real-time eBay price analysis to help users find current market values for their cards. Built with React frontend and Express.js backend.

## System Architecture

### Frontend Architecture
- **Framework**: React with TypeScript
- **UI Library**: Radix UI components with shadcn/ui styling system
- **Styling**: Tailwind CSS with custom design tokens
- **State Management**: TanStack React Query for server state management
- **Build Tool**: Vite for development and bundling
- **Form Handling**: React Hook Form with Zod validation

### Backend Architecture
- **Runtime**: Node.js with Express.js framework
- **Language**: TypeScript with ESM modules
- **Database ORM**: Drizzle ORM with PostgreSQL
- **File Upload**: Multer for handling multipart form data
- **Image Processing**: Google Cloud Vision API for OCR text extraction
- **External APIs**: eBay API integration for card value estimation

### Database Schema
- **Primary Tables**: 
  - `cards` - Main card information with relationships
  - `sports` - Sport categories (Baseball, Basketball, etc.)
  - `brands` - Card manufacturer brands (Topps, Upper Deck, etc.)
- **Storage**: PostgreSQL via Neon serverless
- **Migrations**: Drizzle Kit for schema management
- **Relationships**: Foreign key relationships between cards, sports, and brands

## Key Components

### Card Detection System
- **OCR Engine**: Google Cloud Vision API for text extraction from card images
- **Specialized Handlers**: Custom processors for specific card types (Score cards, Flagship Collection, Stars of MLB, etc.)
- **Pattern Matching**: Advanced text analysis for player names, card numbers, brands, and years
- **Direct Card Fixes**: Hard-coded handlers for problematic cards with known OCR issues

### Image Management
- **Upload System**: Supports front and back card images up to 20MB
- **Storage Strategy**: Local file storage in `/uploads` directory with UUID-based naming
- **Fallback System**: Multiple path resolution for serving card images
- **MIME Type Handling**: Proper content-type headers for image serving

### Card Information Processing
- **Automatic Detection**: Player names, card numbers, brands, collections, years
- **Special Cases**: Rookie card detection, autograph identification, serial number recognition
- **Value Estimation**: Integration with eBay API for market value approximation
- **Data Validation**: Zod schemas for type safety and input validation

### Price Lookup Integration
- **eBay API**: Real-time lookup of recent sold listings for card valuation
- **Market Analysis**: Display of 5 most recent sold prices for accurate market assessment
- **Search Optimization**: Smart query building for better eBay search results

## Data Flow

1. **Card Upload**: User uploads card image(s) via web interface
2. **OCR Processing**: Google Vision API extracts text from images
3. **Card Analysis**: Specialized handlers process OCR text to identify card details
4. **Data Validation**: Extracted information validated against schema
5. **Database Storage**: Card information persisted to PostgreSQL
6. **Image Storage**: Images saved to local filesystem with database references
7. **Optional Sync**: Data optionally synchronized to Google Sheets

## External Dependencies

### Google Cloud Services
- **Vision API**: Text detection and OCR processing
- **Authentication**: Service account credentials for API access
- **Sheets API**: Optional integration for data synchronization

### eBay API
- **Finding Service**: Card value estimation through completed listings search
- **Rate Limiting**: Respectful API usage with proper error handling

### Neon Database
- **PostgreSQL**: Serverless PostgreSQL hosting
- **Connection Pooling**: Efficient database connection management
- **WebSocket Support**: Required for Neon serverless architecture

## Deployment Strategy

### Development
- **Hot Reload**: Vite development server with HMR
- **Type Checking**: TypeScript compilation with strict mode
- **Database**: Local PostgreSQL or Neon development instance

### Production
- **Build Process**: Vite frontend build + esbuild backend compilation
- **Static Assets**: Frontend served from `/dist/public`
- **Environment Variables**: Secure credential management
- **Process Management**: Node.js production server with proper error handling

### Configuration Requirements
- `DATABASE_URL`: PostgreSQL connection string
- `GOOGLE_CLIENT_EMAIL`: Service account email for Vision API
- `GOOGLE_PRIVATE_KEY`: Service account private key
- `GOOGLE_SHEET_ID`: Optional Google Sheets integration
- `EBAY_APP_ID`: Optional eBay API integration

## Changelog
- June 27, 2025: Initial setup
- June 27, 2025: Removed Tesseract OCR fallback, focused exclusively on Google Vision API
- June 27, 2025: Added combined OCR + eBay price lookup endpoint for streamlined user experience
- June 27, 2025: Updated frontend to show both card detection and price analysis in single workflow
- June 28, 2025: Enhanced Series Two card detection - improved card number detection before/after "SERIES TWO" text
- June 28, 2025: Enhanced eBay search strategy for Series Two cards with complete player name and collection details
- June 28, 2025: Implemented enhanced serial number detection system for numbered cards (e.g., "010/399", "16/99")
- June 28, 2025: Added dual-side OCR integration for serial number detection on both front and back images
- June 28, 2025: Implemented comprehensive foil variant detection system for chrome, refractor, autograph, and special finish cards
- June 28, 2025: Added foil-specific eBay search keywords to improve pricing accuracy for premium card variants
- June 30, 2025: Fixed critical foil detection false positive issue - removed foilType from front analyzer priority to prevent "Foil" being set for non-foil cards
- June 30, 2025: Implemented comprehensive visual foil detection system using Google Vision API for metallic surfaces, reflectivity, and prismatic effects analysis
- June 30, 2025: Fixed foil detection false positives for white border reflections with strict rejection criteria and sport-specific text detection
- June 30, 2025: Enhanced fallback logic to properly handle visual detection errors and use conservative text-based detection as backup
- February 9, 2026: Fixed Google Vision API decoder error in visual foil detector by aligning private key formatting with working OCR client
- February 9, 2026: Removed all hardcoded 'Aqua Foil' variant assumptions - variant is now purely dynamic based on visual color analysis and text detection
- February 9, 2026: Added dynamic color classification for visual foil detection (Blue, Green, Red, Gold, Purple, Orange, Pink, Silver, Aqua)
- February 9, 2026: Variant now passed to eBay search query for more accurate pricing when card is not base/standard
- February 9, 2026: Fixed isNumbered not being set when serialNumber detected in combined result
- February 9, 2026: Included alphanumeric card numbers (e.g., SMLB-2) in eBay search queries
- February 9, 2026: Normalized collection names for eBay search (Series Two → Series 2) for better listing matches
- February 9, 2026: Restructured eBay search query format to match eBay listing conventions (year-first, #cardNumber prefix)
- February 9, 2026: Implemented eBay-assisted variant discovery - dynamically discovers specific variant names (e.g., "Aqua Crackle Foil") by parsing listing titles from broader searches
- February 9, 2026: Improved visual foil detection for border foils - detects multiple similarly-tinted color regions indicating foil gradient patterns
- February 9, 2026: Serial number suffix (/399) kept in eBay searches for accurate rarity-based pricing

## User Preferences

Preferred communication style: Simple, everyday language.