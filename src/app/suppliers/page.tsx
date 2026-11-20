import { AppShell } from '@/components/AppShell';
import { SuppliersView } from '@/components/suppliers/SuppliersView';

export const metadata = {
  title: 'Suppliers - Billing System',
};

export default function SuppliersPage() {
  return (
    <AppShell title="Suppliers">
      <SuppliersView />
    </AppShell>
  );
}
