'use client';

import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Bell,
  BellOff,
  BellRing,
  CalendarClock,
  CheckCheck,
  CircleDollarSign,
  CloudOff,
  CreditCard,
  Crown,
  PackageCheck,
  PackageX,
  ShoppingBag,
  TrendingDown,
  UserPlus,
  Wallet,
  WifiOff,
} from 'lucide-react';
import {
  markAllRead,
  markRead,
  setNotificationNavigator,
  setPopups,
  useNotifications,
  usePopupState,
  type AppNotification,
} from '@/lib/notifications';

type IconType = ComponentType<{ className?: string }>;

const KIND_ICON: Record<string, IconType> = {
  'stock.out': PackageX,
  'stock.low': TrendingDown,
  'stock.expiry': CalendarClock,
  'order.new': ShoppingBag,
  'khata.over_limit': Wallet,
  'drawer.review': CircleDollarSign,
  'payments.pending': CreditCard,
  'sync.failed': CloudOff,
  'supplier.due': AlertTriangle,
  'grn.received': PackageCheck,
  subscription: Crown,
  'staff.added': UserPlus,
};

const TONE = {
  CRITICAL: 'bg-coral/15 text-coral',
  WARNING: 'bg-amber/15 text-amber',
  INFO: 'bg-blue/10 text-blue',
} as const;

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};

/** The bell: unread count, the list (current alerts, then earlier ones), and desktop pop-ups. */
export function NotificationBell({ size = 'size-10' }: { size?: string }) {
  const router = useRouter();
  const { items, unread, status } = useNotifications();
  const popups = usePopupState();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'all' | 'unread'>('all');
  const box = useRef<HTMLDivElement>(null);

  // Clicking a desktop pop-up opens its screen in the app.
  useEffect(() => setNotificationNavigator((href) => router.push(href)), [router]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const { current, earlier } = useMemo(() => {
    const shown = tab === 'unread' ? items.filter((n) => n.active && !n.read) : items;
    return { current: shown.filter((n) => n.active), earlier: shown.filter((n) => !n.active).slice(0, 15) };
  }, [items, tab]);
  const urgent = items.some((n) => n.active && !n.read && n.severity === 'CRITICAL');

  const openOne = (n: AppNotification) => {
    if (!n.read) void markRead(n.id);
    setOpen(false);
    if (n.link) router.push(n.link);
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        className={`relative ${size} grid place-items-center rounded-xl border border-line bg-surface text-ink hover:border-blue/50`}
      >
        {unread ? <BellRing className={`size-5 ${urgent ? 'text-coral' : ''}`} /> : <Bell className="size-5" />}
        {unread > 0 && (
          <span className={`absolute -right-1.5 -top-1.5 min-w-5 rounded-full px-1.5 text-center text-[10px] font-bold leading-5 text-white ${urgent ? 'bg-coral' : 'bg-blue'}`}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 flex max-h-[min(78vh,640px)] w-[min(92vw,400px)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-ink/10">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div>
              <h2 className="text-[15px] font-bold text-ink">Notifications</h2>
              <p className="text-[11.5px] text-mute">{unread ? `${unread} unread` : 'You’re all caught up'}</p>
            </div>
            {unread > 0 && (
              <button type="button" onClick={() => void markAllRead()} className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-semibold text-blue hover:bg-blue/5">
                <CheckCheck className="size-4" /> Mark all read
              </button>
            )}
          </div>

          <div className="flex gap-1 px-4 pt-2" role="tablist">
            {(['all', 'unread'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-lg px-3 py-1 text-[12px] font-semibold ${tab === t ? 'bg-bg text-ink' : 'text-sub hover:text-ink'}`}
              >
                {t === 'all' ? 'All' : `Unread${unread ? ` (${unread})` : ''}`}
              </button>
            ))}
            {status === 'offline' && (
              <span className="ml-auto flex items-center gap-1 text-[11px] text-amber">
                <WifiOff className="size-3.5" /> Offline — last known
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {status === 'loading' && !items.length ? (
              <p className="px-3 py-8 text-center text-[12.5px] text-mute">Checking…</p>
            ) : !current.length && !earlier.length ? (
              <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
                <span className="grid size-11 place-items-center rounded-full bg-teal/10 text-teal">
                  <CheckCheck className="size-5" />
                </span>
                <p className="text-[13px] font-semibold text-ink">{tab === 'unread' ? 'No unread notifications' : 'Nothing needs your attention'}</p>
                <p className="text-[11.5px] text-mute">Stock, orders, drawers, payments and supplier dues show up here.</p>
              </div>
            ) : (
              <>
                {current.map((n) => (
                  <Row key={n.id} n={n} onOpen={openOne} />
                ))}
                {earlier.length > 0 && (
                  <>
                    <p className="px-3 pb-1 pt-3 text-[10.5px] font-bold uppercase tracking-wide text-mute">Earlier · sorted out</p>
                    {earlier.map((n) => (
                      <Row key={n.id} n={n} onOpen={openOne} />
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          {popups !== 'unsupported' && (
            <div className="flex items-center gap-2 border-t border-line bg-bg/60 px-4 py-2.5 text-[12px]">
              {popups === 'on' ? <BellRing className="size-4 text-teal" /> : <BellOff className="size-4 text-mute" />}
              <span className="min-w-0 flex-1 text-sub">
                {popups === 'on'
                  ? 'Desktop pop-ups are on'
                  : popups === 'blocked'
                    ? 'Pop-ups are blocked — allow notifications for this site in the browser'
                    : 'Get desktop pop-ups for new alerts'}
              </span>
              {popups !== 'blocked' && (
                <button
                  type="button"
                  onClick={() => void setPopups(popups !== 'on')}
                  className={`rounded-lg px-2.5 py-1 font-semibold ${popups === 'on' ? 'text-sub hover:text-ink' : 'gbv text-onbrand'}`}
                >
                  {popups === 'on' ? 'Turn off' : 'Turn on'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ n, onOpen }: { n: AppNotification; onOpen: (n: AppNotification) => void }) {
  const I = KIND_ICON[n.kind] ?? Bell;
  return (
    <button
      type="button"
      onClick={() => onOpen(n)}
      className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-bg ${n.active ? '' : 'opacity-60'}`}
    >
      <span className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl ${n.active ? TONE[n.severity] : 'bg-bg text-mute'}`}>
        <I className="size-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className={`text-[13px] leading-snug text-ink ${n.read || !n.active ? 'font-medium' : 'font-bold'}`}>{n.title}</span>
          {n.active && !n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-blue" aria-label="Unread" />}
        </span>
        <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-sub">{n.body}</span>
        <span className="mt-1 block text-[10.5px] text-mute">{ago(n.raisedAt)}</span>
      </span>
    </button>
  );
}
