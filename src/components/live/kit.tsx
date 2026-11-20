'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { CloudOff, Loader2, Lock } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/* Small shared pieces for the connected-mode back-office screens. */

/** Fixed-width variant: add your own w-… class. */
export const fieldFixed = 'block h-10 rounded-xl border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-blue';
export const fieldCls = 'h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-blue';
export const labelCls = 'block text-xs font-semibold text-sub';

const tones = {
  primary: 'bg-blue text-onbrand hover:opacity-90',
  danger: 'bg-coral text-onbrand hover:opacity-90',
  good: 'bg-teal text-onbrand hover:opacity-90',
  ghost: 'border border-line bg-surface text-ink hover:bg-bg',
  quiet: 'text-sub hover:bg-bg hover:text-ink',
} as const;

export function Btn({
  tone = 'ghost',
  busy,
  size = 'md',
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof tones; busy?: boolean; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold transition disabled:opacity-50 ${
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm'
      } ${tones[tone]} ${className}`}
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Badge({ tone, children }: { tone: 'blue' | 'amber' | 'teal' | 'coral' | 'mute' | 'vio'; children: ReactNode }) {
  const cls = {
    blue: 'bg-blue/10 text-blue',
    amber: 'bg-amber/15 text-amber',
    teal: 'bg-teal/10 text-teal',
    coral: 'bg-coral/10 text-coral',
    vio: 'bg-vio/10 text-vio',
    mute: 'bg-bg text-sub',
  }[tone];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: [T, string][] }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line px-3 pt-3">
      {tabs.map(([k, label]) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          className={`-mb-px whitespace-nowrap border-b-2 px-3 pb-2.5 text-sm font-semibold ${value === k ? 'border-blue text-ink' : 'border-transparent text-sub hover:text-ink'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="px-4 py-14 text-center text-sm text-sub">{children}</div>;

export const Loading = () => (
  <div className="flex justify-center py-14 text-sub">
    <Loader2 className="size-5 animate-spin" aria-label="Loading" />
  </div>
);

export function ErrorLine({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="rounded-xl bg-coral/10 px-3 py-2 text-sm text-coral">{children}</p>;
}

export function Blocked({ kind, children }: { kind: 'offline' | 'denied'; children?: ReactNode }) {
  return (
    <section className="card grid place-items-center px-6 py-16 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-blue/10 text-blue">
        {kind === 'offline' ? <CloudOff className="size-6" /> : <Lock className="size-6" />}
      </span>
      <h2 className="mt-4 text-lg font-bold">{kind === 'offline' ? 'Connect to the server' : 'You don’t have access to this'}</h2>
      <p className="mt-1 max-w-md text-sm text-sub">
        {children ??
          (kind === 'offline'
            ? 'This is kept on the server. Set NEXT_PUBLIC_API_URL in .env.local and restart the app.'
            : 'Ask the owner to give your role the permission for it on the Staff page.')}
      </p>
    </section>
  );
}

export function Modal({
  open,
  onClose,
  title,
  sub,
  wide,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: string | undefined;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={`max-h-[90vh] overflow-y-auto ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}>
        <DialogHeader>
          <DialogTitle className="text-[18px] font-extrabold">{title}</DialogTitle>
          {sub && <DialogDescription className="text-sub">{sub}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export const dayFmt = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
export const whenFmt = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const inr2 = (v: string | number | null | undefined) =>
  `₹${Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
