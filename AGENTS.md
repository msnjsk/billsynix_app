# Billing System - Frontend

A modern billing system built with **Next.js 15**, **React 19**, and **TypeScript**.

## Tech Stack

- **Framework**: Next.js 15
- **UI Library**: React 19 with TypeScript
- **Styling**: Tailwind CSS 4
- **UI Components**: Radix UI
- **Forms**: React Hook Form with Zod validation
- **Data Fetching**: TanStack Query (React Query)
- **Charts**: Recharts
- **Testing**: Jest + React Testing Library

## Project Structure

```
src/
├── app/                 # Next.js App Router pages
├── components/          # Reusable React components
├── hooks/               # Custom React hooks
├── lib/                 # Utility functions and helpers
├── styles/              # Global styles
└── types/               # TypeScript type definitions
```

## Getting Started

### Prerequisites

- Node.js 18+ or Bun
- npm, yarn, pnpm, or bun

### Installation

```bash
# Install dependencies
npm install
# or
bun install
```

### Development

```bash
# Start development server
npm run dev
# or
bun dev
```

The application will be available at `http://localhost:3000`.

### Build

```bash
npm run build
npm start
```

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint
- `npm run format` - Format code with Prettier
- `npm run type-check` - Run TypeScript type checking
- `npm test` - Run tests
- `npm run test:watch` - Run tests in watch mode

## Configuration

### Path Aliases

Configure path aliases in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

Use in imports: `import { Button } from '@/components/ui/Button'`

### Environment Variables

Create a `.env.local` file for environment-specific variables:

```env
NEXT_PUBLIC_API_URL=http://localhost:3000
```

## Contributing

This project follows standard Git and code conventions. Commits include Co-authored-by trailers.

## License

Proprietary - Billing System

