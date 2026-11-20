/**
 * Rule-based stand-in for the AI assistant. Answers come from the app's mock data,
 * so they stay consistent with the other pages. Swap `respond` for an API call
 * (e.g. a route handler that calls an LLM) once a backend exists.
 */
import { answer, inr, products } from '@/lib/store-data';
import { payments } from '@/lib/dashboard-data';
import { avgHourly, cashiers } from '@/lib/sales-data';
import { daysOfCover, expiringBatches, inventoryItems, statusOf, suggestedOrder } from '@/lib/inventory-data';
import { dueLabel, dueState, initialSuppliers } from '@/lib/suppliers-data';

export type ReplyRow = { label: string; value: string; tone?: 'good' | 'warn' | 'bad' };
export type ReplyAction = { label: string; href: string };
export type Reply = { text: string; rows?: ReplyRow[]; actions?: ReplyAction[]; topic: string };

const hourLabel = (h: string) => h.replace('a', ' AM').replace('p', ' PM');

type Topic = { test: RegExp; reply: (q: string) => Reply };

const topics: Topic[] = [
  {
    // Before "payment methods" so "supplier payments" lands here.
    test: /supplier|vendor|\bowe\b|\bowed\b|overdue|\bdues?\b|payable/,
    reply: () => {
      const owing = initialSuppliers.filter((s) => s.due > 0);
      const total = owing.reduce((s, x) => s + x.due, 0);
      const overdue = owing.filter((s) => dueState(s) === 'overdue');
      return {
        topic: 'Suppliers',
        text: `You owe ${inr(total)} to ${owing.length} suppliers.${
          overdue.length ? ` ${overdue.map((s) => s.name).join(', ')} ${overdue.length === 1 ? 'is' : 'are'} overdue — clear that first to protect your credit terms.` : ''
        }`,
        rows: owing
          .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
          .map((s) => ({
            label: s.name,
            value: `${inr(s.due)} · ${dueLabel(s)}`,
            tone: dueState(s) === 'overdue' ? 'bad' : dueState(s) === 'soon' ? 'warn' : undefined,
          }))
          .map(({ tone, ...r }) => (tone ? { ...r, tone } : r)),
        actions: [{ label: 'Open suppliers', href: '/suppliers' }],
      };
    },
  },
  {
    test: /reorder|restock|\blow\b|stock|run(ning)? out/,
    reply: () => {
      const low = inventoryItems
        .filter((i) => statusOf(i) !== 'ok')
        .sort((a, b) => daysOfCover(a) - daysOfCover(b));
      const first = low[0];
      return {
        topic: 'Inventory',
        text: `${low.length} products need reordering this week.${
          first
            ? ` ${first.name} is the most urgent — ${first.stock} left, about ${Math.max(1, Math.floor(daysOfCover(first)))} day of sales.`
            : ''
        } Suggested quantities cover the next 14 days.`,
        rows: low.map((i) => ({
          label: i.name,
          value: `${i.stock} left · order ${suggestedOrder(i)}`,
          tone: statusOf(i) === 'ok' ? 'good' : statusOf(i) === 'low' ? 'warn' : 'bad',
        })),
        actions: [
          { label: 'Open inventory', href: '/inventory' },
          { label: 'Order from suppliers', href: '/suppliers' },
        ],
      };
    },
  },
  {
    test: /expir|wastage|waste|fresh/,
    reply: () => ({
      topic: 'Inventory',
      text: `${expiringBatches.length} batches expire within 7 days. Put the 1–2 day items at the counter or bundle them in an evening offer.`,
      rows: expiringBatches.map((b) => ({
        label: `${b.name} (#${b.batch})`,
        value: `${b.qty} units · ${b.days} ${b.days === 1 ? 'day' : 'days'}`,
        tone: b.days <= 2 ? 'bad' : 'warn',
      })),
      actions: [{ label: 'Open inventory', href: '/inventory' }],
    }),
  },
  {
    test: /\bupi\b|\bcash\b|\bcards?\b|payment method|how .*\bpay(ing)?\b/,
    reply: () => {
      const total = payments.reduce((s, p) => s + p.amount, 0);
      return {
        topic: 'Sales',
        text: `UPI is your biggest payment method today. Card payments carry MDR fees, so nudging regulars toward UPI keeps more margin.`,
        rows: payments.map((p) => ({ label: p.method, value: `${inr(p.amount)} · ${Math.round((p.amount / total) * 100)}%` })),
        actions: [{ label: 'Open sales', href: '/sales' }],
      };
    },
  },
  {
    test: /cashier|staff|counter|employee/,
    reply: () => ({
      topic: 'Sales',
      text: `${cashiers[0]?.name} handled the most bills today. Average bill value is similar across counters, so the gap is footfall, not upselling.`,
      rows: cashiers.map((c) => ({
        label: `${c.name} (${c.counter})`,
        value: `${c.bills} bills · ${inr(c.revenue)}`,
      })),
      actions: [{ label: 'Open sales', href: '/sales' }],
    }),
  },
  {
    test: /peak|busy|rush|hour|when/,
    reply: (q) => {
      const top = [...avgHourly].sort((a, b) => b.sales - a.sales).slice(0, 3);
      const quiet = [...avgHourly].sort((a, b) => a.sales - b.sales)[0];
      return {
        topic: 'Sales',
        text: `${/dairy|offer/.test(q) ? answer(q) + ' ' : ''}Your busiest hours are ${top
          .map((h) => hourLabel(h.hour))
          .join(', ')}. The quietest is ${quiet ? hourLabel(quiet.hour) : '—'} — a good time for restocking shelves.`,
        rows: top.map((h) => ({ label: hourLabel(h.hour), value: `${inr(h.sales)} avg / hour` })),
        actions: [{ label: 'Open sales', href: '/sales' }],
      };
    },
  },
  {
    test: /dairy|offer|discount|promo/,
    reply: (q) => ({
      topic: 'Marketing',
      text: answer(q),
      rows: products
        .filter((p) => p.category === 'Dairy')
        .map((p) => ({ label: p.name, value: `${p.units} sold · ${p.stock} in stock` })),
      actions: [{ label: 'Open products', href: '/products' }],
    }),
  },
  {
    test: /best|top|sell|popular/,
    reply: (q) => {
      const top = [...products].sort((a, b) => b.units * b.price - a.units * a.price).slice(0, 5);
      return {
        topic: 'Products',
        text: answer(q),
        rows: top.map((p) => ({
          label: p.name,
          value: `${inr(p.units * p.price)} · ${p.trend >= 0 ? '▲' : '▼'} ${Math.abs(p.trend)}%`,
          tone: p.trend >= 0 ? 'good' : 'bad',
        })),
        actions: [{ label: 'Open products', href: '/products' }],
      };
    },
  },
  {
    test: /sunday|dip|profit|margin|drop/,
    reply: (q) => ({ topic: 'Sales', text: answer(q), actions: [{ label: 'Open sales', href: '/sales' }] }),
  },
  {
    test: /revenue|sales|today|target|order/,
    reply: (q) => ({ topic: 'Sales', text: answer(q), actions: [{ label: 'Open sales', href: '/sales' }] }),
  },
];

export function respond(question: string): Reply {
  const q = question.toLowerCase();
  const topic = topics.find((t) => t.test.test(q));
  return topic ? topic.reply(q) : { topic: 'Help', text: answer(q) };
}

export const suggestionGroups = [
  {
    title: 'Stock',
    questions: ['Which products should I reorder this week?', 'What is expiring soon?'],
  },
  {
    title: 'Sales',
    questions: ["How are today's sales?", 'Why did profit dip on Sunday?', 'What are my busiest hours?'],
  },
  {
    title: 'Products & offers',
    questions: ['What are my top selling products?', 'Best time to run a dairy offer?'],
  },
  {
    title: 'Money',
    questions: ['Which suppliers do I owe?', 'How are customers paying today?', 'How are my cashiers doing?'],
  },
];
