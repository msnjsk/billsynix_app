'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { inr } from '@/lib/store-data';
import { dailySales } from '@/lib/dashboard-data';
import { expiringBatches, inventoryItems, statusOf } from '@/lib/inventory-data';
import { dueState, initialSuppliers } from '@/lib/suppliers-data';
import { respond, suggestionGroups, type Reply, type ReplyRow } from '@/lib/assistant';

/* ---------- types ---------- */

type Msg =
  | { id: number; role: 'user'; text: string; time: string }
  | { id: number; role: 'assistant'; reply: Reply; time: string; vote?: 'up' | 'down' };

const now = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

const welcome: Reply = {
  topic: 'Welcome',
  text: "Hi Senthil 👋 I'm your business assistant. Ask me about stock, sales, suppliers or offers — I'll answer from your store's data and point you to the right page.",
};

/* ---------- insights (computed from the same data as the other pages) ---------- */

const lowCount = inventoryItems.filter((i) => statusOf(i) !== 'ok').length;
const criticalCount = inventoryItems.filter((i) => ['critical', 'out'].includes(statusOf(i))).length;
const overdue = initialSuppliers.filter((s) => dueState(s) === 'overdue');
const overdueAmt = overdue.reduce((s, x) => s + x.due, 0);
// Same ₹1.5L daily target the dashboard's "Today's Revenue" card uses.
const dailyTarget = { achieved: dailySales[dailySales.length - 1]?.revenue ?? 0, target: 150000 };
const targetPct =Math.round((dailyTarget.achieved / dailyTarget.target) * 100);

const insights = [
  {
    label: 'Reorder needed',
    value: `${lowCount} products`,
    note: `${criticalCount} critical`,
    tone: 'bg-coral/15 text-coral',
    ask: 'Which products should I reorder this week?',
  },
  {
    label: 'Overdue to suppliers',
    value: inr(overdueAmt),
    note: overdue.map((s) => s.name).join(', ') || 'Nothing overdue',
    tone: 'bg-amber/15 text-amber',
    ask: 'Which suppliers do I owe?',
  },
  {
    label: 'Expiring in 7 days',
    value: `${expiringBatches.length} batches`,
    note: `${expiringBatches.reduce((s, b) => s + b.qty, 0)} units at risk`,
    tone: 'bg-vio/15 text-vio',
    ask: 'What is expiring soon?',
  },
  {
    label: "Today's target",
    value: `${targetPct}%`,
    note: `${inr(dailyTarget.achieved)} of ${inr(dailyTarget.target)}`,
    tone: 'bg-teal/15 text-teal',
    ask: "How are today's sales?",
  },
];

/* ---------- message pieces ---------- */

const rowTone: Record<NonNullable<ReplyRow['tone']>, string> = {
  good: 'text-teal',
  warn: 'text-amber',
  bad: 'text-coral',
};

function BotAvatar() {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-xl gbv text-[13px] font-extrabold text-onbrand" aria-hidden="true">
      ✦
    </span>
  );
}

function AssistantBubble({
  msg,
  onVote,
}: {
  msg: Extract<Msg, { role: 'assistant' }>;
  onVote: (id: number, vote: 'up' | 'down') => void;
}) {
  const [copied, setCopied] = useState(false);
  const { reply } = msg;

  const copy = async () => {
    const lines = [reply.text, ...(reply.rows ?? []).map((r) => `• ${r.label}: ${r.value}`)];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard can be blocked; ignore */
    }
  };

  return (
    <div className="flex gap-3">
      <BotAvatar />
      <div className="min-w-0 max-w-[620px] flex-1">
        <div className="rounded-2xl rounded-tl-md border border-line bg-surface p-3.5">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-blue">{reply.topic}</div>
          <p className="leading-relaxed text-ink">{reply.text}</p>
          {reply.rows && reply.rows.length > 0 && (
            <ul className="mt-3 divide-y divide-line rounded-xl bg-bg px-3">
              {reply.rows.map((r) => (
                <li key={r.label} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-ink">{r.label}</span>
                  <span className={`shrink-0 font-semibold tabular-nums ${r.tone ? rowTone[r.tone] : 'text-sub'}`}>
                    {r.value}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {reply.actions && (
            <div className="mt-3 flex flex-wrap gap-2">
              {reply.actions.map((a) => (
                <Link
                  key={a.href + a.label}
                  href={a.href}
                  className="rounded-lg border border-line px-3 py-1.5 text-[12px] font-semibold text-blue hover:border-blue"
                >
                  {a.label} →
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="mt-1 flex items-center gap-3 pl-1 text-[11px] text-mute">
          <span className="tabular-nums">{msg.time}</span>
          {reply.topic !== 'Welcome' && (
            <>
              <button onClick={copy} className="hover:text-ink">
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                onClick={() => onVote(msg.id, 'up')}
                aria-label="Helpful"
                aria-pressed={msg.vote === 'up'}
                className={msg.vote === 'up' ? 'text-teal' : 'hover:text-ink'}
              >
                👍
              </button>
              <button
                onClick={() => onVote(msg.id, 'down')}
                aria-label="Not helpful"
                aria-pressed={msg.vote === 'down'}
                className={msg.vote === 'down' ? 'text-coral' : 'hover:text-ink'}
              >
                👎
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function UserBubble({ msg }: { msg: Extract<Msg, { role: 'user' }> }) {
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[520px] whitespace-pre-wrap rounded-2xl rounded-tr-md gbv px-3.5 py-2.5 text-onbrand">
        {msg.text}
      </div>
      <span className="mt-1 pr-1 text-[11px] tabular-nums text-mute">{msg.time}</span>
    </div>
  );
}

/* ---------- main view ---------- */

export function AssistantView() {
  const params = useSearchParams();
  const [messages, setMessages] = useState<Msg[]>(() => [{ id: 0, role: 'assistant', reply: welcome, time: '' }]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const nextId = useRef(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const askedFromUrl = useRef(false);

  const ask = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || thinking) return;
      setMessages((m) => [...m, { id: nextId.current++, role: 'user', text, time: now() }]);
      setDraft('');
      setThinking(true);
      // Simulated latency so the conversation feels natural; replace with a real request later.
      timer.current = setTimeout(() => {
        setMessages((m) => [...m, { id: nextId.current++, role: 'assistant', reply: respond(text), time: now() }]);
        setThinking(false);
        inputRef.current?.focus();
      }, 650 + Math.min(text.length * 8, 600));
    },
    [thinking]
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // /assistant?q=… asks that question straight away (once).
  const q = params.get('q');
  useEffect(() => {
    if (q && !askedFromUrl.current) {
      askedFromUrl.current = true;
      ask(q);
    }
  }, [q, ask]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    ask(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask(draft);
    }
  };

  const vote = (id: number, v: 'up' | 'down') =>
    setMessages((m) =>
      m.map((x) => (x.id === id && x.role === 'assistant' ? { ...x, vote: x.vote === v ? undefined : v } : x)) as Msg[]
    );

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    setThinking(false);
    setMessages([{ id: nextId.current++, role: 'assistant', reply: welcome, time: '' }]);
  };

  const started = messages.length > 1;

  return (
    <div className="grid gap-4 p-5 lg:grid-cols-3 lg:p-6">
      {/* Chat */}
      <section className="card flex h-[calc(100vh-112px)] min-h-[520px] flex-col overflow-hidden lg:col-span-2">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-3">
            <BotAvatar />
            <div>
              <h1 className="text-[15px] font-bold text-ink">AI Business Assistant</h1>
              <p className="text-[11px] text-sub">
                <i className="mr-1 inline-block size-1.5 rounded-full bg-teal align-middle" />
                Answers from your store data · Anna Nagar
              </p>
            </div>
          </div>
          <button
            onClick={clear}
            disabled={!started}
            className="h-8 rounded-lg border border-line px-3 text-[12px] font-semibold text-ink hover:border-blue disabled:opacity-40"
          >
            New chat
          </button>
        </header>

        <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto bg-bg/60 px-4 py-5" aria-live="polite">
          {messages.map((m) =>
            m.role === 'user' ? <UserBubble key={m.id} msg={m} /> : <AssistantBubble key={m.id} msg={m} onVote={vote} />
          )}

          {!started && (
            <div className="grid gap-2 pl-11 sm:grid-cols-2">
              {suggestionGroups.flatMap((g) => g.questions.slice(0, 1)).map((s) => (
                <button
                  key={s}
                  onClick={() => ask(s)}
                  className="rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-ink hover:border-blue"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {thinking && (
            <div className="flex items-center gap-3">
              <BotAvatar />
              <div className="flex gap-1 rounded-2xl rounded-tl-md border border-line bg-surface px-4 py-3" aria-label="Assistant is typing">
                {[0, 150, 300].map((d) => (
                  <i key={d} className="size-1.5 animate-bounce rounded-full bg-mute" style={{ animationDelay: `${d}ms` }} />
                ))}
              </div>
            </div>
          )}
        </div>

        <form onSubmit={submit} className="border-t border-line p-3">
          <div className="flex items-end gap-2 rounded-xl border border-line bg-surface p-1.5 focus-within:border-blue">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Ask about sales, stock, suppliers or offers…"
              aria-label="Message"
              className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-ink outline-none placeholder:text-mute"
            />
            <button
              type="submit"
              disabled={!draft.trim() || thinking}
              className="h-9 rounded-lg gbv px-5 font-semibold text-onbrand disabled:opacity-50"
            >
              Ask
            </button>
          </div>
          <p className="mt-1.5 px-1 text-[11px] text-mute">
            Enter to send · Shift + Enter for a new line · Demo mode: answers come from built-in rules, not a live AI model.
          </p>
        </form>
      </section>

      {/* Side panels */}
      <aside className="space-y-3">
        <div className="card p-4">
          <h2 className="mb-1 text-[15px] font-bold text-ink">Today’s insights</h2>
          <p className="mb-3 text-[12px] text-sub">Tap one to ask about it</p>
          <div className="grid grid-cols-2 gap-2">
            {insights.map((i) => (
              <button
                key={i.label}
                onClick={() => ask(i.ask)}
                disabled={thinking}
                className="rounded-xl border border-line p-3 text-left hover:border-blue disabled:opacity-60"
              >
                <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${i.tone}`}>{i.label}</span>
                <div className="mt-2 text-[17px] font-extrabold tabular-nums text-ink">{i.value}</div>
                <div className="truncate text-[11px] text-mute">{i.note}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="card p-4">
          <h2 className="mb-3 text-[15px] font-bold text-ink">Things you can ask</h2>
          <div className="space-y-3">
            {suggestionGroups.map((g) => (
              <div key={g.title}>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-mute">{g.title}</div>
                <div className="flex flex-wrap gap-1.5">
                  {g.questions.map((s) => (
                    <button
                      key={s}
                      onClick={() => ask(s)}
                      disabled={thinking}
                      className="rounded-full bg-blue/10 px-3 py-1.5 text-left text-[12px] text-blue hover:bg-blue/20 disabled:opacity-60"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
