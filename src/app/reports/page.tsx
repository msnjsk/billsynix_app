import { Suspense } from 'react';
import { AppShell } from '@/components/AppShell';
import { ReportsView } from '@/components/reports/ReportsView';

export const metadata = {
  title: 'Reports',
};

export default function ReportsPage() {
  return (
    <AppShell title="Reports">
      {/* ReportsView reads ?r=, which needs a Suspense boundary for static builds. */}
      <Suspense fallback={<div className="p-6 text-sub">Loading reports…</div>}>
        <ReportsView />
      </Suspense>
    </AppShell>
  );
}
