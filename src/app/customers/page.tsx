import { Suspense } from 'react';
import { AppShell } from '@/components/AppShell';
import { CustomersView } from '@/components/customers/CustomersView';

export const metadata = {
  title: 'Customers - Billing System',
};

export default function CustomersPage() {
  return (
    <AppShell title="Customers">
      {/* CustomersView reads ?id=, which needs a Suspense boundary for static builds. */}
      <Suspense fallback={<div className="p-6 text-sub">Loading customers…</div>}>
        <CustomersView />
      </Suspense>
    </AppShell>
  );
}
