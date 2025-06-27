# Sports Card Inventory Management System

## Overview

This is a full-stack web application designed for sports card collectors to catalog, manage, and track their card collections. The system features automated card detection using Google Cloud Vision API with OCR capabilities, image upload functionality, and detailed card information management. Built with React frontend and Express.js backend using PostgreSQL for data persistence.

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

### Google Sheets Integration
- **Sync Capability**: Optional synchronization with Google Sheets for backup/sharing
- **OAuth2 Authentication**: Service account authentication for sheets access
- **Batch Operations**: Efficient bulk data operations

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
- June 27, 2025. Initial setup

## User Preferences

Preferred communication style: Simple, everyday language.