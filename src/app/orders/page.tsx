import { Suspense } from 'react';
import { AppShell } from '@/components/AppShell';
import { OrdersView } from '@/components/orders/OrdersView';

export const metadata = {
  title: 'Customer orders - Billing System',
};

export default function OrdersPage() {
  return (
    <AppShell title="Customer orders">
      {/* OrdersView reads ?id= and ?new=, which needs a Suspense boundary for static builds. */}
      <Suspense fallback={<div className="p-6 text-sub">Loading customer orders…</div>}>
        <OrdersView />
      </Suspense>
    </AppShell>
  );
}
