import { AppShell } from '@/components/AppShell';
import { PurchasesView } from '@/components/purchases/PurchasesView';

export const metadata = {
  title: 'Purchases - Billing System',
};

export default function PurchasesPage() {
  return (
    <AppShell title="Purchases">
      <PurchasesView />
    </AppShell>
  );
}
