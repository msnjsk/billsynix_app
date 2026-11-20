import { AppShell } from '@/components/AppShell';
import { BusinessProfileView } from '@/components/business/BusinessProfileView';

export const metadata = {
  title: 'Business profile - Billing System',
};

export default function BusinessProfilePage() {
  return (
    <AppShell title="Business profile">
      <BusinessProfileView />
    </AppShell>
  );
}
