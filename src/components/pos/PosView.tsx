'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  Ban,
  Wallet,
  Banknote,
  Camera,
  Check,
  CircleCheck,
  CirclePause,
  CircleQuestionMark,
  UsersRound,
  Cookie,
  Croissant,
  CreditCard,
  CupSoda,
  Info,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  Milk,
  Minus,
  Package,
  Percent,
  Plus,
  Printer,
  QrCode,
  ReceiptText,
  Scale,
  ScanBarcode,
  Search,
  Settings,
  SprayCan,
  Tag,
  Trash2,
  TriangleAlert,
  Undo2,
  UserRound,
  Wheat,
  X,
  Zap,
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PaymentPanel } from '@/components/pos/PaymentPanel';
import { PrintArea, Receipt } from '@/components/pos/Receipt';
import { useBarcodeScanner } from '@/components/pos/useBarcodeScanner';
import {
  CameraScanner,
  CustomerPanel,
  DiscountPanel,
  HeldPanel,
  OpenItemPanel,
  ReturnsPanel,
  SettingsPanel,
  cameraScanSupported,
  type HeldBill,
} from '@/components/pos/PosPanels';
import { categoryColor } from '@/lib/category-tones';
import { findByCode, posCatalog, rankItems, type PosItem } from '@/lib/pos/catalog';
import {
  FIRST_POS_SEQ,
  buildCreditLines,
  computeBill,
  creditNoteNo,
  discountAmount,
  invoiceNo,
  isInterState,
  money,
  r2,
  refundFor,
  registerInvoices,
  slabsOf,
  type BillRow,
  type Buyer,
  type CartLine,
  type CreditNote,
  type Discount,
  type Invoice,
  type PayMethod,
  type Payment,
  type PosDocument,
} from '@/lib/pos/billing';
import { printEscPos, toEscPos } from '@/lib/pos/escpos';
import { expiryDate, expiryLabel, expiryTone, fmtExpiry, initialBatches, isExpired, type Batch } from '@/lib/pos/expiry';
import { defaultSettings, initialSettings, loadLocal, saveLocal, type PosSettings } from '@/lib/pos/store';
import { chargesGst, profileStateCode, registrationInfo, useBusinessProfile } from '@/lib/business-profile';
import { roleLabel, signOut, useSession } from '@/lib/auth';
import { useSetup } from '@/lib/setup';
import { isLive } from '@/lib/live/session';
import { returnLive, saleIdForInvoice, sellLive } from '@/lib/live/actions';
import { voidSale } from '@/lib/live/shift';
import { CancelBillForm } from '@/components/live/CancelBillForm';
import { CloseDrawerPanel } from '@/components/live/CloseDrawerPanel';
import { loadOrderForBilling } from '@/lib/live/customers';
import { SyncChip, SyncPanel } from './OfflinePanels';
import { errorMessage } from '@/lib/api/client';
import { adjustStock, currentBranch, listedAt, priceAt, profileForBranch, stockAt, useBranches } from '@/lib/branch-data';
import { useRouter } from 'next/navigation';
import { dialable, initialCustomers, tierOf } from '@/lib/customers-data';
import { BrandBadge } from '@/components/brand/Brand';
import { NotificationBell } from '@/components/notifications/NotificationBell';

/** Cashiers can give up to this much off a line or bill without a manager. */
const MAX_CASHIER_DISCOUNT_PCT = 20;
const MAX_SAVED_DOCS = 200;
/** Stock at or below this shows as "low" in search results. */
const LOW_STOCK = 15;
/** Search results shown in the dropdown; typing more narrows the rest. */
const MAX_RESULTS = 10;

type Modal =
  | { kind: 'pay'; method: PayMethod }
  | { kind: 'customer' | 'held' | 'returns' | 'settings' | 'bill-discount' | 'open-item' | 'camera' | 'help' | 'sync' | 'drawer' }
  | { kind: 'void'; inv: Invoice }
  | { kind: 'line-discount'; key: string }
  | { kind: 'done'; doc: PosDocument };

type Patch = Partial<Pick<Invoice, 'returned' | 'refunded' | 'cancelled'>>;
type Draft = {
  lines: CartLine[];
  billDiscount: Discount;
  buyer: Buyer | null;
  /** Connected: the delivery / pickup order this bill is for (opened from the Orders screen). */
  order?: { id: string; number: string } | null;
};

type Session = {
  docs: PosDocument[];
  held: HeldBill[];
  seq: number;
  cnSeq: number;
  patched: Record<string, Patch>;
  draft: Draft;
};

const emptyDraft: Draft = { lines: [], billDiscount: null, buyer: null };
const emptySession: Session = { docs: [], held: [], seq: FIRST_POS_SEQ, cnSeq: 1, patched: {}, draft: emptyDraft };

type Toast = { id: number; text: string; tone: 'ok' | 'bad' | 'info'; action?: { label: string; run: () => void } };

type IconType = ComponentType<{ className?: string | undefined }>;

const categoryIcon: Record<string, IconType> = {
  Grocery: Wheat,
  Dairy: Milk,
  Beverages: CupSoda,
  Snacks: Cookie,
  Household: SprayCan,
  Bakery: Croissant,
};
const CatIcon = ({ category, className }: { category: string; className?: string | undefined }) => {
  const I = categoryIcon[category] ?? Package;
  return <I className={className} />;
};

const methodIcon: Record<PayMethod, IconType> = { Cash: Banknote, UPI: QrCode, Card: CreditCard };

/** Column layout shared by the items table header and its rows. */
const COLS =
  'grid grid-cols-[minmax(0,1fr)_100px_80px_28px] items-center gap-2 @sm:grid-cols-[minmax(0,1fr)_104px_40px_84px_28px] @2xl:grid-cols-[28px_minmax(0,1fr)_76px_112px_72px_96px_28px] @2xl:gap-3';

/* ---------- small helpers ---------- */

let audio: AudioContext | null = null;
/** Short high beep for a good scan, low buzz for an unknown code. */
function beep(ok: boolean) {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = ok ? 1250 : 280;
    g.gain.value = 0.04;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.06 : 0.25));
  } catch {
    /* audio blocked — scanning still works */
  }
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

const shareText = (inv: Invoice, storeName: string) =>
  [
    `*${storeName}* — Bill ${inv.no}`,
    ...inv.totals.rows.map((r) => `${r.name} × ${r.qty} = ${money(r.final)}`),
    inv.totals.discountTotal > 0 ? `You saved ${money(inv.totals.discountTotal)}` : '',
    inv.billOfSupply ? `*Total ${money(inv.totals.payable)}*` : `*Total ${money(inv.totals.payable)}* (incl. GST ${money(inv.totals.taxTotal)})`,
    `Paid by ${inv.payments.map((p) => p.method).join(' + ')}. Thank you!`,
  ]
    .filter(Boolean)
    .join('\n');

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

const short = (n: number) => money(n).replace('.00', '');

/** "3*atta" / "3x8901234…" → { qty: 3, text: 'atta' }. */
const parseQtyPrefix = (q: string) => {
  const m = q.match(/^\s*(\d+(?:\.\d+)?)\s*[*x×]\s*(.+)$/i);
  return m ? { qty: Number(m[1]), text: m[2]!, hasQty: true } : { qty: 1, text: q, hasQty: false };
};

function Kbd({ children, onDark }: { children: string; onDark?: boolean }) {
  return (
    <kbd
      className={`hidden rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold sm:inline ${
        onDark ? 'bg-onbrand/20 text-onbrand' : 'border border-line bg-bg text-sub'
      }`}
    >
      {children}
    </kbd>
  );
}

/** One function key on the bottom bar: the key, then what it does. */
function FnKey({ k, label, short, onClick, count, tone }: { k: string; label: string; short?: string; onClick: () => void; count?: number; tone?: 'coral' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label} (${k})`}
      className={`flex h-9 min-w-0 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[11.5px] font-semibold transition hover:bg-bg xl:gap-1.5 xl:px-2 xl:text-[12px] ${tone === 'coral' ? 'text-coral' : 'text-ink'}`}
    >
      <kbd className="shrink-0 rounded-md border border-line bg-bg px-1 py-0.5 font-mono text-[10px] font-bold text-sub xl:px-1.5 xl:text-[10.5px]">{k}</kbd>
      {/* Narrow windows: the short name, so every key still fits on one line. */}
      <span className="whitespace-nowrap xl:hidden">{short ?? label}</span>
      <span className="hidden whitespace-nowrap xl:inline">{label}</span>
      {!!count && <span className="grid min-w-5 shrink-0 place-items-center rounded-full bg-amber px-1 text-[10px] font-bold text-onbrand">{count}</span>}
    </button>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="relative grid size-9 place-items-center rounded-xl border border-line/70 bg-surface text-sub shadow-sm transition hover:border-blue/50 hover:text-ink"
    >
      {children}
    </button>
  );
}

function SummaryRow({ label, value, tone, children }: { label: ReactNode; value: string; tone?: 'teal' | 'sub'; children?: ReactNode }) {
  return (
    <div className={`flex items-center justify-between gap-2 ${tone === 'teal' ? 'text-teal' : 'text-sub'}`}>
      <span className="flex min-w-0 items-center gap-1.5">
        {label}
        {children}
      </span>
      <span className="shrink-0 tabular-nums">{value}</span>
    </div>
  );
}

/* ---------- search dropdown rows ---------- */

/** One pickable row in the dropdown: a product's regular stock, or one of its near-expiry batches. */
type Option =
  | { kind: 'fresh'; key: string; item: PosItem; available: number; clearancePct: number | null }
  | { kind: 'batch'; key: string; item: PosItem; batch: Batch; available: number };

const lineKeyFor = (sku: string, batch?: Pick<Batch, 'id'> | null) => (batch ? `${sku}@${batch.id}` : sku);

/** A new bill line; near-expiry batches carry their markdown as the line discount. */
const makeLine = (item: PosItem, qty: number, batch: Batch | null): CartLine => ({
  key: lineKeyFor(item.sku, batch),
  sku: item.sku,
  name: item.name,
  hsn: item.hsn,
  gst: item.gst,
  price: item.price,
  qty,
  discount: batch?.pct ? { kind: 'pct', value: batch.pct } : null,
  ...(batch ? { batch: { id: batch.id, expiresOn: expiryDate(batch.days).toISOString(), pct: batch.pct ?? 0 } } : {}),
});

const tonePill: Record<'coral' | 'amber' | 'sky', string> = {
  coral: 'bg-coral/15 text-coral',
  amber: 'bg-amber/15 text-amber',
  sky: 'bg-sky/15 text-sky',
};

const optionGrid =
  'grid w-full grid-cols-[28px_minmax(0,1fr)_auto_auto] items-center gap-3 px-3 text-left sm:grid-cols-[28px_minmax(0,1fr)_96px_92px_72px]';

function OptionRow({
  o,
  inCart,
  active,
  showGst,
  onPick,
  onHover,
}: {
  o: Option;
  inCart: number;
  active: boolean;
  /** False on a bill of supply (composition / unregistered store). */
  showGst: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const p = o.item;
  const left = o.available - inCart;
  // mousedown (not click) so the search box keeps focus and the dropdown doesn't close first
  const handlers = {
    onMouseDown: (e: ReactMouseEvent) => {
      e.preventDefault();
      onPick();
    },
    onMouseEnter: onHover,
  };

  if (o.kind === 'fresh') {
    const tone = left <= 0 ? 'text-coral' : left <= LOW_STOCK ? 'text-amber' : 'text-mute';
    return (
      <li role="option" aria-selected={active}>
        <button {...handlers} className={`${optionGrid} h-11 ${active ? 'bg-blue/10' : 'hover:bg-bg'}`}>
          <span
            className="grid size-7 place-items-center rounded-lg"
            style={{ background: `color-mix(in oklch, ${categoryColor(p.category)} 14%, transparent)`, color: categoryColor(p.category) }}
          >
            <CatIcon category={p.category} className="size-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold text-ink">{p.name}</span>
            <span className="block truncate text-[11px] text-mute">
              {o.clearancePct !== null ? 'Regular stock' : p.sku}
              {showGst && ` · GST ${p.gst}%`}
              {inCart > 0 && <span className="font-semibold text-blue"> · {inCart} on bill</span>}
            </span>
          </span>
          <span className={`hidden text-right text-[11px] font-semibold sm:block ${tone}`}>
            {left <= 0 ? (inCart > 0 ? 'None left' : 'Out of stock') : `${left} in stock`}
          </span>
          <span className="text-right font-bold tabular-nums text-ink">{short(p.price)}</span>
          <span className="hidden justify-end sm:flex">{active ? <Kbd>Enter</Kbd> : <Plus className="size-4 text-mute" />}</span>
        </button>
      </li>
    );
  }

  const b = o.batch;
  const expired = isExpired(b);
  const pct = b.pct ?? 0;
  const tone = expired ? 'coral' : expiryTone(b.days);
  return (
    <li role="option" aria-selected={active} aria-disabled={expired}>
      <button
        {...handlers}
        className={`${optionGrid} h-12 ${expired ? 'bg-coral/[0.04]' : active ? 'bg-amber/15' : 'bg-amber/[0.06] hover:bg-amber/10'}`}
      >
        <span className={`ml-2 grid size-6 place-items-center rounded-md ${tonePill[tone]}`}>
          {expired ? <Ban className="size-3.5" /> : <Tag className="size-3.5" />}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-semibold text-ink">{p.name}</span>
            <span className={`shrink-0 rounded-full px-1.5 text-[10px] font-bold ${tonePill[tone]}`}>
              {expired ? 'Do not sell' : 'Near expiry'}
            </span>
          </span>
          <span className="block truncate text-[11px] text-mute">
            <span className={`font-semibold ${tone === 'coral' ? 'text-coral' : tone === 'amber' ? 'text-amber' : 'text-sky'}`}>
              {expiryLabel(b.days)}
            </span>{' '}
            ({fmtExpiry(expiryDate(b.days))}) · Batch {b.id}
            {inCart > 0 && <span className="font-semibold text-blue"> · {inCart} on bill</span>}
          </span>
        </span>
        <span className={`hidden text-right text-[11px] font-semibold sm:block ${left <= 0 ? 'text-coral' : 'text-mute'}`}>
          {left <= 0 ? 'None left' : `${left} in batch`}
        </span>
        <span className="text-right leading-tight">
          {expired ? (
            <span className="font-bold text-coral">—</span>
          ) : (
            <>
              <span className="block font-extrabold tabular-nums text-teal">{money(r2(p.price * (1 - pct / 100))).replace('.00', '')}</span>
              <span className="block text-[11px] tabular-nums text-mute line-through">{short(p.price)}</span>
            </>
          )}
        </span>
        <span className="hidden justify-end sm:flex">
          {active && !expired ? (
            <Kbd>Enter</Kbd>
          ) : (
            !expired && <span className="rounded-md bg-teal px-1.5 py-0.5 text-[11px] font-extrabold text-onbrand">−{pct}%</span>
          )}
        </span>
      </button>
    </li>
  );
}

/* ---------- help ---------- */

const shortcuts: [string, string][] = [
  ['F2', 'Jump to search / scan box'],
  ['Enter', 'Add the highlighted result (or a scanned code)'],
  ['↑ ↓', 'Move through results — or through bill lines when search is empty'],
  ['3*milk', 'Add a quantity in one go'],
  ['+  /  −', 'Change quantity of the selected line'],
  ['Del', 'Remove the selected line'],
  ['Esc', 'Close the results / clear the search'],
  ['F3', 'Attach a customer / GST details'],
  ['F10', 'Discount on the whole bill'],
  ['F8', 'Hold this bill and start another'],
  ['F9', 'Find a bill: reprint or return'],
  ['F5', 'Pay by cash'],
  ['F4', 'Held bills: resume one'],
  ['F1  or  ?', 'Show this help'],
  ['Alt + D', 'Close drawer (end of shift)'],
  ['Alt + S', 'POS settings'],
  ['Alt + M', 'Back to the dashboard (managers)'],
  ['Alt + L', 'Sign out'],
  ['F6', 'Pay by UPI'],
  ['F7', 'Pay by card'],
];

function HelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="space-y-4 text-[13px]">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { icon: ScanBarcode, title: 'Scan', body: 'Point a USB or Bluetooth scanner at any barcode — no need to click first.' },
          { icon: Search, title: 'Or search', body: 'Type a few letters; matches drop down. Near-expiry batches show under their item with the markdown. Arrow keys pick, Enter adds.' },
          { icon: Zap, title: 'Pay fast', body: 'F5 cash, F6 UPI, F7 card. Enter confirms. The next bill starts automatically.' },
        ].map(({ icon: I, title, body }) => (
          <div key={title} className="rounded-xl bg-bg p-3">
            <I className="size-5 text-blue" />
            <div className="mt-2 font-bold text-ink">{title}</div>
            <div className="mt-0.5 text-[12px] text-sub">{body}</div>
          </div>
        ))}
      </div>
      <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {shortcuts.map(([k, v]) => (
          <li key={k} className="flex items-center justify-between gap-3 border-b border-line py-1.5">
            <span className="text-sub">{v}</span>
            <kbd className="shrink-0 rounded-md border border-line bg-bg px-2 py-0.5 font-mono text-[11px] font-semibold text-ink">{k}</kbd>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <button onClick={onClose} className="h-10 rounded-xl gbv px-5 font-semibold text-onbrand">
          Got it
        </button>
      </div>
    </div>
  );
}

/* ---------- main view ---------- */

export function PosView() {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<PosSettings>(defaultSettings);
  const [session, setSession] = useState<Session>(emptySession);
  /** Units left in each near-expiry batch (by batch id). */
  const [batchStock, setBatchStock] = useState<Record<string, number>>(() => Object.fromEntries(initialBatches.map((b) => [b.id, b.qty])));
  const [query, setQuery] = useState('');
  /** Dropdown lists every near-expiry batch (opened from the Clearance button). */
  const [clearanceMode, setClearanceMode] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ key: string; n: number } | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [printDoc, setPrintDoc] = useState<PosDocument | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [clock, setClock] = useState<Date | null>(null);
  const [tipsDismissed, setTipsDismissed] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef(0);

  const { lines, billDiscount, buyer } = session.draft;
  /** Store identity, GST registration and enabled features (Business profile screen). */
  const baseProfile = useBusinessProfile();
  /** The branch this computer bills at: its prices, stock, address and GSTIN (Branches screen). */
  const branchState = useBranches();
  const branch = currentBranch(branchState);
  const multiBranch = branchState.branches.length > 1;
  const profile = useMemo(() => profileForBranch(baseProfile, branch), [baseProfile, branch]);
  const stock = branchState.stock[branch.id] ?? {};
  const router = useRouter();
  /** The signed-in person; bills are recorded under their name (and a cashier's own counter). */
  const user = useSession();
  const setup = useSetup();
  const cashierName = user?.name ?? settings.cashier;
  const counterName = user?.counter ?? settings.counter;
  const canManage = user?.role === 'owner' || user?.role === 'manager';

  const signOutHere = () => {
    if (lines.length && !window.confirm('Sign out? The bill on screen stays saved on this counter for the next sign-in.')) return;
    signOut();
    router.replace('/login?next=/pos');
  };

  /* load + save per-counter state (browser storage; safe to lose) */
  useEffect(() => {
    setSettings(loadLocal('settings', initialSettings()));
    setSession(loadLocal('session', emptySession));
    setTipsDismissed(loadLocal('ui', { tipsDismissed: false }).tipsDismissed);
    setReady(true);
    setClock(new Date());
    const t = window.setInterval(() => setClock(new Date()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (ready) saveLocal('session', { ...session, docs: session.docs.slice(0, MAX_SAVED_DOCS) });
  }, [session, ready]);

  const notify = useCallback((text: string, tone: Toast['tone'] = 'ok', action?: Toast['action']) => {
    setToast({ id: Date.now(), text, tone, ...(action ? { action } : {}) });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), action ? 5000 : 2600);
  }, []);

  const setDraft = (fn: (d: Draft) => Draft) => setSession((s) => ({ ...s, draft: fn(s.draft) }));
  const setLines = (fn: (l: CartLine[]) => CartLine[]) => setDraft((d) => ({ ...d, lines: fn(d.lines) }));
  /** Restores an earlier version of the bill (for Undo). */
  const restore = (d: Draft) => setDraft(() => d);

  /* derived */
  const catalog = useMemo(
    () =>
      posCatalog
        .filter((p) => listedAt(branchState, branch.id, p.sku))
        .map((p) => ({ ...p, price: priceAt(branchState, branch.id, p.sku) || p.price, stock: stockAt(branchState, branch.id, p.sku) })),
    [branchState, branch.id]
  );
  const parsed = parseQtyPrefix(query);
  const allResults = useMemo(() => (parsed.text.trim() ? rankItems(catalog, parsed.text) : []), [catalog, parsed.text]);
  const results = allResults.slice(0, MAX_RESULTS);
  /** Near-expiry batches still on the shelf, per product, soonest expiry first. */
  const batchesBySku = useMemo(() => {
    const m = new Map<string, Batch[]>();
    // "Batch & expiry" can be switched off in the Business profile.
    for (const b of profile.modules.expiry ? initialBatches : []) {
      const qty = batchStock[b.id] ?? 0;
      if (qty > 0) m.set(b.sku, [...(m.get(b.sku) ?? []), { ...b, qty }].sort((x, y) => x.days - y.days));
    }
    return m;
  }, [batchStock, profile.modules.expiry]);
  /** Regular (not near-expiry) units of a product. */
  const freshQty = useCallback(
    (p: PosItem) => Math.max(0, p.stock - (batchesBySku.get(p.sku) ?? []).reduce((s, b) => s + b.qty, 0)),
    [batchesBySku]
  );
  const optionsFor = (p: PosItem): Option[] => {
    const bs = batchesBySku.get(p.sku) ?? [];
    const sellable = bs.filter((b) => !isExpired(b));
    const fresh = freshQty(p);
    const out: Option[] = [];
    if (!bs.length || fresh > 0)
      out.push({
        kind: 'fresh',
        key: p.sku,
        item: p,
        available: bs.length ? fresh : p.stock,
        clearancePct: sellable.length ? Math.max(...sellable.map((b) => b.pct ?? 0)) : null,
      });
    for (const b of bs) out.push({ kind: 'batch', key: lineKeyFor(p.sku, b), item: p, batch: b, available: b.qty });
    return out;
  };
  const clearanceOptions = useMemo<Option[]>(
    () =>
      [...batchesBySku.values()]
        .flat()
        .sort((a, b) => a.days - b.days)
        .flatMap((b) => {
          const item = catalog.find((p) => p.sku === b.sku);
          return item ? [{ kind: 'batch' as const, key: lineKeyFor(b.sku, b), item, batch: b, available: b.qty }] : [];
        }),
    [batchesBySku, catalog]
  );
  const sellableClearance = clearanceOptions.filter((o) => o.kind === 'batch' && !isExpired(o.batch)).length;
  const browsingClearance = clearanceMode && !query.trim();
  const options: Option[] = browsingClearance ? clearanceOptions : results.flatMap(optionsFor);
  const showResults = searchFocused && !modal && (!!query.trim() || clearanceMode);
  const qtyOnLine = (key: string) => lines.find((l) => l.key === key)?.qty ?? 0;
  const gst = chargesGst(profile);
  const interState = gst && isInterState(profileStateCode(profile), buyer);
  // Composition / unregistered stores issue a Bill of Supply: same prices, no GST charged.
  const totals = useMemo(
    () => computeBill(gst ? lines : lines.map((l) => ({ ...l, gst: 0 as const })), billDiscount, interState),
    [lines, billDiscount, interState, gst]
  );
  // Connected: the server gives the bill its number (per counter series) when it is paid.
  const nextNo = isLive() ? 'New bill' : invoiceNo(profile.invoicePrefix, clock ?? new Date(0), session.seq);
  const allInvoices = useMemo(() => {
    const mine = session.docs.filter((d): d is Invoice => d.kind === 'invoice');
    // The Sales page's sample bills are only lookup-able in demo mode, never on a real store.
    return [...mine, ...(setup?.mode === 'demo' ? registerInvoices : [])].map((i) => {
      const p = session.patched[i.no];
      return p ? { ...i, ...p } : i;
    });
  }, [session.docs, session.patched, setup?.mode]);
  // Loyalty tier / points show only when the Loyalty feature is on.
  const savedCustomer =
    profile.modules.loyalty && buyer?.customerId ? initialCustomers.find((c) => c.id === buyer.customerId) : undefined;
  const todaysSales = session.docs.filter(
    (d): d is Invoice =>
      d.kind === 'invoice' && !session.patched[d.no]?.cancelled && !!clock && new Date(d.issuedAt).toDateString() === clock.toDateString()
  );
  const rowOf = (key: string): BillRow | undefined => totals.rows.find((r) => r.key === key);

  // Connected: "Bill at POS" on the Orders screen opens /pos?order=<id> — its items and customer
  // come onto this bill, and completing it marks the order billed and paid.
  useEffect(() => {
    if (!ready || !isLive()) return;
    const id = new URLSearchParams(window.location.search).get('order');
    if (!id) return;
    router.replace('/pos');
    void (async () => {
      try {
        const o = await loadOrderForBilling(id);
        if (o.billed) return notify(`${o.number} is already billed (${o.billed}).`, 'bad');
        if (!o.open) return notify(`${o.number} is closed — it can't be billed.`, 'bad');
        if (session.draft.lines.length) return notify('Finish or hold the bill on screen first, then open the order again.', 'bad');
        const next: CartLine[] = [];
        const missing: string[] = [];
        for (const it of o.items) {
          const item = catalog.find((p) => p.sku === it.sku);
          if (item) next.push(makeLine(item, it.qty, null));
          else missing.push(it.name);
        }
        if (o.deliveryFee > 0) {
          const fee = catalog.find((p) => /^delivery/i.test(p.name));
          if (fee) next.push({ ...makeLine(fee, 1, null), price: o.deliveryFee });
          else missing.push(`the ₹${o.deliveryFee} delivery fee (add a "Delivery charge" product to bill it)`);
        }
        setDraft(() => ({
          lines: next,
          billDiscount: null,
          buyer: { customerId: o.customerId, name: o.customer, phone: o.phone, gstin: '' },
          order: { id: o.serverId, number: o.number },
        }));
        notify(
          missing.length ? `${o.number} loaded. Not on the bill: ${missing.join(', ')}.` : `${o.number} loaded — check the items and take payment.`,
          missing.length ? 'bad' : 'ok'
        );
      } catch (e) {
        notify(errorMessage(e), 'bad');
      }
    })();
    // Only once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => setHighlight(0), [query, clearanceMode]);
  useEffect(() => {
    if (flash) document.getElementById(`line-${flash.key}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [flash]);

  /* cart actions */
  /** Adds regular stock, or — with `batch` — units from a near-expiry batch at its markdown. */
  const addItem = useCallback(
    (item: PosItem, qty = 1, batch: Batch | null = null) => {
      if (batch && isExpired(batch)) {
        beep(false);
        notify(`Batch ${batch.id} of ${item.name} has expired — do not sell it. Take it off the shelf.`, 'bad');
        return;
      }
      const key = lineKeyFor(item.sku, batch);
      const newQty = r2((lines.find((l) => l.key === key)?.qty ?? 0) + qty);
      const available = batch ? batch.qty : batchesBySku.has(item.sku) ? freshQty(item) : item.stock;
      setSession((s) => {
        const existing = s.draft.lines.find((l) => l.key === key);
        const next = existing
          ? s.draft.lines.map((l) => (l.key === key ? { ...l, qty: r2(l.qty + qty) } : l))
          : [...s.draft.lines, makeLine(item, qty, batch)];
        return { ...s, draft: { ...s.draft, lines: next } };
      });
      setSelected(key);
      setFlash((f) => ({ key, n: (f?.n ?? 0) + 1 }));
      beep(true);
      if (newQty > available)
        notify(
          batch ? `Only ${available} left in batch ${batch.id} of ${item.name}` : `Only ${Math.max(0, available)} ${item.name} in stock — check the shelf`,
          'bad'
        );
    },
    [notify, lines, batchesBySku, freshQty]
  );

  /** Moves `qty` units of a product from regular stock onto its near-expiry batch line. */
  const switchToBatch = (item: PosItem, qty: number, b: Batch) => {
    const key = lineKeyFor(item.sku, b);
    setSession((s) => {
      let ls = s.draft.lines.flatMap((l) => (l.key === item.sku ? (l.qty - qty > 0 ? [{ ...l, qty: r2(l.qty - qty) }] : []) : [l]));
      ls = ls.some((l) => l.key === key) ? ls.map((l) => (l.key === key ? { ...l, qty: r2(l.qty + qty) } : l)) : [...ls, makeLine(item, qty, b)];
      return { ...s, draft: { ...s.draft, lines: ls } };
    });
    setSelected(key);
    setFlash((f) => ({ key, n: (f?.n ?? 0) + 1 }));
  };

  /**
   * A scanned barcode identifies the product, not the batch. Regular stock is added by default with a
   * one-tap switch to the near-expiry batch; if everything on the shelf is near expiry, the batch is used.
   */
  const addScanned = (item: PosItem, qty = 1) => {
    const sellable = (batchesBySku.get(item.sku) ?? []).filter((b) => !isExpired(b));
    const first = sellable[0];
    if (!first) return addItem(item, qty);
    if (freshQty(item) > 0) {
      addItem(item, qty);
      notify(`${item.name}: a near-expiry batch is ${first.pct ?? 0}% off (${expiryLabel(first.days).toLowerCase()})`, 'info', {
        label: `Use batch −${first.pct ?? 0}%`,
        run: () => switchToBatch(item, qty, first),
      });
    } else {
      addItem(item, qty, first);
      notify(`Near-expiry batch ${first.id}: ${first.pct ?? 0}% off applied`, 'info');
    }
  };

  const removeLine = (key: string) => {
    const snapshot = session.draft;
    const line = snapshot.lines.find((l) => l.key === key);
    setLines((ls) => ls.filter((l) => l.key !== key));
    setSelected((s) => (s === key ? null : s));
    if (line) notify(`Removed ${line.name}`, 'info', { label: 'Undo', run: () => restore(snapshot) });
  };
  const setQty = (key: string, qty: number) => {
    if (!(qty > 0)) return removeLine(key);
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, qty: l.sku ? Math.round(qty) || 1 : r2(qty) } : l)));
  };
  const clearBill = () => {
    const snapshot = session.draft;
    setDraft(() => emptyDraft);
    setSelected(null);
    if (snapshot.lines.length) notify('Bill cleared', 'info', { label: 'Undo', run: () => restore(snapshot) });
  };

  const holdBill = () => {
    if (!lines.length) return notify('Nothing to hold yet', 'bad');
    const h: HeldBill = { id: String(Date.now()), heldAt: new Date().toISOString(), lines, billDiscount, buyer, total: totals.payable };
    setSession((s) => ({ ...s, held: [h, ...s.held], draft: emptyDraft }));
    setSelected(null);
    notify(`Bill on hold (${money(h.total)}). Resume it from Held bills.`, 'info');
  };
  const resumeHeld = (h: HeldBill) => {
    setSession((s) => {
      const held = s.held.filter((x) => x.id !== h.id);
      // Park whatever is on screen so nothing is lost.
      const parked: HeldBill[] = s.draft.lines.length
        ? [{ id: String(Date.now()), heldAt: new Date().toISOString(), ...s.draft, total: computeBill(s.draft.lines, s.draft.billDiscount).payable }]
        : [];
      return { ...s, held: [...parked, ...held], draft: { lines: h.lines, billDiscount: h.billDiscount, buyer: h.buyer } };
    });
    setModal(null);
  };

  /* scanning & search */
  const onScan = useCallback(
    (code: string) => {
      if (modal) return;
      const hit = findByCode(catalog, code);
      if (hit) addScanned(hit);
      else {
        beep(false);
        notify(`No product with barcode ${code}`, 'bad');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- addScanned is rebuilt each render from the same deps
    [catalog, addItem, notify, modal, batchesBySku]
  );
  useBarcodeScanner(onScan, ready && !modal);

  const pickOption = (o: Option) => {
    if (o.kind === 'batch') addItem(o.item, parsed.qty, o.batch);
    else addItem(o.item, parsed.qty);
    setQuery('');
    setClearanceMode(false);
  };

  /** Moves the selected bill line up/down (used when the search box is empty). */
  const moveSelection = (dir: 1 | -1) => {
    if (!lines.length) return;
    const i = lines.findIndex((l) => l.key === selected);
    const next = i < 0 ? (dir === 1 ? 0 : lines.length - 1) : Math.max(0, Math.min(lines.length - 1, i + dir));
    setSelected(lines[next]!.key);
    document.getElementById(`line-${lines[next]!.key}`)?.scrollIntoView({ block: 'nearest' });
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const sel = selected ? lines.find((l) => l.key === selected) : undefined;
    // Empty search box (and no clearance list open): the keys work on the bill instead.
    if (!query && !clearanceMode) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      } else if (sel && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        setQty(sel.key, sel.qty + 1);
      } else if (sel && e.key === '-') {
        e.preventDefault();
        setQty(sel.key, sel.qty - 1);
      } else if (sel && e.key === 'Delete') {
        e.preventDefault();
        removeLine(sel.key);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
      setClearanceMode(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // A typed / pasted barcode or SKU behaves exactly like a scan.
      const exact = query.trim() ? findByCode(catalog, parsed.text) : undefined;
      if (exact) {
        addScanned(exact, parsed.qty);
        setQuery('');
        return;
      }
      const pick = options[highlight];
      if (pick) pickOption(pick);
      else {
        beep(false);
        notify(`Nothing matches "${query.trim()}"`, 'bad');
      }
    }
  };

  /* printing */
  const browserPrint = (doc: PosDocument) => {
    setPrintDoc(doc);
    window.setTimeout(() => window.print(), 60);
  };
  const print = async (doc: PosDocument, s: PosSettings = settings) => {
    const kick = s.openDrawer && doc.kind === 'invoice' && doc.payments.some((p) => p.method === 'Cash');
    // Desktop app: print the receipt straight to the chosen printer, no dialog.
    if (s.printMethod === 'desktop' && window.posDesktop) {
      setPrintDoc(doc);
      await new Promise((r) => window.setTimeout(r, 80)); // let the receipt render into the print area
      const res = await window.posDesktop.print(s.desktopPrinter ? { deviceName: s.desktopPrinter } : {});
      if (res.ok) notify(`Receipt printed${s.desktopPrinter ? ` on ${s.desktopPrinter}` : ''}`);
      else notify(`Printer: ${res.reason ?? 'could not print'}. Check the printer in POS settings.`, 'bad');
      return;
    }
    if (s.printMethod === 'serial') {
      try {
        await printEscPos(toEscPos(doc, s.paperWidth, { kickDrawer: kick, profile }), s.baudRate);
        notify('Receipt sent to printer');
        return;
      } catch (e) {
        notify(`${e instanceof Error ? e.message : 'Printer error'} Using the print dialog instead.`, 'bad');
      }
    }
    browserPrint(doc);
  };

  /* completing a sale */
  const completeSale = (payments: Payment[], change: number) => {
    // Connected: the server prices the bill again, takes the stock, numbers the invoice and
    // records the payments in one transaction; only then is the bill recorded here.
    if (isLive()) {
      // A registered counter that can't reach the server records the bill on this computer
      // (numbered from its reserved block) and sends it when the connection is back.
      const order = session.draft.order ?? null;
      sellLive({
        storeId: branch.id,
        lines,
        billDiscount,
        buyer,
        payments,
        payable: totals.payable,
        customerOrderId: order?.id,
        customerId: order ? buyer?.customerId : undefined,
      })
        .then((r) => {
          finishSale(payments, change, r.invoiceNo);
          if (r.offline) notify('No connection — bill saved on this counter. It will be sent automatically.');
          else if (order) notify(`${order.number} billed as ${r.invoiceNo}`);
        })
        .catch((e: unknown) => notify(errorMessage(e), 'bad'));
      return;
    }
    finishSale(payments, change);
  };

  const finishSale = (payments: Payment[], change: number, serverNo?: string) => {
    const now = new Date();
    const inv: Invoice = {
      kind: 'invoice',
      no: serverNo ?? invoiceNo(profile.invoicePrefix, now, session.seq),
      issuedAt: now.toISOString(),
      cashier: cashierName,
      counter: counterName,
      buyer,
      interState,
      lines,
      billDiscount,
      totals,
      payments,
      change,
      returned: {},
      refunded: 0,
      billOfSupply: !gst,
    };
    setSession((s) => ({ ...s, docs: [inv, ...s.docs], seq: s.seq + 1, draft: emptyDraft }));
    const sold: Record<string, number> = {};
    for (const l of lines) if (l.sku) sold[l.sku] = r2((sold[l.sku] ?? 0) - l.qty);
    adjustStock(branch.id, sold);
    setBatchStock((bs) => {
      const next = { ...bs };
      for (const l of lines) if (l.batch) next[l.batch.id] = Math.max(0, r2((next[l.batch.id] ?? 0) - l.qty));
      return next;
    });
    setSelected(null);
    setModal({ kind: 'done', doc: inv });
    if (settings.autoPrint) void print(inv);
  };

  /* returns */
  const doReturn = (inv: Invoice, qtys: Record<string, number>, reason: string, method: PayMethod) => {
    if (isLive()) {
      returnLive(inv.no, qtys, reason, method, branch.id)
        .then((r) => finishReturn(inv, qtys, reason, method, r))
        .catch((e: unknown) => notify(errorMessage(e), 'bad'));
      return;
    }
    finishReturn(inv, qtys, reason, method);
  };

  /** Cancels one of today's bills on the server; stock comes back on this counter's screen too. */
  const doVoid = async (inv: Invoice, reason: string, approval?: { userId: string; pin: string }) => {
    const saleId = await saleIdForInvoice(inv.no);
    if (!saleId) throw new Error('This counter can’t find that bill on the server any more — cancel it from the Sales screen.');
    await voidSale(saleId, reason, approval);
    setSession((s) => ({ ...s, patched: { ...s.patched, [inv.no]: { ...s.patched[inv.no], cancelled: true } } }));
    const back: Record<string, number> = {};
    for (const l of inv.lines) if (l.sku) back[l.sku] = r2((back[l.sku] ?? 0) + l.qty - (inv.returned[l.key] ?? 0));
    adjustStock(branch.id, back);
    setModal(null);
    notify(`Bill ${inv.no} cancelled — ${money(inv.totals.payable)} reversed`, 'info');
  };

  const finishReturn = (
    inv: Invoice,
    qtys: Record<string, number>,
    reason: string,
    method: PayMethod,
    server?: { creditNoteNo: string; refund: number },
  ) => {
    const cl = buildCreditLines(inv, qtys);
    if (!cl.length) return;
    const refund = server?.refund ?? refundFor(inv, cl);
    const now = new Date();
    const cn: CreditNote = {
      kind: 'credit',
      no: server?.creditNoteNo ?? creditNoteNo(now, session.cnSeq),
      issuedAt: now.toISOString(),
      against: inv.no,
      cashier: cashierName,
      buyer: inv.buyer,
      interState: inv.interState,
      lines: cl,
      slabs: slabsOf(cl, inv.interState),
      total: r2(cl.reduce((s, l) => s + l.amount, 0)),
      refund: { method, amount: refund },
      reason,
      billOfSupply: inv.billOfSupply,
    };
    const returned = { ...inv.returned };
    for (const l of cl) returned[l.key] = r2((returned[l.key] ?? 0) + l.qty);
    setSession((s) => ({
      ...s,
      docs: [cn, ...s.docs],
      cnSeq: s.cnSeq + 1,
      patched: { ...s.patched, [inv.no]: { ...s.patched[inv.no], returned, refunded: r2(inv.refunded + refund) } },
    }));
    // Returned goods go back on the shelf (damaged / expired stock is left out).
    if (reason !== 'Damaged / defective' && reason !== 'Expired') {
      const back: Record<string, number> = {};
      for (const l of cl) {
        const sku = inv.lines.find((x) => x.key === l.key)?.sku;
        if (sku) back[sku] = r2((back[sku] ?? 0) + l.qty);
      }
      adjustStock(branch.id, back);
      // Near-expiry units go back into their batch, so they keep selling at the markdown.
      setBatchStock((bs) => {
        const next = { ...bs };
        for (const l of cl) {
          const id = inv.lines.find((x) => x.key === l.key)?.batch?.id;
          if (id && id in next) next[id] = r2((next[id] ?? 0) + l.qty);
        }
        return next;
      });
    }
    setModal({ kind: 'done', doc: cn });
    if (settings.autoPrint) void print(cn);
  };

  /* keyboard shortcuts */
  const openPay = (method: PayMethod) => {
    if (!lines.length) return notify('Add items to the bill first', 'bad');
    setModal({ kind: 'pay', method });
  };
  useEffect(() => {
    if (!ready) return;
    const onKey = (e: KeyboardEvent) => {
      if (modal) {
        if (modal.kind === 'done' && e.key === 'Enter' && !isTyping(e.target)) {
          e.preventDefault();
          setModal(null);
        }
        return;
      }
      // Alt + letter: the occasional actions (close drawer, settings, dashboard, sign out).
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const alt: Record<string, (() => void) | undefined> = {
          d: isLive() ? () => setModal({ kind: 'drawer' }) : undefined,
          s: () => setModal({ kind: 'settings' }),
          m: canManage ? () => router.push('/dashboard') : undefined,
          l: signOutHere,
        };
        const run = alt[e.key.toLowerCase()];
        if (run) {
          e.preventDefault();
          run();
          return;
        }
      }
      const fn: Record<string, () => void> = {
        F1: () => setModal({ kind: 'help' }),
        F2: () => searchRef.current?.focus(),
        F3: () => setModal({ kind: 'customer' }),
        F4: () => setModal({ kind: 'held' }),
        F5: () => openPay('Cash'),
        F6: () => openPay('UPI'),
        F7: () => openPay('Card'),
        F8: holdBill,
        F9: () => setModal({ kind: 'returns' }),
        F10: () => (lines.length ? setModal({ kind: 'bill-discount' }) : notify('Add items before giving a discount', 'bad')),
      };
      if (fn[e.key]) {
        e.preventDefault();
        fn[e.key]!();
        return;
      }
      if (isTyping(e.target)) return;
      if (e.key === '?') {
        e.preventDefault();
        setModal({ kind: 'help' });
        return;
      }
      const line = selected ? lines.find((l) => l.key === selected) : undefined;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      else if (!line) return;
      else if (e.key === '+' || e.key === '=') setQty(line.key, line.qty + 1);
      else if (e.key === '-') setQty(line.key, line.qty - 1);
      else if (e.key === 'Delete') removeLine(line.key);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Keep the search box focused for the next scan / search whenever no dialog is open.
  useEffect(() => {
    if (!modal) searchRef.current?.focus();
  }, [modal]);

  const dismissTips = () => {
    setTipsDismissed(true);
    saveLocal('ui', { tipsDismissed: true });
  };

  const lineBeingDiscounted = modal?.kind === 'line-discount' ? lines.find((l) => l.key === modal.key) : undefined;
  const netBeforeBillDiscount = r2(totals.gross - totals.lineDiscounts);
  const taxedSlabs = totals.slabs.filter((s) => s.rate > 0);
  const expiryMarkdown = r2(totals.rows.filter((r) => r.batch).reduce((s, r) => s + r.lineDiscount, 0));

  /* ---------- render ---------- */

  return (
    <div className="flex h-dvh flex-col bg-bg text-[13px] text-ink">
      <style>{`
        @keyframes pos-flash { from { background: color-mix(in oklch, var(--teal) 24%, transparent); } to { background: transparent; } }
        .pos-flash { animation: pos-flash 900ms ease-out; }
      `}</style>

      {/* ===== Top bar ===== */}
      <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line/70 bg-surface/90 px-3 backdrop-blur sm:px-4">
        <Link href={canManage ? '/dashboard' : '/pos'} className="flex items-center gap-2.5" title={canManage ? 'Back to dashboard' : 'POS & Billing'}>
          <BrandBadge className="h-7" padding="px-0.5 py-0.5" />
          <span className="hidden whitespace-nowrap leading-tight lg:block">
            <span className="block text-[14px] font-extrabold">POS &amp; Billing</span>
            <span className="block text-[11px] text-mute">
              {profile.displayName}
              {multiBranch && ` · ${branch.name}`}
            </span>
          </span>
        </Link>

        {/* Only a warning lives here now; the bill number is on the bill, device status in the account menu. */}
        {ready && profile.isSample && (
          <Link
            href="/business-profile"
            title="Invoices are printing the demo store's name, address and GSTIN"
            className="ml-2 hidden items-center gap-1.5 whitespace-nowrap rounded-full bg-amber/15 px-3 py-1.5 text-[11px] font-semibold text-amber hover:bg-amber/25 md:flex"
          >
            <TriangleAlert className="size-3.5" /> Set up store profile
          </Link>
        )}

        <div className="ml-auto flex items-center gap-3">
          {isLive() && <SyncChip onOpen={() => setModal({ kind: 'sync' })} />}
          <span className="hidden whitespace-nowrap text-right leading-tight lg:block">
            <span className="block text-[11px] text-mute">Today on this counter</span>
            <span className="block font-bold tabular-nums">
              {short(todaysSales.reduce((t, i) => t + i.totals.payable, 0))} · {todaysSales.length} bill{todaysSales.length === 1 ? '' : 's'}
            </span>
          </span>
          <NotificationBell size="size-9" />
          <span className="flex min-w-0 items-center gap-2 whitespace-nowrap border-l border-line pl-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-vio/15 text-[11px] font-bold text-vio">{initials(cashierName)}</span>
            <span className="hidden min-w-0 max-w-[180px] leading-tight md:block">
              <span className="block truncate font-semibold">{cashierName}</span>
              <span className="block truncate text-[11px] text-mute">
                {user ? `${roleLabel[user.role]} · ` : ''}
                {counterName}
                {clock && ` · ${clock.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`}
              </span>
            </span>
          </span>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_360px] lg:overflow-hidden xl:grid-cols-[minmax(0,1fr)_400px]">
        {/* ===== Left: scan / search + the items on this bill ===== */}
        <section className="flex min-h-[60dvh] flex-col gap-2.5 p-2.5 sm:p-3 lg:min-h-0">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-mute" aria-hidden="true" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setClearanceMode(false);
                  setSearchFocused(true);
                }}
                onKeyDown={onSearchKey}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder="Scan barcode, or type item name / SKU…   (3*milk adds three)"
                aria-label="Scan or search items"
                aria-expanded={showResults}
                aria-controls="pos-results"
                role="combobox"
                autoComplete="off"
                spellCheck={false}
                className="h-12 w-full rounded-2xl border border-line/80 bg-surface pl-11 pr-20 text-[15px] font-medium shadow-sm outline-none transition placeholder:font-normal placeholder:text-mute focus:border-blue focus:shadow-[0_0_0_4px_color-mix(in_oklch,var(--blue)_12%,transparent)]"
              />
              <span className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
                {query ? (
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setQuery('')}
                    aria-label="Clear search"
                    className="grid size-6 place-items-center rounded-full bg-bg text-sub hover:text-ink"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : (
                  <ScanBarcode className="size-[18px] text-mute" aria-hidden="true" />
                )}
                <Kbd>F2</Kbd>
              </span>

              {/* Results dropdown */}
              {showResults && (
                <div className="absolute inset-x-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-xl border border-line bg-surface shadow-2xl animate-in fade-in slide-in-from-top-1">
                  {options.length ? (
                    <>
                      {browsingClearance && (
                        <div className="flex items-center gap-2 border-b border-line bg-amber/10 px-3 py-2 text-[12px] font-semibold text-amber">
                          <Tag className="size-4" />
                          Near-expiry stock — sell these first. The markdown is applied automatically.
                        </div>
                      )}
                      <ul id="pos-results" role="listbox" aria-label="Matching items" className="max-h-[min(60dvh,480px)] divide-y divide-line overflow-y-auto">
                        {options.map((o, i) => (
                          <OptionRow
                            key={o.key}
                            o={o}
                            inCart={qtyOnLine(o.key)}
                            active={i === highlight}
                            showGst={gst}
                            onPick={() => pickOption(o)}
                            onHover={() => setHighlight(i)}
                          />
                        ))}
                      </ul>
                      <div className="flex items-center justify-between gap-2 border-t border-line bg-bg px-3 py-1.5 text-[11px] text-mute">
                        <span>
                          {browsingClearance
                            ? `${options.length} near-expiry batch${options.length === 1 ? '' : 'es'}`
                            : allResults.length > results.length
                              ? `Top ${results.length} of ${allResults.length} items — keep typing to narrow`
                              : `${results.length} item${results.length === 1 ? '' : 's'}`}
                          {!browsingClearance && options.some((o) => o.kind === 'batch') && (
                            <span className="font-semibold text-amber"> · near-expiry batches shown under their item</span>
                          )}
                          {parsed.hasQty && <b className="text-ink"> · adding {parsed.qty}</b>}
                        </span>
                        <span className="hidden sm:inline">↑↓ choose · Enter add · Esc close</span>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center justify-between gap-3 px-3 py-3">
                      <span className="text-sub">
                        No item matches <b className="text-ink">&ldquo;{parsed.text}&rdquo;</b>
                      </span>
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setQuery('');
                          setModal({ kind: 'open-item' });
                        }}
                        className="h-8 shrink-0 rounded-lg gbv px-3 text-[12px] font-semibold text-onbrand"
                      >
                        Add as loose item
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            {ready && cameraScanSupported() && (
              <button
                onClick={() => setModal({ kind: 'camera' })}
                title="Scan with camera"
                className="flex h-12 items-center gap-1.5 rounded-2xl border border-line/80 bg-surface px-3.5 font-semibold shadow-sm transition hover:border-blue/50"
              >
                <Camera className="size-[18px] text-blue" />
                <span className="hidden xl:inline">Camera</span>
              </button>
            )}
            {sellableClearance > 0 && (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery('');
                  setClearanceMode((v) => !v);
                  setSearchFocused(true);
                  searchRef.current?.focus();
                }}
                title="Near-expiry stock at a markdown — sell these first"
                aria-pressed={clearanceMode}
                className={`flex h-12 items-center gap-1.5 rounded-2xl border px-3.5 font-semibold shadow-sm transition ${
                  clearanceMode ? 'border-amber bg-amber/10 text-amber' : 'border-line/80 bg-surface hover:border-amber'
                }`}
              >
                <Tag className="size-[18px] text-amber" />
                <span className="hidden sm:inline">Near expiry</span>
                <span className="grid min-w-5 place-items-center rounded-full bg-amber px-1 text-[10px] font-bold text-onbrand">{sellableClearance}</span>
              </button>
            )}
            <button
              onClick={() => setModal({ kind: 'open-item' })}
              title="Weighed produce or items without a barcode"
              className="flex h-12 items-center gap-1.5 rounded-2xl border border-line/80 bg-surface px-3.5 font-semibold shadow-sm transition hover:border-blue/50"
            >
              <Scale className="size-[18px] text-blue" />
              <span className="hidden sm:inline">Loose item</span>
            </button>
          </div>

          {/* Items on this bill */}
          <div className="@container flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line/70 bg-surface shadow-sm">
            <div className="flex items-center justify-between gap-2 border-b border-line/70 px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <h2 className="text-[14px] font-extrabold">Current bill</h2>
                {ready && !isLive() && <span className="font-mono text-[11px] font-semibold text-mute">{nextNo}</span>}
                {lines.length > 0 && (
                  <span className="rounded-full bg-blue/10 px-2 py-0.5 text-[11px] font-bold text-blue">
                    {lines.length} line{lines.length === 1 ? '' : 's'} · {totals.itemCount} item{totals.itemCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              {lines.length > 0 && (
                <button onClick={clearBill} className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-semibold text-sub hover:bg-coral/10 hover:text-coral">
                  <Trash2 className="size-3.5" /> Clear bill
                </button>
              )}
            </div>

            {session.draft.order && (
              <div className="flex items-center justify-between gap-2 border-b border-line bg-vio/10 px-3 py-1.5 text-[12px]">
                <span className="font-semibold text-vio">
                  Billing order {session.draft.order.number}
                  {buyer?.name ? ` · ${buyer.name}` : ''}
                </span>
                <button onClick={() => setDraft((d) => ({ ...d, order: null }))} className="font-semibold text-sub hover:text-ink">
                  Not for this order
                </button>
              </div>
            )}
            {lines.length === 0 ? (
              <div className="grid flex-1 place-items-center px-4 py-10 text-center">
                <div className="max-w-[340px]">
                  <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-blue/10">
                    <ScanBarcode className="size-8 text-blue" />
                  </div>
                  <div className="mt-3 text-[15px] font-bold text-ink">Ready for the next customer</div>
                  <div className="mt-1 text-sub">Scan a barcode, or type a few letters of an item and press Enter.</div>
                  {ready && !tipsDismissed && (
                    <div className="mt-5 rounded-xl bg-bg p-3 text-left text-[12px]">
                      <div className="mb-1.5 flex items-center justify-between font-bold text-ink">
                        <span className="flex items-center gap-1.5">
                          <Info className="size-3.5 text-blue" /> Quick tips
                        </span>
                        <button onClick={dismissTips} aria-label="Dismiss tips" className="text-mute hover:text-ink">
                          <X className="size-3.5" />
                        </button>
                      </div>
                      <ul className="space-y-1 text-sub">
                        <li>
                          Type <b className="text-ink">3*milk</b> to add three at once
                        </li>
                        <li>
                          <b className="text-ink">↑ ↓</b> pick a line, <b className="text-ink">+ −</b> change its quantity
                        </li>
                        <li>
                          <b className="text-ink">F5</b> cash · <b className="text-ink">F6</b> UPI · <b className="text-ink">F7</b> card · <b className="text-ink">F1</b> all shortcuts
                        </li>
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className={`${COLS} h-8 shrink-0 border-b border-line bg-bg px-3 text-[10px] font-bold uppercase tracking-wider text-mute`}>
                  <span className="hidden @2xl:block">#</span>
                  <span>Item</span>
                  <span className="hidden text-right @2xl:block">Rate</span>
                  <span className="text-center">Qty</span>
                  <span className="hidden text-center @sm:block">Disc.</span>
                  <span className="text-right">Amount</span>
                  <span />
                </div>
                <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
                  {lines.map((l, i) => {
                    const row = rowOf(l.key);
                    const isSel = selected === l.key;
                    const flashed = flash?.key === l.key;
                    const overStock = l.batch
                      ? (batchStock[l.batch.id] ?? 0) < l.qty
                      : l.sku
                        ? (stock[l.sku] ?? 0) < lines.filter((x) => x.sku === l.sku).reduce((s, x) => s + x.qty, 0)
                        : false;
                    const amount = row ? r2(row.gross - row.lineDiscount) : l.price * l.qty;
                    return (
                      <li
                        key={l.key}
                        id={`line-${l.key}`}
                        onClick={() => setSelected(l.key)}
                        className={`cursor-pointer ${isSel ? 'bg-blue/[0.05] shadow-[inset_3px_0_0_var(--blue)]' : 'hover:bg-bg'}`}
                      >
                        <div key={flashed ? `f${flash.n}` : 'x'} className={`${COLS} min-h-11 px-3 py-1.5 ${flashed ? 'pos-flash' : ''}`}>
                          <span className="hidden text-[11px] tabular-nums text-mute @2xl:block">{i + 1}</span>
                          <span className="min-w-0">
                            <span className="block truncate font-semibold text-ink" title={l.name}>
                              {l.name}
                            </span>
                            <span className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-mute">
                              <span className="@2xl:hidden">{short(l.price)} ·</span>
                              <span>
                                HSN {l.hsn}
                                {gst && ` · GST ${l.gst}%`}
                              </span>
                              {l.sku === null && <span>· loose</span>}
                              {l.batch && (
                                <span className="flex items-center gap-0.5 rounded-full bg-amber/15 px-1.5 font-semibold text-amber">
                                  <Tag className="size-3" /> Near expiry · exp {fmtExpiry(new Date(l.batch.expiresOn))}
                                </span>
                              )}
                              {overStock && (
                                <span className="flex items-center gap-0.5 font-semibold text-amber" title="More than the recorded stock">
                                  <TriangleAlert className="size-3" /> stock
                                </span>
                              )}
                            </span>
                          </span>
                          <span className="hidden text-right tabular-nums text-sub @2xl:block">
                            {short(l.price)}
                            {l.sku ? '' : '/kg'}
                          </span>
                          <span className="flex justify-center">
                            <span className="inline-flex items-center overflow-hidden rounded-lg border border-line bg-surface">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setQty(l.key, l.qty - 1);
                                }}
                                aria-label={l.qty <= 1 ? `Remove ${l.name}` : `Decrease ${l.name}`}
                                className="grid size-7 place-items-center text-sub transition hover:bg-bg hover:text-ink"
                              >
                                {l.qty <= 1 ? <Trash2 className="size-3.5" /> : <Minus className="size-3.5" />}
                              </button>
                              <input
                                type="number"
                                min={0}
                                step={l.sku ? 1 : 0.005}
                                value={l.qty}
                                onClick={(e) => e.stopPropagation()}
                                onFocus={(e) => e.target.select()}
                                onChange={(e) => setQty(l.key, Number(e.target.value))}
                                aria-label={`Quantity of ${l.name}`}
                                className="h-7 w-11 border-x border-line bg-transparent text-center text-[13px] font-bold tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                              />
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setQty(l.key, l.qty + 1);
                                }}
                                aria-label={`Increase ${l.name}`}
                                className="grid size-7 place-items-center text-sub transition hover:bg-bg hover:text-ink"
                              >
                                <Plus className="size-3.5" />
                              </button>
                            </span>
                          </span>
                          <span className="hidden justify-center @sm:flex">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setModal({ kind: 'line-discount', key: l.key });
                              }}
                              title={l.discount ? 'Edit discount' : 'Discount on this item'}
                              aria-label={l.discount ? `Edit discount on ${l.name}` : `Discount on ${l.name}`}
                              className={`flex h-7 items-center gap-0.5 rounded-lg px-2 text-[11px] font-semibold tabular-nums transition ${
                                l.batch ? 'bg-amber/15 text-amber' : l.discount ? 'bg-teal/15 text-teal' : 'text-mute hover:bg-bg hover:text-blue'
                              }`}
                            >
                              {row && row.lineDiscount > 0 ? `−${short(row.lineDiscount)}` : <Percent className="size-3.5" />}
                            </button>
                          </span>
                          <span className="text-right">
                            <span className="block text-[14px] font-extrabold tabular-nums">{money(amount)}</span>
                            {row && row.lineDiscount > 0 && <span className="block text-[11px] tabular-nums text-mute line-through">{money(row.gross)}</span>}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removeLine(l.key);
                            }}
                            aria-label={`Remove ${l.name}`}
                            className="grid size-7 place-items-center rounded-lg text-mute transition hover:bg-coral/10 hover:text-coral"
                          >
                            <X className="size-4" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div className="hidden shrink-0 items-center gap-x-4 border-t border-line bg-bg px-3 py-1.5 text-[11px] text-mute md:flex">
                  <span>
                    <Kbd>↑↓</Kbd> select line
                  </span>
                  <span>
                    <Kbd>+</Kbd> <Kbd>−</Kbd> quantity
                  </span>
                  <span>
                    <Kbd>Del</Kbd> remove
                  </span>
                  <span className="ml-auto">Tap a discount cell to give a discount on one item</span>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Phones / tablets: the billing panel sits below the items, so keep paying one tap away. */}
        {lines.length > 0 && (
          <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t border-line bg-surface/95 px-3 py-2 shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.25)] backdrop-blur lg:hidden">
            <span className="mr-auto leading-tight">
              <span className="block text-[11px] text-mute">To pay · {totals.itemCount} items</span>
              <span className="block text-[20px] font-extrabold tabular-nums">{money(totals.payable)}</span>
            </span>
            {(['Cash', 'UPI', 'Card'] as PayMethod[]).map((m, i) => {
              const I = methodIcon[m];
              return (
                <button
                  key={m}
                  onClick={() => openPay(m)}
                  className={`flex h-11 items-center gap-1.5 rounded-xl px-3 font-bold ${i === 0 ? 'bg-teal text-onbrand' : 'border-2 border-blue/30 text-blue'}`}
                >
                  <I className="size-4" />
                  <span className="hidden sm:inline">{m}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* ===== Right: billing details only ===== */}
        <aside className="flex flex-col gap-2.5 p-2.5 pb-20 sm:p-3 lg:min-h-0 lg:pb-3 lg:pl-0" aria-label="Billing details">
          {/* Customer */}
          <button
            onClick={() => setModal({ kind: 'customer' })}
            className="flex items-center gap-2.5 rounded-2xl border border-line/70 bg-surface px-3.5 py-2.5 text-left shadow-sm transition hover:border-blue/50 hover:bg-blue/[0.03]"
          >
            <span className={`grid size-9 shrink-0 place-items-center rounded-full ${buyer ? 'bg-vio/15 text-vio' : 'bg-bg text-mute'}`}>
              {buyer ? <span className="text-[12px] font-bold">{initials(buyer.name)}</span> : <UserRound className="size-[18px]" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate font-semibold">{buyer?.name ?? 'Walk-in customer'}</span>
                {savedCustomer && (
                  <span className="shrink-0 rounded-full bg-amber/15 px-1.5 text-[10px] font-semibold text-amber">
                    {tierOf(savedCustomer)} · {savedCustomer.points} pts
                  </span>
                )}
                {buyer?.gstin && <span className="shrink-0 rounded-full bg-sky/15 px-1.5 text-[10px] font-semibold text-sky">B2B</span>}
                {interState && <span className="shrink-0 rounded-full bg-amber/15 px-1.5 text-[10px] font-semibold text-amber">IGST</span>}
              </span>
              <span className="block truncate text-[11px] text-mute">
                {buyer ? [buyer.phone, buyer.gstin && `GSTIN ${buyer.gstin}`].filter(Boolean).join(' · ') || 'Tap to change' : 'Add a customer for loyalty points or a GST invoice'}
              </span>
            </span>
            <Kbd>F3</Kbd>
          </button>

          {/* Bill summary */}
          <section className="rounded-2xl border border-line/70 bg-surface p-3.5 shadow-sm lg:min-h-0 lg:flex-1 lg:overflow-y-auto" aria-label="Bill summary">
            <h2 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-mute">Bill summary</h2>
            <div className="space-y-1.5">
              <SummaryRow label={`Items (${totals.itemCount})`} value={money(totals.gross)} />
              {expiryMarkdown > 0 && (
                <SummaryRow
                  label={
                    <span className="flex items-center gap-1 text-amber">
                      <Tag className="size-3.5" /> Near-expiry markdown
                    </span>
                  }
                  value={`−${money(expiryMarkdown)}`}
                  tone="teal"
                />
              )}
              {totals.lineDiscounts - expiryMarkdown > 0.004 && (
                <SummaryRow label="Item discounts" value={`−${money(r2(totals.lineDiscounts - expiryMarkdown))}`} tone="teal" />
              )}
              <div className="flex items-center justify-between gap-2">
                <button
                  onClick={() => lines.length && setModal({ kind: 'bill-discount' })}
                  disabled={!lines.length}
                  className="flex items-center gap-1 font-semibold text-blue disabled:text-mute"
                >
                  <Percent className="size-3.5" />
                  {billDiscount ? `Bill discount${billDiscount.kind === 'pct' ? ` (${billDiscount.value}%)` : ''}` : 'Add bill discount'}
                  <Kbd>F10</Kbd>
                </button>
                {totals.billDiscount > 0 && <span className="tabular-nums text-teal">−{money(totals.billDiscount)}</span>}
              </div>
              <div className="my-1 border-t border-line" />
              {gst ? (
                <>
                  <SummaryRow label="Taxable value" value={money(totals.taxable)} />
                  {interState ? (
                    <SummaryRow label="IGST" value={money(totals.taxTotal)} />
                  ) : (
                    <>
                      <SummaryRow label="CGST" value={money(totals.slabs.reduce((s, x) => s + x.cgst, 0))} />
                      <SummaryRow label="SGST" value={money(totals.slabs.reduce((s, x) => s + x.sgst, 0))} />
                    </>
                  )}
                </>
              ) : (
                <div className="rounded-xl bg-bg px-2.5 py-2 text-[12px] text-sub">
                  <b className="text-ink">Bill of supply</b> — {registrationInfo[profile.registration].label.toLowerCase()}, GST is not
                  charged.
                </div>
              )}
              {totals.roundOff !== 0 && <SummaryRow label="Round off" value={money(totals.roundOff)} />}
            </div>

            {gst && taxedSlabs.length > 0 && (
              <table className="mt-3 w-full text-[11px] tabular-nums text-sub [&_td]:!px-0 [&_td]:py-0.5 [&_th]:!px-0">
                <thead>
                  <tr className="text-mute">
                    <th className="pb-1 text-left font-semibold">GST rate</th>
                    <th className="pb-1 text-right font-semibold">Taxable</th>
                    <th className="pb-1 text-right font-semibold">Tax</th>
                  </tr>
                </thead>
                <tbody className="border-t border-line">
                  {taxedSlabs.map((s) => (
                    <tr key={s.rate}>
                      <td>
                        {s.rate}% {interState ? 'IGST' : `(${s.rate / 2}% + ${s.rate / 2}%)`}
                      </td>
                      <td className="text-right">{money(s.taxable)}</td>
                      <td className="text-right">{money(r2(s.cgst + s.sgst + s.igst))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* To pay */}
          <div className="relative overflow-hidden rounded-2xl gbv p-4 text-onbrand shadow-xl shadow-blue/25">
            <span aria-hidden className="pointer-events-none absolute -right-8 -top-10 size-32 rounded-full bg-white/10 blur-xl" />
            <div className="flex items-end justify-between gap-2">
              <span>
                <span className="block text-[12px] font-semibold text-onbrand/80">To pay</span>
                <span className="block text-[11px] text-onbrand/70">{gst ? `incl. GST ${money(totals.taxTotal)}` : 'Bill of supply'}</span>
              </span>
              <span className="text-[34px] font-extrabold leading-none tabular-nums tracking-tight">{money(totals.payable)}</span>
            </div>
            {totals.discountTotal > 0 && (
              <div className="mt-2 rounded-lg bg-onbrand/15 px-2.5 py-1 text-center text-[12px] font-semibold">
                Customer saves {money(totals.discountTotal)}
              </div>
            )}
          </div>

          {/* Pay */}
          <div className="grid grid-cols-3 gap-1.5">
            {(['Cash', 'UPI', 'Card'] as PayMethod[]).map((m, i) => {
              const I = methodIcon[m];
              return (
                <button
                  key={m}
                  onClick={() => openPay(m)}
                  disabled={!lines.length}
                  className={`flex h-16 flex-col items-center justify-center gap-0.5 rounded-2xl font-bold transition active:scale-[0.98] disabled:opacity-40 ${
                    i === 0
                      ? 'bg-teal text-onbrand shadow-lg shadow-teal/30 hover:brightness-105'
                      : 'border border-line/80 bg-surface text-ink shadow-sm hover:border-blue/50 hover:bg-blue/[0.03]'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-[14px]">
                    <I className={`size-[18px] ${i === 0 ? '' : i === 1 ? 'text-blue' : 'text-vio'}`} /> {m}
                  </span>
                  <span className={`text-[10px] font-semibold ${i === 0 ? 'text-onbrand/80' : 'text-mute'}`}>F{5 + i}</span>
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={holdBill}
              disabled={!lines.length}
              className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-line/70 bg-surface font-semibold text-sub shadow-sm transition hover:border-amber hover:text-amber disabled:opacity-40"
            >
              <CirclePause className="size-4" /> Hold bill <Kbd>F8</Kbd>
            </button>
            <button
              onClick={clearBill}
              disabled={!lines.length}
              className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-line/70 bg-surface font-semibold text-sub shadow-sm transition hover:border-coral hover:text-coral disabled:opacity-40"
            >
              <Trash2 className="size-4" /> Clear bill
            </button>
          </div>
        </aside>
      </div>

      {/* ===== Function keys: every action visible with its key, no menus to open ===== */}
      <nav aria-label="Function keys" className="flex shrink-0 items-center gap-1 overflow-hidden border-t border-line/70 bg-surface px-2 py-1.5">
        <FnKey k="F1" label="Help" onClick={() => setModal({ kind: 'help' })} />
        <FnKey k="F2" label="Search" onClick={() => searchRef.current?.focus()} />
        <FnKey k="F3" label="Customer" onClick={() => setModal({ kind: 'customer' })} />
        <FnKey k="F4" label="Held bills" short="Held" count={session.held.length} onClick={() => setModal({ kind: 'held' })} />
        <FnKey k="F9" label="Bills & returns" short="Returns" onClick={() => setModal({ kind: 'returns' })} />
        <FnKey k="F10" label="Discount" onClick={() => (lines.length ? setModal({ kind: 'bill-discount' }) : notify('Add items before giving a discount', 'bad'))} />
        <span className="mx-0.5 h-6 w-px shrink-0 bg-line xl:mx-1" aria-hidden="true" />
        {isLive() && <FnKey k="Alt+D" label="Close drawer" short="Drawer" onClick={() => setModal({ kind: 'drawer' })} />}
        <FnKey k="Alt+S" label="Settings" onClick={() => setModal({ kind: 'settings' })} />
        {canManage && <FnKey k="Alt+M" label="Dashboard" short="Back office" onClick={() => router.push('/dashboard')} />}
        <FnKey k="Alt+L" label="Sign out" tone="coral" onClick={signOutHere} />
        <span className="ml-auto hidden items-center gap-1.5 whitespace-nowrap pl-2 text-[11px] text-mute 2xl:flex">
          <span className="size-1.5 rounded-full bg-teal" /> Scanner ready · {settings.paperWidth} mm ·{' '}
          {settings.printMethod === 'serial' ? 'direct print' : settings.printMethod === 'desktop' ? 'silent print' : 'print dialog'}
          {settings.autoPrint && ' · auto'}
        </span>
      </nav>

      {/* ===== Dialogs ===== */}
      <Dialog open={modal !== null} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent
          className={`max-h-[92dvh] overflow-y-auto rounded-2xl border-line bg-surface text-ink ${
            modal?.kind === 'returns' || modal?.kind === 'done' || modal?.kind === 'pay' || modal?.kind === 'help' || modal?.kind === 'drawer' ? 'sm:max-w-2xl' : 'sm:max-w-lg'
          }`}
        >
          {modal?.kind === 'pay' && (
            <>
              <DialogHeader className="pr-8">
                <DialogTitle className="text-[18px] font-extrabold">Take payment</DialogTitle>
                <DialogDescription asChild>
                  <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-sub">
                    <span className="flex items-center gap-1 rounded-full bg-bg px-2.5 py-1 font-semibold">
                      <ReceiptText className="size-3.5 text-blue" /> {nextNo}
                    </span>
                    <span className="rounded-full bg-bg px-2.5 py-1 font-semibold">
                      {totals.itemCount} item{totals.itemCount === 1 ? '' : 's'}
                    </span>
                    <span className="flex items-center gap-1 rounded-full bg-bg px-2.5 py-1 font-semibold">
                      <UserRound className="size-3.5 text-vio" /> {buyer?.name ?? 'Walk-in customer'}
                    </span>
                    {totals.discountTotal > 0 && (
                      <span className="rounded-full bg-teal/10 px-2.5 py-1 font-semibold text-teal">Saves {money(totals.discountTotal)}</span>
                    )}
                  </div>
                </DialogDescription>
              </DialogHeader>
              <PaymentPanel
                payable={totals.payable}
                billNo={nextNo}
                upiId={settings.upiId}
                payeeName={profile.displayName}
                initialMethod={modal.method}
                onComplete={completeSale}
                onCancel={() => setModal(null)}
              />
            </>
          )}

          {modal?.kind === 'done' && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <span className={`grid size-11 place-items-center rounded-full ${modal.doc.kind === 'invoice' ? 'bg-teal/15 text-teal' : 'bg-coral/15 text-coral'}`}>
                    <CircleCheck className="size-6" />
                  </span>
                  <div>
                    <DialogTitle className="text-[19px] font-extrabold">{modal.doc.kind === 'invoice' ? 'Sale complete' : 'Refund recorded'}</DialogTitle>
                    <DialogDescription className="text-sub">
                      {modal.doc.kind === 'invoice' ? `Invoice ${modal.doc.no}` : `Credit note ${modal.doc.no} · against ${modal.doc.against}`}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>
              <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
                <div className="flex flex-col gap-2.5">
                  {modal.doc.kind === 'invoice' ? (
                    modal.doc.change > 0 ? (
                      <div className="rounded-2xl bg-teal/15 p-4 text-teal">
                        <div className="font-semibold">Give change</div>
                        <div className="text-[38px] font-extrabold leading-tight tabular-nums">{money(modal.doc.change)}</div>
                        <div className="text-[12px]">
                          Received {money(modal.doc.payments.find((p) => p.tendered)?.tendered ?? modal.doc.totals.payable)} for {money(modal.doc.totals.payable)}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-2xl gbv p-4 text-onbrand">
                        <div className="text-onbrand/80">Paid</div>
                        <div className="text-[32px] font-extrabold leading-tight tabular-nums">{money(modal.doc.totals.payable)}</div>
                        <div className="text-[12px] text-onbrand/85">{modal.doc.payments.map((p) => `${p.method} ${money(p.amount)}`).join(' + ')}</div>
                      </div>
                    )
                  ) : (
                    <div className="rounded-2xl bg-coral/10 p-4 text-coral">
                      <div className="font-semibold">Refund by {modal.doc.refund.method}</div>
                      <div className="text-[32px] font-extrabold leading-tight tabular-nums">{money(modal.doc.refund.amount)}</div>
                    </div>
                  )}
                  <button
                    onClick={() => void print(modal.doc)}
                    className="flex h-11 items-center justify-center gap-2 rounded-xl border border-line font-semibold transition hover:border-blue"
                  >
                    <Printer className="size-4" /> Print receipt ({settings.paperWidth} mm)
                  </button>
                  {modal.doc.kind === 'invoice' && modal.doc.buyer?.phone && (
                    <a
                      href={`https://wa.me/${dialable(modal.doc.buyer.phone)}?text=${encodeURIComponent(shareText(modal.doc, profile.displayName))}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex h-11 items-center justify-center gap-2 rounded-xl border border-line font-semibold transition hover:border-blue"
                    >
                      <MessageCircle className="size-4" /> Send bill on WhatsApp
                    </a>
                  )}
                  <button
                    autoFocus
                    onClick={() => setModal(null)}
                    className="mt-auto flex h-14 items-center justify-center gap-2 rounded-xl gbv text-[16px] font-extrabold text-onbrand shadow-lg shadow-blue/25"
                  >
                    <Check className="size-5" /> Next customer <Kbd onDark>Enter</Kbd>
                  </button>
                </div>
                <div className="max-h-[60dvh] overflow-y-auto rounded-xl border border-line bg-white shadow-sm">
                  <Receipt doc={modal.doc} width={settings.paperWidth} profile={profile} />
                </div>
              </div>
            </>
          )}

          {modal?.kind === 'help' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">How to bill fast</DialogTitle>
                <DialogDescription className="text-sub">Everything works with the mouse or touch too — shortcuts just save time.</DialogDescription>
              </DialogHeader>
              <HelpPanel
                onClose={() => {
                  dismissTips();
                  setModal(null);
                }}
              />
            </>
          )}

          {modal?.kind === 'customer' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Customer</DialogTitle>
                <DialogDescription className="text-sub">A buyer GSTIN from another state switches the invoice to IGST.</DialogDescription>
              </DialogHeader>
              <CustomerPanel
                current={buyer}
                onSubmit={(b) => {
                  setDraft((d) => ({ ...d, buyer: b }));
                  setModal(null);
                  if (b) notify(`Billing to ${b.name}`, 'info');
                }}
                onCancel={() => setModal(null)}
              />
            </>
          )}

          {modal?.kind === 'line-discount' && lineBeingDiscounted && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Discount · {lineBeingDiscounted.name}</DialogTitle>
                <DialogDescription className="text-sub">
                  {lineBeingDiscounted.qty} × {money(lineBeingDiscounted.price)}. GST is charged on the price after discount.
                </DialogDescription>
              </DialogHeader>
              <DiscountPanel
                base={r2(lineBeingDiscounted.price * lineBeingDiscounted.qty)}
                current={lineBeingDiscounted.discount}
                // A near-expiry markdown is store policy, so it may exceed the cashier's own limit.
                maxPct={Math.max(MAX_CASHIER_DISCOUNT_PCT, lineBeingDiscounted.batch?.pct ?? 0)}
                onSubmit={(d) => {
                  setLines((ls) => ls.map((l) => (l.key === lineBeingDiscounted.key ? { ...l, discount: d } : l)));
                  setModal(null);
                }}
                onCancel={() => setModal(null)}
              />
            </>
          )}

          {modal?.kind === 'bill-discount' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Bill discount</DialogTitle>
                <DialogDescription className="text-sub">Shared across items in proportion to their value, after item discounts.</DialogDescription>
              </DialogHeader>
              <DiscountPanel
                base={netBeforeBillDiscount}
                current={billDiscount}
                maxPct={MAX_CASHIER_DISCOUNT_PCT}
                onSubmit={(d) => {
                  setDraft((dr) => ({ ...dr, billDiscount: d }));
                  setModal(null);
                  if (d) notify(`Bill discount ${money(discountAmount(netBeforeBillDiscount, d))} applied`);
                }}
                onCancel={() => setModal(null)}
              />
            </>
          )}

          {modal?.kind === 'open-item' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Loose / open-price item</DialogTitle>
                <DialogDescription className="text-sub">For weighed produce or items without a barcode.</DialogDescription>
              </DialogHeader>
              <OpenItemPanel
                onSubmit={(l) => {
                  const key = `open-${Date.now()}`;
                  setLines((ls) => [...ls, { ...l, key }]);
                  setSelected(key);
                  setFlash((f) => ({ key, n: (f?.n ?? 0) + 1 }));
                  setModal(null);
                }}
                onCancel={() => setModal(null)}
              />
            </>
          )}

          {modal?.kind === 'held' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Held bills</DialogTitle>
                <DialogDescription className="text-sub">Park a bill while a customer fetches something, and serve the next person.</DialogDescription>
              </DialogHeader>
              <HeldPanel
                held={session.held}
                onResume={resumeHeld}
                onDelete={(id) => setSession((s) => ({ ...s, held: s.held.filter((h) => h.id !== id) }))}
              />
            </>
          )}

          {modal?.kind === 'returns' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Bills &amp; returns</DialogTitle>
                <DialogDescription className="text-sub">Reprint a bill, or return items against it. Refunds use the price actually paid, after discounts.</DialogDescription>
              </DialogHeader>
              <ReturnsPanel
                invoices={allInvoices}
                docs={session.docs}
                onReturn={doReturn}
                {...(isLive() ? { onVoid: (inv: Invoice) => setModal({ kind: 'void', inv }) } : {})}
                onReprint={(d) => void print(d)}
                onCancel={() => setModal(null)}
              />
            </>
          )}

          {modal?.kind === 'void' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Cancel bill</DialogTitle>
                <DialogDescription className="text-sub">Only today’s bills with nothing returned can be cancelled. For anything else, return the items.</DialogDescription>
              </DialogHeader>
              <CancelBillForm
                invoiceNo={modal.inv.no}
                amount={modal.inv.totals.payable}
                storeId={branch.id}
                run={(reason, approval) => doVoid(modal.inv, reason, approval)}
                onClose={() => setModal({ kind: 'returns' })}
              />
            </>
          )}

          {modal?.kind === 'drawer' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Close drawer</DialogTitle>
                <DialogDescription className="text-sub">End of your shift: count the cash and close your drawer.</DialogDescription>
              </DialogHeader>
              <CloseDrawerPanel
                onClose={() => setModal(null)}
                onSignOut={() => {
                  setModal(null);
                  signOut();
                  router.replace('/login?next=/pos');
                }}
              />
            </>
          )}

          {modal?.kind === 'camera' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Scan with camera</DialogTitle>
                <DialogDescription className="text-sub">EAN-13, UPC and Code-128 barcodes.</DialogDescription>
              </DialogHeader>
              <CameraScanner
                onScan={(code) => {
                  setModal(null);
                  const hit = findByCode(catalog, code);
                  if (hit) addScanned(hit);
                  else {
                    beep(false);
                    notify(`No product with barcode ${code}`, 'bad');
                  }
                }}
                onCancel={() => setModal(null)}
              />
            </>
          )}

          {modal?.kind === 'sync' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Offline billing &amp; sync</DialogTitle>
                <DialogDescription className="text-sub">
                  Bills made without a connection are kept on this computer and sent automatically when it&apos;s back.
                </DialogDescription>
              </DialogHeader>
              <SyncPanel storeId={branch.id} />
            </>
          )}

          {modal?.kind === 'settings' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">POS settings</DialogTitle>
                <DialogDescription className="text-sub">Saved on this computer for this counter.</DialogDescription>
              </DialogHeader>
              {isLive() && (
                <button type="button" onClick={() => setModal({ kind: 'sync' })} className="-mt-1 self-start text-[12px] font-semibold text-blue">
                  Offline billing, sync and registering this computer as a counter →
                </button>
              )}
              <SettingsPanel
                settings={settings}
                onSave={(s) => {
                  setSettings(s);
                  saveLocal('settings', s);
                  setModal(null);
                  notify('Settings saved');
                }}
                onTestPrint={(s) => {
                  const now = new Date();
                  const sample = computeBill([{ key: 't', sku: null, name: 'Test item', hsn: '9999', gst: 5, price: 105, qty: 1, discount: null }], null);
                  void print(
                    {
                      kind: 'invoice',
                      no: 'TEST-PRINT',
                      issuedAt: now.toISOString(),
                      cashier: s.cashier,
                      counter: s.counter,
                      buyer: null,
                      interState: false,
                      lines: [],
                      billDiscount: null,
                      totals: sample,
                      payments: [{ method: 'Cash', amount: sample.payable }],
                      change: 0,
                      returned: {},
                      refunded: 0,
                    },
                    s
                  );
                }}
                onCancel={() => setModal(null)}
              />
            </>
          )}
        </DialogContent>
      </Dialog>

      <PrintArea doc={printDoc} width={settings.paperWidth} profile={profile} />

      {/* ===== Toast ===== */}
      {toast && (
        <div
          key={toast.id}
          role="status"
          aria-live="polite"
          className={`fixed bottom-6 left-1/2 z-[60] flex max-w-[92vw] -translate-x-1/2 items-center gap-3 rounded-2xl py-2.5 pl-4 pr-2.5 font-semibold text-onbrand shadow-2xl animate-in fade-in slide-in-from-bottom-3 ${
            toast.tone === 'bad' ? 'bg-coral' : 'bg-side'
          }`}
        >
          {toast.tone === 'bad' ? (
            <TriangleAlert className="size-4 shrink-0" />
          ) : toast.tone === 'ok' ? (
            <CircleCheck className="size-4 shrink-0 text-teal" />
          ) : (
            <Info className="size-4 shrink-0 text-sky" />
          )}
          <span>{toast.text}</span>
          {toast.action ? (
            <button
              onClick={() => {
                toast.action!.run();
                setToast(null);
              }}
              className="ml-1 rounded-lg bg-onbrand/15 px-3 py-1 text-[12px] font-bold hover:bg-onbrand/25"
            >
              {toast.action.label}
            </button>
          ) : (
            <button onClick={() => setToast(null)} aria-label="Dismiss" className="grid size-6 place-items-center rounded-md text-onbrand/70 hover:text-onbrand">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
