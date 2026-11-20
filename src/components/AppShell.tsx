'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  BarChart3,
  Boxes,
  ChevronDown,
  ClipboardList,
  HandCoins,
  ClipboardCheck,
  Landmark,
  Building2,
  UserCog,
  LayoutDashboard,
  LogOut,
  Package,
  PackagePlus,
  Receipt,
  ScanBarcode,
  Sparkles,
  Store,
  TrendingUp,
  Truck,
  Users,
} from 'lucide-react';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { useNotifications } from '@/lib/notifications';
import { businessTypes, useBusinessProfile } from '@/lib/business-profile';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { roleLabel, signOut, useSession } from '@/lib/auth';
import { setCurrentBranch, stores, useBranches } from '@/lib/branch-data';
import { isLive, retryLoad } from '@/lib/live/session';
import { BrandLogo } from '@/components/brand/Brand';
import { StoreAvatar } from '@/components/brand/StoreAvatar';

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard; badge?: true };

/** The sidebar, in sections. The section holding the open page is always expanded. */
const navTop: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/assistant', label: 'AI Assistant', icon: Sparkles },
];
const navSections: { id: string; label: string; items: NavItem[] }[] = [
  {
    id: 'selling',
    label: 'Selling',
    items: [
      { href: '/sales', label: 'Sales', icon: TrendingUp },
      { href: '/orders', label: 'Customer orders', icon: Receipt },
      { href: '/customers', label: 'Customers', icon: Users },
      { href: '/end-of-day', label: 'End of day', icon: ClipboardCheck },
    ],
  },
  {
    id: 'stock',
    label: 'Stock',
    items: [
      { href: '/inventory', label: 'Inventory', icon: Boxes, badge: true },
      { href: '/stock-control', label: 'Stock control', icon: ClipboardList },
      { href: '/products', label: 'Products', icon: Package },
      { href: '/purchases', label: 'Purchases', icon: PackagePlus },
      { href: '/suppliers', label: 'Suppliers', icon: Truck },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      { href: '/reports', label: 'Reports', icon: BarChart3 },
      { href: '/gst-report', label: 'GST report', icon: Landmark },
      { href: '/expenses', label: 'Expenses', icon: HandCoins },
    ],
  },
  {
    id: 'setup',
    label: 'Setup',
    items: [
      { href: '/branches', label: 'Branches', icon: Building2 },
      { href: '/staff', label: 'Staff', icon: UserCog },
      { href: '/business-profile', label: 'Business profile', icon: Store },
    ],
  },
];

const COLLAPSED_KEY = 'billsynix:nav-collapsed';
/** Which sections the person folded away (per computer). */
function useCollapsed() {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
      if (Array.isArray(v)) setCollapsed(v.filter((x): x is string => typeof x === 'string'));
    } catch {
      /* storage unavailable: everything stays open */
    }
  }, []);
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = c.includes(id) ? c.filter((x) => x !== id) : [...c, id];
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  return [collapsed, toggle] as const;
}

/** Dashboard layout. Only signed-in owners and managers see it; cashiers are sent to the POS. */
export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <RequireAuth roles={['owner', 'manager']}>
      <Shell title={title}>{children}</Shell>
    </RequireAuth>
  );
}

function Shell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const session = useSession();
  const pathname = usePathname();
  const [q, setQ] = useState('');
  const [collapsed, toggleSection] = useCollapsed();
  const branchState = useBranches();
  const branchOptions = stores(branchState);
  // Inventory badge: current stock alerts (low, out, expiring) from the notifications.
  const { items: notes } = useNotifications();
  const stockAlerts = notes.filter((n) => n.active && n.kind.startsWith('stock.')).length;
  const profile = useBusinessProfile();
  const userName = session?.name ?? (profile.ownerName || 'Owner');
  const handleSignOut = () => {
    signOut();
    router.replace('/login');
  };

  const handleSearch = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    router.push(`/products?q=${encodeURIComponent(q)}`);
  };

  // The window never scrolls: the sidebar stays put and only the page area scrolls (quietly).
  return (
    <div className="flex h-dvh overflow-hidden text-[13px]">
      <aside className="w-[232px] shrink-0 bg-side text-onbrand/70 flex flex-col p-4 h-full">
        <Link href="/" className="flex items-center gap-2 px-2 py-1">
          <BrandLogo className="h-[60px]" />
        </Link>
        <div className="mt-5 rounded-xl bg-onbrand/5 border border-onbrand/10 px-3 py-2.5">
          <div className="text-[11px] text-onbrand/40">Store</div>
          <div className="truncate text-onbrand font-semibold">{profile.displayName}</div>
          <div className="truncate text-[11px] text-onbrand/40">{businessTypes[profile.businessType].label}</div>
        </div>
        {/* The POS is a separate full-screen page, not part of the dashboard layout. */}
        <Link
          href="/pos"
          className="mt-4 flex items-center gap-3 rounded-lg border border-onbrand/20 bg-onbrand/10 px-3 py-2.5 font-semibold text-onbrand hover:bg-onbrand/15"
        >
          <ScanBarcode className="size-[18px] shrink-0" strokeWidth={2} aria-hidden="true" />
          <span className="flex-1">POS &amp; Billing</span>
          <span className="text-[11px] text-onbrand/50">Open ↗</span>
        </Link>
        <nav className="quiet-scroll -mx-1 mt-4 min-h-0 flex-1 overflow-y-auto px-1 pb-2" aria-label="Main">
          <div className="space-y-0.5">
            {navTop.map((n) => (
              <NavLink key={n.href} n={n} active={pathname === n.href} alerts={stockAlerts} />
            ))}
          </div>
          {navSections.map((sec) => {
            const holdsPage = sec.items.some((n) => n.href === pathname);
            const open = holdsPage || !collapsed.includes(sec.id);
            return (
              <div key={sec.id} className="mt-3">
                <button
                  type="button"
                  onClick={() => !holdsPage && toggleSection(sec.id)}
                  aria-expanded={open}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-1 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-onbrand/35 ${holdsPage ? 'cursor-default' : 'hover:text-onbrand/60'}`}
                >
                  <span className="flex-1">{sec.label}</span>
                  {!open && sec.items.some((n) => n.badge) && stockAlerts > 0 && <span className="size-1.5 rounded-full bg-coral" aria-label="Stock alerts" />}
                  {!holdsPage && <ChevronDown className={`size-3.5 transition ${open ? '' : '-rotate-90'}`} aria-hidden="true" />}
                </button>
                {open && (
                  <div className="mt-0.5 space-y-0.5">
                    {sec.items.map((n) => (
                      <NavLink key={n.href} n={n} active={pathname === n.href} alerts={stockAlerts} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="mt-auto flex items-center gap-3 border-t border-onbrand/10 pt-4">
          <StoreAvatar className="size-9" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-onbrand font-semibold">{userName}</div>
            <div className="text-[11px] text-onbrand/40">{session ? roleLabel[session.role] : 'Owner'}</div>
          </div>
          <button
            onClick={handleSignOut}
            title="Sign out"
            aria-label="Sign out"
            className="grid size-8 place-items-center rounded-lg text-onbrand/50 hover:bg-onbrand/10 hover:text-onbrand"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>
      {/* Block (not flex) so the bar and the page keep their natural height and the area scrolls. */}
      <main className="quiet-scroll flex-1 min-w-0 h-full overflow-y-auto overflow-x-hidden">
        <header className="sticky top-0 z-20 bg-surface/90 backdrop-blur border-b border-line h-16 px-7 flex items-center gap-3">
          <div className="text-sub">
            <Link href="/">Home</Link> /{' '}
            <span className="text-ink font-semibold">{title}</span>
          </div>
          <form
            className="ml-6 flex-1 max-w-[320px]"
            onSubmit={handleSearch}
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search products, orders…"
              aria-label="Search"
              className="w-full h-10 rounded-xl bg-bg border border-line px-4 outline-none focus:border-blue"
            />
          </form>
          <div className="ml-auto" />
          {branchOptions.length > 1 && (
            <select
              value={branchState.currentId}
              onChange={(e) => {
                setCurrentBranch(e.target.value);
                // Connected: stock and prices are per branch — load the new branch's.
                if (isLive()) void retryLoad();
              }}
              aria-label="Branch"
              title="Branch this computer works at — the POS bills with its prices, stock and GSTIN"
              className="h-10 px-3 rounded-xl border border-line bg-surface"
            >
              {branchOptions.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <NotificationBell />
          <Link href="/business-profile" title={`${profile.displayName} — shop logo and profile`} className="rounded-full hover:ring-2 hover:ring-blue/40">
            <StoreAvatar className="size-10" />
          </Link>
        </header>
        {children}
      </main>
    </div>
  );
}

export function PageHead({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[26px] font-extrabold">{title}</h1>
        {sub && <p className="text-sub mt-1">{sub}</p>}
      </div>
      {/* Buttons keep their labels on one line; on a narrow window they wrap as whole buttons. */}
      <div className="flex flex-wrap justify-end gap-2 [&>*]:whitespace-nowrap">{children}</div>
    </section>
  );
}

export function downloadCsv(name: string, rows: (string | number)[][]) {
  const blob = new Blob(
    [
      rows
        .map((r) =>
          r
            .map((c) => `"${String(c).replace(/"/g, '""')}"`)
            .join(',')
        )
        .join('\n'),
    ],
    { type: 'text/csv' }
  );
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function NavLink({ n, active, alerts }: { n: NavItem; active: boolean; alerts: number }) {
  const Icon = n.icon;
  return (
    <Link
      href={n.href}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-onbrand/5 hover:text-onbrand ${active ? 'gbv text-onbrand font-semibold' : ''}`}
    >
      <Icon className={`size-[18px] shrink-0 ${active ? 'text-onbrand' : 'text-onbrand/50'}`} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
      <span className="flex-1">{n.label}</span>
      {n.badge && alerts > 0 && <span className="rounded-full bg-coral/20 px-2 text-[11px] text-coral">{alerts}</span>}
    </Link>
  );
}
