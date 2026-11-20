import { AppShell } from '@/components/AppShell';
import { ExpensesView } from '@/components/finance/ExpensesView';

export const metadata = {
  title: 'Expenses',
};

export default function Page() {
  return (
    <AppShell title="Expenses">
      <ExpensesView />
    </AppShell>
  );
}
