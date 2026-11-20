import type { Metadata } from 'next';
import { ReactNode } from 'react';
import { Providers } from './providers';
import '@/styles.css';

export const metadata: Metadata = {
  title: { default: 'BillSynix', template: '%s · BillSynix' },
  description: 'BillSynix — Smart Billing. Smarter Business. GST billing, POS, inventory and store management.',
  applicationName: 'BillSynix',
  icons: { icon: [{ url: '/favicon.ico', sizes: 'any' }, { url: '/brand/logo-mark-192.png', type: 'image/png', sizes: '192x192' }], apple: '/apple-touch-icon.png' },
  metadataBase: new URL('http://localhost:3000'),
};

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head />
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
