import { AppShell } from '@/components/AppShell';
import { GstReportView } from '@/components/reports/GstReportView';

export const metadata = {
  title: 'GST report',
};

export default function GstReportPage() {
  return (
    <AppShell title="GST report">
      <GstReportView />
    </AppShell>
  );
}
