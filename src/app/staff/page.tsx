import { AppShell } from '@/components/AppShell';
import { StaffView } from '@/components/staff/StaffView';

export const metadata = {
  title: 'Staff - Billing System',
};

export default function StaffPage() {
  return (
    <AppShell title="Staff">
      <StaffView />
    </AppShell>
  );
}
