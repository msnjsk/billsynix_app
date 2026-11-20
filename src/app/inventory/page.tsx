import { AppShell } from '@/components/AppShell';
import { InventoryView } from '@/components/inventory/InventoryView';

export const metadata = {
  title: 'Inventory - Billing System',
};

export default function InventoryPage() {
  return (
    <AppShell title="Inventory">
      <InventoryView />
    </AppShell>
  );
}
