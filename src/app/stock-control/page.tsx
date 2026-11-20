import { AppShell } from '@/components/AppShell';
import { StockControlView } from '@/components/inventory/StockControlView';

export const metadata = {
  title: 'Stock control',
};

export default function Page() {
  return (
    <AppShell title="Stock control">
      <StockControlView />
    </AppShell>
  );
}
