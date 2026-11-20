'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Briefcase,
  Building2,
  Check,
  Crown,
  Globe,
  LogOut,
  Monitor,
  Package,
  ShoppingCart,
  Store,
  UserCheck,
  type LucideIcon,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Lock,
  Pencil,
  Power,
  Search,
  ShieldCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import { PageHead } from '@/components/AppShell';
import { Avatar, Panel, StatCard } from '@/components/suppliers/SuppliersView';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useNotice } from '@/components/live/Notice';
import { api, errorMessage } from '@/lib/api/client';
import { isLive, can, currentMe } from '@/lib/live/session';
import { useBranches } from '@/lib/branch-data';

type Member = {
  id: string;
  userId: string;
  name: string;
  email: string;
  status: 'ACTIVE' | 'DISABLED';
  roles: string[];
  storeIds: string[] | null;
  hasPin: boolean;
};
type Role = { id: string; key: string; name: string; tenantWide: boolean };

type Draft = {
  id?: string;
  name: string;
  email: string;
  password: string;
  role: string;
  storeIds: string[];
  pin: string;
  /** Editing only: remove the PIN. */
  clearPin: boolean;
};

const blank = (storeId: string): Draft => ({ name: '', email: '', password: '', role: 'cashier', storeIds: storeId ? [storeId] : [], pin: '', clearPin: false });

/** What each system role is for (the API's permission matrix, in a sentence). */
const ROLE_INFO: Record<string, { blurb: string; pill: string; icon: LucideIcon }> = {
  owner: { blurb: 'Everything, including the subscription.', pill: 'bg-vio/15 text-vio', icon: Crown },
  business_admin: { blurb: 'Runs the whole business: staff, branches, stock, purchases and reports.', pill: 'bg-blue/15 text-blue', icon: Briefcase },
  branch_manager: { blurb: 'Runs their branches: cashiers, prices, stock, purchases, refunds and drawers.', pill: 'bg-sky/15 text-sky', icon: Store },
  inventory_manager: { blurb: 'Products, stock, transfers, suppliers and goods receipts.', pill: 'bg-amber/15 text-amber', icon: Package },
  cashier: { blurb: 'Bills customers, takes returns and keeps their own drawer.', pill: 'bg-teal/15 text-teal', icon: ShoppingCart },
};
const roleInfo = (key: string) => ROLE_INFO[key] ?? { blurb: '', pill: 'bg-bg text-sub', icon: Users };

const filters = {
  all: { label: 'All', test: (m: Member) => m.status === 'ACTIVE' },
  managers: { label: 'Managers', test: (m: Member) => m.status === 'ACTIVE' && m.roles.some((r) => r !== 'cashier') },
  cashiers: { label: 'Cashiers', test: (m: Member) => m.status === 'ACTIVE' && m.roles.includes('cashier') },
  noPin: { label: 'No PIN', test: (m: Member) => m.status === 'ACTIVE' && m.roles.includes('cashier') && !m.hasPin },
  disabled: { label: 'Disabled', test: (m: Member) => m.status === 'DISABLED' },
} as const;
type FilterKey = keyof typeof filters;

const field = 'h-10 w-full rounded-xl border bg-surface px-3 text-[13.5px] text-ink outline-none focus:border-blue';

/**
 * Staff of the business (connected mode): who can sign in, with which role, at which branches,
 * and the counter PIN cashiers use on a registered POS computer. Branch managers may add and edit
 * cashiers of their own branches only — the API enforces that.
 */
export function StaffView() {
  const branchState = useBranches();
  const stores = branchState.branches.filter((b) => b.active);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [plan, setPlan] = useState<{ name: string; used: number; limit: number } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [branch, setBranch] = useState('');
  const [notice, notify] = useNotice();
  const manage = can('users:manage');
  const myUserId = currentMe()?.user.id;

  const load = useCallback(async () => {
    try {
      const [m, r] = [
        await api<{ data: Member[] }>('GET', '/memberships', { query: { pageSize: 200 } }),
        await api<{ data: Role[] }>('GET', '/roles'),
      ];
      setMembers(m.data);
      setRoles(r.data);
      // The plan's staff limit (best effort: not every role may read the subscription).
      try {
        const s = await api<{ plan: { name: string }; usage: { users: number }; limits: { users: number } }>('GET', '/subscription');
        setPlan({ name: s.plan.name, used: s.usage.users, limit: s.limits.users });
      } catch {
        setPlan(null);
      }
    } catch (e) {
      notify(errorMessage(e), true);
      setMembers([]);
    }
  }, [notify]);

  useEffect(() => {
    if (isLive() && manage) void load();
  }, [load, manage]);

  const roleName = useMemo(() => new Map(roles.map((r) => [r.key, r.name])), [roles]);
  const storeName = useMemo(() => new Map(stores.map((s) => [s.id, s.name])), [stores]);
  const draftRole = roles.find((r) => r.key === draft?.role);

  const all = members ?? [];
  const active = all.filter((m) => m.status === 'ACTIVE');
  const cashiers = active.filter((m) => m.roles.includes('cashier'));
  const noPin = cashiers.filter((m) => !m.hasPin);
  const managers = active.filter((m) => m.roles.some((r) => r !== 'cashier'));
  const counts = useMemo(
    () => Object.fromEntries((Object.keys(filters) as FilterKey[]).map((k) => [k, all.filter(filters[k].test).length])) as Record<FilterKey, number>,
    [all]
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter(filters[filter].test)
      .filter((m) => !branch || m.storeIds === null || m.storeIds.includes(branch))
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
      .sort((a, b) => Number(b.roles.includes('owner')) - Number(a.roles.includes('owner')) || a.name.localeCompare(b.name));
  }, [all, filter, branch, query]);

  const atLimit = !!plan && plan.used >= plan.limit;

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const storeIds = draftRole?.tenantWide ? [] : draft.storeIds;
      if (!draft.id) {
        await api('POST', '/memberships', {
          body: {
            name: draft.name.trim(),
            email: draft.email.trim(),
            ...(draft.password ? { password: draft.password } : {}),
            roleKeys: [draft.role],
            storeIds,
            ...(draft.pin ? { pin: draft.pin } : {}),
          },
        });
        notify(`${draft.name.trim()} added${draft.pin ? ' — they can sign in at the counter with their PIN' : ''}`);
      } else {
        await api('PATCH', `/memberships/${draft.id}`, {
          body: {
            roleKeys: [draft.role],
            storeIds,
            ...(draft.clearPin ? { pin: null } : draft.pin ? { pin: draft.pin } : {}),
          },
        });
        notify(`${draft.name} updated`);
      }
      setDraft(null);
      await load();
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (m: Member) => {
    const disable = m.status === 'ACTIVE';
    setBusy(true);
    try {
      await api('PATCH', `/memberships/${m.id}`, { body: { status: disable ? 'DISABLED' : 'ACTIVE' } });
      notify(`${m.name} ${disable ? 'disabled — signed out everywhere' : 'enabled'}`);
      setConfirm(null);
      await load();
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  };

  const edit = (m: Member) =>
    setDraft({ id: m.id, name: m.name, email: m.email, password: '', role: m.roles[0] ?? 'cashier', storeIds: m.storeIds ?? [], pin: '', clearPin: false });

  if (!isLive() || !manage)
    return (
      <div className="space-y-4 p-5 lg:p-6">
        <PageHead title="Staff" sub="Who can sign in and bill" />
        <div className="card flex items-start gap-3 p-5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-blue/10 text-blue">
            {isLive() ? <Lock className="size-5" /> : <Users className="size-5" />}
          </span>
          <div className="text-[13px]">
            <p className="font-bold text-ink">{isLive() ? 'Managed by owners, admins and branch managers' : 'Staff are set up in the first-run setup'}</p>
            <p className="mt-1 text-sub">
              {isLive()
                ? 'Ask one of them to add people, change roles or set counter PINs.'
                : 'Connect the app to the server (NEXT_PUBLIC_API_URL) to manage staff accounts, roles and counter PINs here.'}
            </p>
          </div>
        </div>
      </div>
    );

  /* ---------- form checks ---------- */
  const emailOk = /^\S+@\S+\.\S+$/.test(draft?.email.trim() ?? '');
  const pinOk = !draft?.pin || /^\d{4}$/.test(draft.pin);
  const passwordOk = !draft?.password || draft.password.length >= 10;
  const branchesOk = !!draftRole?.tenantWide || (draft?.storeIds.length ?? 0) > 0;
  const valid = !!draft && pinOk && branchesOk && (!!draft.id || (draft.name.trim().length >= 1 && emailOk && passwordOk));

  return (
    <div className="space-y-4 p-5 lg:p-6">
      <PageHead
        title="Staff"
        sub={members ? `${active.length} active · ${cashiers.length} cashier${cashiers.length === 1 ? '' : 's'} · cashiers sign in at the counter with their PIN` : 'Loading…'}
      >
        <button
          onClick={() => setDraft(blank(branchState.currentId))}
          disabled={atLimit}
          title={atLimit ? `Your ${plan?.name} plan allows ${plan?.limit} active staff` : undefined}
          className="flex h-10 items-center gap-1.5 rounded-xl gbv px-5 font-semibold text-onbrand shadow-lg shadow-blue/25 disabled:opacity-50"
        >
          <UserPlus className="size-4" /> Add staff
        </button>
      </PageHead>

      {!members ? (
        <div className="card flex items-center gap-2 p-6 text-sub">
          <LoaderCircle className="size-4 animate-spin" /> Loading staff…
        </div>
      ) : (
        <>
          {/* Summary */}
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Active staff"
              value={plan ? `${plan.used} / ${plan.limit}` : String(active.length)}
              foot={plan ? `${plan.name} plan${atLimit ? ' — limit reached, upgrade to add more' : ` · ${plan.limit - plan.used} more allowed`}` : `${all.length - active.length} disabled`}
              variant="brand"
            />
            <StatCard label="Cashiers" value={String(cashiers.length)} foot={`${cashiers.length - noPin.length} can sign in at the counter with a PIN`} />
            <StatCard
              label="Cashiers without a PIN"
              value={String(noPin.length)}
              foot={noPin.length ? noPin.map((m) => m.name).join(', ') : 'Every cashier has a PIN'}
              {...(noPin.length ? { variant: 'alert' as const } : {})}
            />
            <StatCard label="Managers & admins" value={String(managers.length)} foot={`${stores.length} branch${stores.length === 1 ? '' : 'es'}`} />
          </section>

          <section className="grid gap-3 lg:grid-cols-3">
            {/* People */}
            <Panel title="Team" sub="Owners first, then by name" className="lg:col-span-2">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <label className="relative min-w-[200px] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search name or email…"
                    aria-label="Search staff"
                    className="h-9 w-full rounded-xl border border-line bg-bg pl-9 pr-3 outline-none focus:border-blue"
                  />
                </label>
                {stores.length > 1 && (
                  <select
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    aria-label="Branch"
                    className="h-9 rounded-xl border border-line bg-surface px-2 text-[12.5px]"
                  >
                    <option value="">All branches</option>
                    {stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="mb-3 flex flex-wrap rounded-lg bg-bg p-0.5" role="tablist" aria-label="Show">
                {(Object.keys(filters) as FilterKey[]).map((k) => (
                  <button
                    key={k}
                    role="tab"
                    aria-selected={filter === k}
                    onClick={() => setFilter(k)}
                    className={`rounded-md px-3 py-1 text-[12px] ${filter === k ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-sub'}`}
                  >
                    {filters[k].label} <span className="tabular-nums text-mute">{counts[k]}</span>
                  </button>
                ))}
              </div>

              <ul className="divide-y divide-line">
                {visible.map((m) => {
                  const owner = m.roles.includes('owner');
                  const me = m.userId === myUserId;
                  const cashier = m.roles.includes('cashier');
                  const branches = m.storeIds === null ? null : m.storeIds.map((s) => storeName.get(s)).filter(Boolean);
                  return (
                    <li key={m.id} className={`flex flex-wrap items-center gap-4 py-4 ${m.status === 'DISABLED' ? 'opacity-60' : ''}`}>
                      <Avatar name={m.name} />
                      <div className="min-w-[220px] flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-ink">{m.name}</span>
                          {me && <span className="rounded-full bg-bg px-2 py-0.5 text-[10px] font-semibold text-sub">You</span>}
                          {m.roles.map((r) => (
                            <span key={r} className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${roleInfo(r).pill}`}>
                              {roleName.get(r) ?? r}
                            </span>
                          ))}
                          {m.status === 'DISABLED' && <span className="rounded-full bg-line px-2 py-0.5 text-[10px] font-semibold text-sub">Disabled</span>}
                        </div>
                        <div className="mt-0.5 truncate text-[12px] text-sub">{m.email}</div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="flex items-center gap-1 text-mute">
                            <Building2 className="size-3.5" />
                            {branches === null ? 'All branches' : branches.length ? branches.join(', ') : 'No branch'}
                          </span>
                          {cashier && (
                            <span
                              className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${m.hasPin ? 'bg-teal/15 text-teal' : 'bg-coral/10 text-coral'}`}
                            >
                              <KeyRound className="size-3" /> {m.hasPin ? 'PIN set' : 'No PIN'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-1.5">
                        {owner || me ? (
                          <span className="flex items-center gap-1 text-[11px] text-mute">
                            <Lock className="size-3.5" /> {owner ? 'Owner' : 'Your account'}
                          </span>
                        ) : (
                          <>
                            {cashier && !m.hasPin && m.status === 'ACTIVE' && (
                              <button onClick={() => edit(m)} className="flex h-8 items-center gap-1 rounded-lg gbv px-3 text-[12px] font-semibold text-onbrand">
                                <KeyRound className="size-3.5" /> Set PIN
                              </button>
                            )}
                            <button onClick={() => edit(m)} className="flex h-8 items-center gap-1 rounded-lg border border-line px-3 text-[12px] font-semibold text-ink hover:border-blue">
                              <Pencil className="size-3.5" /> Edit
                            </button>
                            <button
                              onClick={() => (m.status === 'ACTIVE' ? setConfirm(m) : void toggle(m))}
                              disabled={busy || (m.status === 'DISABLED' && atLimit)}
                              title={m.status === 'DISABLED' && atLimit ? 'The plan’s staff limit is reached' : undefined}
                              className={`flex h-8 items-center gap-1 rounded-lg border border-line px-3 text-[12px] font-semibold disabled:opacity-50 ${m.status === 'ACTIVE' ? 'text-sub hover:border-coral hover:text-coral' : 'text-teal hover:border-teal'}`}
                            >
                              <Power className="size-3.5" /> {m.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {visible.length === 0 && (
                <div className="py-10 text-center text-sub">
                  {all.length <= 1 && filter === 'all' && !query ? (
                    <>
                      It&apos;s just you so far.{' '}
                      <button className="font-semibold text-blue" onClick={() => setDraft(blank(branchState.currentId))}>
                        Add your first cashier
                      </button>
                    </>
                  ) : (
                    <>
                      No one matches.{' '}
                      <button
                        className="font-semibold text-blue"
                        onClick={() => {
                          setQuery('');
                          setFilter('all');
                          setBranch('');
                        }}
                      >
                        Clear filters
                      </button>
                    </>
                  )}
                </div>
              )}
            </Panel>

            {/* Help */}
            <div className="space-y-3">
              {/* Needs attention */}
              {noPin.length > 0 && (
                <section className="card overflow-hidden border-coral/30">
                  <div className="flex items-center gap-2.5 bg-coral/10 px-4 py-3">
                    <span className="grid size-8 place-items-center rounded-lg bg-coral/15 text-coral">
                      <AlertTriangle className="size-4" />
                    </span>
                    <div>
                      <h3 className="text-[13.5px] font-bold text-ink">
                        {noPin.length} cashier{noPin.length === 1 ? '' : 's'} can&apos;t sign in at the counter
                      </h3>
                      <p className="text-[11.5px] text-sub">Give them a PIN to use a registered POS computer.</p>
                    </div>
                  </div>
                  <ul className="divide-y divide-line px-4">
                    {noPin.slice(0, 5).map((m) => (
                      <li key={m.id} className="flex items-center gap-2.5 py-2.5">
                        <Avatar name={m.name} size="size-8" />
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">{m.name}</span>
                        <button onClick={() => edit(m)} className="flex h-7 items-center gap-1 rounded-lg gbv px-2.5 text-[11.5px] font-semibold text-onbrand">
                          <KeyRound className="size-3" /> Set PIN
                        </button>
                      </li>
                    ))}
                  </ul>
                  {noPin.length > 5 && (
                    <button onClick={() => setFilter('noPin')} className="w-full border-t border-line py-2 text-[12px] font-semibold text-blue">
                      Show all {noPin.length}
                    </button>
                  )}
                </section>
              )}

              {/* Roles */}
              <Panel title="Roles" sub="Tap one to see who has it">
                <ul className="space-y-1.5">
                  {roles.map((r) => {
                    const info = roleInfo(r.key);
                    const Icon = info.icon;
                    const n = active.filter((m) => m.roles.includes(r.key)).length;
                    const selectable = r.key !== 'owner';
                    return (
                      <li key={r.key}>
                        <button
                          disabled={!selectable}
                          onClick={() => {
                            setFilter(r.key === 'cashier' ? 'cashiers' : 'managers');
                            setQuery('');
                          }}
                          className="group flex w-full items-start gap-3 rounded-xl p-2.5 text-left transition hover:bg-bg disabled:cursor-default disabled:hover:bg-transparent"
                        >
                          <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${info.pill}`}>
                            <Icon className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <span className="text-[13px] font-bold text-ink">{r.name}</span>
                              <span className="rounded-full bg-bg px-2 py-0.5 text-[10.5px] font-semibold tabular-nums text-sub group-hover:bg-surface">
                                {n} {n === 1 ? 'person' : 'people'}
                              </span>
                            </span>
                            <span className="mt-0.5 block text-[11.5px] leading-snug text-sub">{info.blurb}</span>
                            <span className="mt-1 flex items-center gap-1 text-[10.5px] font-semibold text-mute">
                              {r.tenantWide || r.key === 'owner' ? (
                                <>
                                  <Globe className="size-3" /> Every branch
                                </>
                              ) : (
                                <>
                                  <Building2 className="size-3" /> Only their branches
                                </>
                              )}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Panel>

              {/* Counter sign-in */}
              <Panel title="Signing in at the counter" sub="How cashiers use their PIN">
                <ol className="relative space-y-4 text-[12.5px]">
                  <span aria-hidden className="absolute bottom-3 left-[15px] top-3 w-px bg-line" />
                  {[
                    {
                      icon: KeyRound,
                      title: 'Give them a PIN',
                      body: <>4 digits, set here with Edit or Set PIN. Tell it to them privately.</>,
                      done: cashiers.length > 0 && noPin.length === 0,
                    },
                    {
                      icon: Monitor,
                      title: 'Register the counter computer',
                      body: (
                        <>
                          Once per computer: <span className="font-semibold text-ink">POS → Settings → Offline billing → Register as counter</span>.
                        </>
                      ),
                    },
                    {
                      icon: UserCheck,
                      title: 'Pick name, enter PIN',
                      body: <>On that computer the cashier taps their name and types the PIN — no email or password.</>,
                    },
                  ].map((s, i) => (
                    <li key={s.title} className="relative flex gap-3">
                      <span
                        className={`relative z-10 grid size-8 shrink-0 place-items-center rounded-full border-2 ${s.done ? 'border-teal bg-teal text-onbrand' : 'border-blue/30 bg-surface text-blue'}`}
                      >
                        {s.done ? <Check className="size-4" /> : <s.icon className="size-3.5" />}
                      </span>
                      <div className="pt-1">
                        <p className="font-bold text-ink">
                          <span className="text-mute">{i + 1}.</span> {s.title}
                        </p>
                        <p className="mt-0.5 text-[11.5px] leading-snug text-sub">{s.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  <div className="flex items-start gap-2 rounded-xl bg-bg p-2.5 text-[11px] text-sub">
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-amber" />
                    <span>
                      <b className="text-ink">5 wrong PINs</b> lock it for 15 minutes.
                    </span>
                  </div>
                  <div className="flex items-start gap-2 rounded-xl bg-bg p-2.5 text-[11px] text-sub">
                    <LogOut className="mt-0.5 size-3.5 shrink-0 text-blue" />
                    <span>
                      <b className="text-ink">One counter at a time</b> — signing in elsewhere signs them out here.
                    </span>
                  </div>
                </div>
              </Panel>
            </div>
          </section>
        </>
      )}

      {/* Add / edit */}
      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto rounded-2xl border-line bg-surface text-ink sm:max-w-xl">
          <DialogHeader>
            <div className="flex items-center gap-3">
              {draft?.id ? <Avatar name={draft.name} size="size-11" /> : <span className="grid size-11 place-items-center rounded-xl bg-blue/10 text-blue"><UserPlus className="size-5" /></span>}
              <div>
                <DialogTitle className="text-[18px] font-extrabold">{draft?.id ? draft.name : 'Add staff'}</DialogTitle>
                <DialogDescription className="text-sub">
                  {draft?.id ? draft.email : 'They sign in with email and password; cashiers can also use a PIN at a registered counter.'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          {draft && (
            <StaffForm
              draft={draft}
              setDraft={setDraft}
              roles={roles}
              stores={stores}
              checks={{ emailOk, pinOk, passwordOk, branchesOk }}
              valid={valid}
              busy={busy}
              onCancel={() => setDraft(null)}
              onSave={() => void save()}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Disable */}
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="rounded-2xl border-line bg-surface text-ink sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[18px] font-extrabold">Disable {confirm?.name}?</DialogTitle>
            <DialogDescription className="text-sub">
              They are signed out at once — on every computer and counter — and can&apos;t sign in to this business. Their bills and history stay. You can enable them again later.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirm(null)} className="h-10 rounded-xl border border-line px-4 font-semibold text-ink hover:border-blue">
              Keep
            </button>
            <button
              disabled={busy}
              onClick={() => confirm && void toggle(confirm)}
              className="flex h-10 items-center gap-1.5 rounded-xl gco px-5 font-semibold text-onbrand disabled:opacity-50"
            >
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Power className="size-4" />} Disable
            </button>
          </div>
        </DialogContent>
      </Dialog>
      {notice}
    </div>
  );
}

/* ---------- add / edit form ---------- */

function StaffForm({
  draft,
  setDraft,
  roles,
  stores,
  checks,
  valid,
  busy,
  onCancel,
  onSave,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  roles: Role[];
  stores: { id: string; name: string }[];
  checks: { emailOk: boolean; pinOk: boolean; passwordOk: boolean; branchesOk: boolean };
  valid: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState(false);
  const role = roles.find((r) => r.key === draft.role);
  const isCashier = draft.role === 'cashier';
  const err = (ok: boolean) => (touched && !ok ? 'border-coral' : 'border-line');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (valid) onSave();
      }}
      className="space-y-5 text-[13px]"
    >
      {!draft.id && (
        <section className="space-y-3">
          <h3 className="text-[11px] font-bold uppercase tracking-wide text-mute">Account</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block font-semibold text-ink">Name</span>
              <input className={`${field} ${err(draft.name.trim().length > 0)}`} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={80} autoFocus />
            </label>
            <label className="block">
              <span className="mb-1 block font-semibold text-ink">Email</span>
              <input className={`${field} ${err(checks.emailOk)}`} type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
              {touched && !checks.emailOk && <span className="mt-1 block text-[11.5px] text-coral">Enter a valid email</span>}
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block font-semibold text-ink">Password</span>
            <span className="relative block">
              <input
                className={`${field} pr-10 ${err(checks.passwordOk)}`}
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={draft.password}
                onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-mute hover:text-ink"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </span>
            <span className={`mt-1 block text-[11.5px] ${touched && !checks.passwordOk ? 'text-coral' : 'text-mute'}`}>
              At least 10 characters. Leave empty if they already have an account with this email — they keep their password.
            </span>
          </label>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-mute">Role</h3>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Role">
          {roles
            .filter((r) => r.key !== 'owner')
            .map((r) => {
              const on = draft.role === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setDraft({ ...draft, role: r.key })}
                  className={`rounded-xl border-2 p-3 text-left transition ${on ? 'border-blue bg-blue/5' : 'border-line hover:border-blue/40'}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-bold text-ink">{r.name}</span>
                    {on && <Check className="size-4 text-blue" />}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-sub">{roleInfo(r.key).blurb}</span>
                </button>
              );
            })}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-mute">Branches</h3>
        {role?.tenantWide ? (
          <p className="rounded-xl bg-bg px-3 py-2 text-sub">{role.name} works across every branch.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {stores.map((s) => {
                const on = draft.storeIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setDraft({ ...draft, storeIds: on ? draft.storeIds.filter((x) => x !== s.id) : [...draft.storeIds, s.id] })}
                    className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold ${on ? 'gbv border-transparent text-onbrand' : 'border-line text-sub hover:text-ink'}`}
                  >
                    {on && <Check className="size-3.5" />} {s.name}
                  </button>
                );
              })}
            </div>
            {touched && !checks.branchesOk && <span className="block text-[11.5px] text-coral">Choose at least one branch</span>}
          </>
        )}
      </section>

      <section className="space-y-2 rounded-xl border border-line p-3">
        <h3 className="flex items-center gap-1.5 font-bold text-ink">
          <KeyRound className="size-4 text-blue" /> Counter PIN
          <span className="font-normal text-mute">{draft.id ? '— leave empty to keep' : isCashier ? '— recommended' : '— optional'}</span>
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${field} max-w-[180px] text-center font-mono tracking-[0.4em] ${err(checks.pinOk)}`}
            inputMode="numeric"
            maxLength={4}
            value={draft.pin}
            disabled={draft.clearPin}
            onChange={(e) => setDraft({ ...draft, pin: e.target.value.replace(/\D/g, '') })}
            placeholder="••••"
            aria-label="Counter PIN"
          />
          <button
            type="button"
            disabled={draft.clearPin}
            onClick={() => setDraft({ ...draft, pin: String(Math.floor(1000 + Math.random() * 9000)) })}
            className="h-10 rounded-xl border border-line px-3 font-semibold text-ink hover:border-blue disabled:opacity-50"
          >
            Suggest one
          </button>
        </div>
        <p className={`text-[11.5px] ${touched && !checks.pinOk ? 'text-coral' : 'text-mute'}`}>
          Exactly 4 digits, used with their name on a registered counter computer. Tell it to them privately.
        </p>
        {draft.id && (
          <label className="flex items-center gap-2 text-[12px] text-sub">
            <input type="checkbox" checked={draft.clearPin} onChange={(e) => setDraft({ ...draft, clearPin: e.target.checked, pin: '' })} /> Remove their PIN
          </label>
        )}
      </section>

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <button type="button" onClick={onCancel} className="h-10 rounded-xl border border-line px-4 font-semibold text-ink hover:border-blue">
          Cancel
        </button>
        <button type="submit" disabled={busy} className="flex h-10 items-center gap-1.5 rounded-xl gbv px-5 font-semibold text-onbrand disabled:opacity-50">
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : draft.id ? <Check className="size-4" /> : <UserPlus className="size-4" />}
          {draft.id ? 'Save changes' : 'Add to team'}
        </button>
      </div>
    </form>
  );
}
