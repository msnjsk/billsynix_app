import { PosView } from '@/components/pos/PosView';
import { RequireAuth } from '@/components/auth/RequireAuth';

export const metadata = {
  title: 'POS & Billing - Billing System',
};

/** Full-screen billing counter — deliberately outside the dashboard shell (no sidebar). Any signed-in role may bill. */
export default function PosPage() {
  return (
    <RequireAuth>
      <PosView />
    </RequireAuth>
  );
}
