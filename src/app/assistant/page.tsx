import { Suspense } from 'react';
import { AppShell } from '@/components/AppShell';
import { AssistantView } from '@/components/assistant/AssistantView';

export const metadata = {
  title: 'AI Assistant - Billing System',
};

export default function AssistantPage() {
  return (
    <AppShell title="AI Assistant">
      {/* AssistantView reads ?q=, which needs a Suspense boundary for static builds. */}
      <Suspense fallback={<div className="p-6 text-sub">Loading assistant…</div>}>
        <AssistantView />
      </Suspense>
    </AppShell>
  );
}
