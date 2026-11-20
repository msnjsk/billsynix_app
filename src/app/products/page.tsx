import { Suspense } from 'react';
import { AppShell } from '@/components/AppShell';
import { ProductsView } from '@/components/products/ProductsView';

export const metadata = {
  title: 'Products - Billing System',
};

export default function ProductsPage() {
  return (
    <AppShell title="Products">
      {/* ProductsView reads ?q= and ?add=true, which needs a Suspense boundary for static builds. */}
      <Suspense fallback={<div className="p-6 text-sub">Loading products…</div>}>
        <ProductsView />
      </Suspense>
    </AppShell>
  );
}
