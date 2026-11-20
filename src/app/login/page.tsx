import { Suspense } from 'react';
import { LoginView } from '@/components/auth/LoginView';

export const metadata = {
  title: 'Sign in',
};

export default function LoginPage() {
  return (
    // LoginView reads ?next=, which needs a Suspense boundary for static builds.
    <Suspense fallback={<div className="min-h-dvh bg-surface" />}>
      <LoginView />
    </Suspense>
  );
}
