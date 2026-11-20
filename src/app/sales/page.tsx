import { AppShell } from '@/components/AppShell';
import { SalesView } from '@/components/sales/SalesView';

export const metadata = {
  title: 'Sales - Billing System',
};

export default function SalesPage() {
  return (
    <AppShell title="Sales">
      <SalesView />
    </AppShell>
  );
}
