import { AppShell } from '@/components/AppShell';
import { EndOfDayView } from '@/components/reports/EndOfDayView';

export const metadata = {
  title: 'End of day',
};

export default function EndOfDayPage() {
  return (
    <AppShell title="End of day">
      <EndOfDayView />
    </AppShell>
  );
}
