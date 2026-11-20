# Billing System

A modern, full-featured billing and inventory management system built with **Next.js 15**, **React 19**, and **TypeScript**.

## Tech Stack

- **Frontend Framework**: [Next.js 15](https://nextjs.org/) with App Router
- **UI Library**: [React 19](https://react.dev/)
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Styling**: [Tailwind CSS 4](https://tailwindcss.com/)
- **UI Components**: [Radix UI](https://www.radix-ui.com/)
- **Forms & Validation**: [React Hook Form](https://react-hook-form.com/) + [Zod](https://zod.dev/)
- **Data Fetching**: [TanStack Query (React Query)](https://tanstack.com/query/latest)
- **Charts**: [Recharts](https://recharts.org/)
- **Testing**: [Jest](https://jestjs.io/) + [React Testing Library](https://testing-library.com/react)

## Project Structure

```
src/
├── app/                    # Next.js App Router
│   ├── layout.tsx          # Root layout
│   ├── page.tsx            # Home page
│   ├── providers.tsx       # Context providers
│   ├── dashboard/          # Dashboard page
│   ├── products/           # Products management
│   ├── orders/             # Orders management
│   ├── inventory/          # Inventory tracking
│   ├── sales/              # Sales reports
│   ├── suppliers/          # Supplier management
│   └── assistant/          # AI Assistant
├── components/
│   ├── AppShell.tsx        # Main app shell/layout
│   └── ui/                 # Reusable UI components
├── hooks/                  # Custom React hooks
├── lib/                    # Utility functions and helpers
├── assets/                 # Images and static assets
└── styles.css              # Global styles
```

## Getting Started

### Prerequisites

- Node.js 18.17+ or Bun
- npm, yarn, pnpm, or bun package manager

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd billing-system
```

2. Install dependencies:
```bash
npm install
# or
bun install
```

3. Create environment file:
```bash
cp .env.example .env.local
```

### Development

Start the development server:

```bash
npm run dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to see the application.

### Build for Production

```bash
npm run build
npm start
```

## Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build optimized production bundle
- `npm start` - Start production server
- `npm run lint` - Run ESLint to check code quality
- `npm run format` - Format code with Prettier
- `npm run type-check` - Run TypeScript type checking
- `npm test` - Run test suite
- `npm run test:watch` - Run tests in watch mode
- `npm run desktop:dev` - Open the POS desktop app against the dev server (run `npm run dev` first)
- `npm run desktop:start` - Build the offline export and open it in the desktop app
- `npm run desktop:dist` - Build the installable desktop app into `dist-desktop/`

## First-run setup (installing at a customer)

On a fresh install every page redirects to `/setup` until the store is set up on that computer:

1. **Business type** (8 types) and the features that suit it
2. **Store details** printed on every bill
3. **GST & billing** — Regular / Composition / Unregistered, GSTIN (check-digit validated, fills the state), FSSAI / drug licence, invoice prefix and the **first bill number** (continue an existing series when migrating)
4. **Owner & staff** — owner password login; cashiers with 4-digit PINs (stored as salted hashes, never in plain text)
5. **This counter** — counter name, UPI ID, receipt printer + test print
6. **Review & finish** — saves everything, signs the owner in

Progress is saved as you go (except passwords/PINs), so setup can be resumed. "Explore with demo data" sets up the
sample store and demo staff instead. Everything is stored on that computer until a server is connected.

## Desktop app (BillSynix)

The POS page also ships as an installable Electron app (`electron/`). It opens straight into
`/pos`, works fully offline (the Next.js static export in `out/` is bundled inside), and adds:

- **Silent printing** to a chosen printer — no print dialog (POS settings → Print using → Desktop printer)
- **Direct ESC/POS** over USB/serial, including the cash drawer, without browser prompts
- WhatsApp, UPI and phone links open in the system's default apps

```bash
npm run desktop:dist   # → dist-desktop/BillSynix Setup <version>.exe (Windows)
```

Build on each target OS for its installer (Windows `.exe`, macOS `.dmg`, Linux `.AppImage`).
Bills, settings and held bills are stored per computer (in the app's data folder) until a backend exists.
The installer is unsigned, so Windows SmartScreen will warn on first install — sign it with a
code-signing certificate before giving it to customers.

Automated check: `POS_SMOKE_SCREENSHOT=shot.png "dist-desktop/win-unpacked/BillSynix.exe"` loads the POS,
saves a screenshot, prints page errors, and exits non-zero if there were any.

## Multi-store (Branches)

`/branches` manages every store and warehouse of the business:

- **Overview** — chain-wide dashboard: sales by branch, month-to-date vs target, scorecard, low stock per branch and suggested transfers.
- **Branches** — address, manager, GSTIN (one per state; branches in the same state share it) and a 2–4 character code used as the bill prefix.
- **Catalogue & pricing** — one central catalogue; each branch can sell below MRP (never above) or stop selling an item.
- **Stock transfers** — requested → dispatched (stock leaves the source) → received (only what arrived is added; shortfalls are recorded). Same GSTIN needs a delivery challan; across GSTINs it's a tax invoice + e-way bill.
- **Sales reports** — branch-wise sales, bills, margin, growth and category mix, with CSV export.

Each computer works at one branch, chosen in the header. The POS bills with that branch's prices, stock, address, GSTIN and invoice series. Data is kept in browser storage (`kirana:branches`) until a backend exists; branch sales are sample figures for now.

## Backend (in progress)

The NestJS + PostgreSQL backend lives in [`backend/`](backend/README.md) and is being built phase by
phase from [`BACKEND_IMPLEMENTATION.md`](BACKEND_IMPLEMENTATION.md). Until Phase 8 connects the
screens, the frontend keeps using browser storage and sample data.

## Configuration

### TypeScript Path Aliases

Path aliases are configured in `tsconfig.json` for cleaner imports:

```json
{
  "paths": {
    "@/*": ["./src/*"]
  }
}
```

Usage in code:
```typescript
import { AppShell } from '@/components/AppShell';
import { products } from '@/lib/store-data';
```

### Environment Variables

Set up your `.env.local` file:

```env
NEXT_PUBLIC_API_URL=http://localhost:3000
```

All variables prefixed with `NEXT_PUBLIC_` are exposed to the browser.

## Features

- 📊 **Dashboard**: Overview of sales, orders, and inventory
- 📦 **Product Management**: Add, edit, and manage products
- 📋 **Order Management**: Track and manage customer orders
- 📈 **Sales Analytics**: View detailed sales reports and trends
- 🏪 **Inventory Tracking**: Monitor stock levels and receive alerts
- 🤝 **Supplier Management**: Manage supplier information
- 🤖 **AI Assistant**: Get AI-powered insights and recommendations
- 🎨 **Modern UI**: Built with Radix UI components and Tailwind CSS
- 📱 **Responsive Design**: Works seamlessly on desktop and mobile
- ♿ **Accessibility**: WCAG compliant with proper ARIA attributes

## Code Style

- **Formatting**: Prettier
- **Linting**: ESLint with TypeScript support
- **Type Safety**: Strict TypeScript mode
- **Naming**: camelCase for variables/functions, PascalCase for components

## Contributing

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make your changes and commit: `git commit -m "Add your feature"`
3. Push to the branch: `git push origin feature/your-feature`
4. Open a Pull Request

## License

Proprietary - Billing System

## Support

For issues or questions, please create an issue in the repository.
