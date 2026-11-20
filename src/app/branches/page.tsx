import { AppShell } from '@/components/AppShell';
import { BranchesView } from '@/components/branches/BranchesView';

export const metadata = {
  title: 'Branches - Billing System',
};

export default function BranchesPage() {
  return (
    <AppShell title="Branches">
      <BranchesView />
    </AppShell>
  );
}
