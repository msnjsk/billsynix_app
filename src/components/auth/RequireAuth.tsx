'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { canOpen, homeFor, useHydrated, useSession, type Role } from '@/lib/auth';
import { useSetup } from '@/lib/setup';
import { bootLive, isLive, retryLoad, useLiveStatus } from '@/lib/live/session';
import '@/lib/live/hydrate';
import { CloseOtherDrawerDialog, OpeningCashDialog } from '@/components/live/OpeningCashDialog';
import { BrandBadge } from '@/components/brand/Brand';

function Checking() {
  return (
    <div className="grid h-dvh place-items-center bg-bg">
      <div className="flex flex-col items-center gap-3 text-sub">
        <span className="animate-pulse"><BrandBadge className="h-12" padding="px-3 py-2" /></span>
        <span className="flex gap-1" aria-label="Loading">
          {[0, 150, 300].map((d) => (
            <i key={d} className="size-1.5 animate-bounce rounded-full bg-blue/60" style={{ animationDelay: `${d}ms` }} />
          ))}
        </span>
      </div>
    </div>
  );
}

/**
 * Shows `children` only to a signed-in user allowed on this page. Others are sent to
 * /login (returning here afterwards) or to their own home page (cashiers → POS).
 */
function LoadFailed({ message }: { message: string }) {
  return (
    <div className="grid h-dvh place-items-center bg-bg p-6">
      <div className="max-w-sm rounded-2xl border border-line bg-surface p-6 text-center shadow-sm">
        <p className="text-[15px] font-bold text-ink">Couldn’t load your store</p>
        <p className="mt-1 text-[13px] text-sub">{message}</p>
        <button onClick={() => void retryLoad()} className="mt-4 h-10 rounded-xl gbv px-5 text-[13px] font-semibold text-onbrand">
          Try again
        </button>
      </div>
    </div>
  );
}

export function RequireAuth({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const live = useLiveStatus();
  useEffect(() => {
    void bootLive();
  }, []);
  const hydrated = useHydrated();
  const setup = useSetup();
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();

  const allowed = !!setup && !!session && canOpen(session.role, pathname) && (!roles || roles.includes(session.role));

  // Connected: wait for the session to be restored and the store's data to load.
  const waiting = isLive() && (live.state === 'restoring' || live.state === 'loading');

  useEffect(() => {
    if (!hydrated || allowed || waiting) return;
    if (!setup) router.replace('/setup'); // first run on this computer
    else if (!session) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else router.replace(homeFor(session.role));
  }, [hydrated, allowed, waiting, setup, session, pathname, router]);

  if (isLive() && live.state === 'error' && session) return <LoadFailed message={live.message} />;
  return hydrated && allowed && !waiting ? (
    <>
      {children}
      {isLive() && <OpeningCashDialog />}
      {isLive() && <CloseOtherDrawerDialog />}
    </>
  ) : (
    <Checking />
  );
}
