'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import { inr } from '@/lib/store-data';
import type { SalesPoint } from '@/lib/dashboard-data';

const axisTick = { fill: 'var(--mute)', fontSize: 11 };

const lakh = (n: number) => {
  if (n === 0) return '0';
  if (n >= 100000) return `₹${+(n / 100000).toFixed(1)}L`;
  return `₹${Math.round(n / 1000)}K`;
};

function SalesTooltip({ active, payload }: TooltipProps<number, string>) {
  const p = payload?.[0]?.payload as (SalesPoint & { title: string }) | undefined;
  if (!active || !p) return null;
  return (
    <div className="card shadow-lg px-3 py-2.5 text-[12px] min-w-[170px]">
      <div className="font-bold text-ink mb-1.5">{p.title}</div>
      <Row label="Revenue" value={inr(p.revenue)} />
      <Row label="Profit" value={inr(p.profit)} tone="text-teal" />
      <Row label="Previous" value={inr(p.previous)} />
    </div>
  );
}

function Row({ label, value, tone = 'text-ink' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-4 leading-5">
      <span className="text-sub">{label}</span>
      <b className={`tabular-nums ${tone}`}>{value}</b>
    </div>
  );
}

export function SalesPerformanceChart({ data }: { data: (SalesPoint & { title: string })[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 10, right: 8, left: -4, bottom: 0 }}>
        <CartesianGrid stroke="var(--line)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={axisTick}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: string, i: number) =>
            i === 0 || i === data.length - 1 ? v : v.replace(/ \w+$/, '')
          }
          interval={data.length > 10 ? 1 : 0}
        />
        <YAxis tickFormatter={lakh} tick={axisTick} axisLine={false} tickLine={false} width={48} />
        <Tooltip
          content={<SalesTooltip />}
          cursor={{ stroke: 'var(--blue)', strokeWidth: 1.5, strokeDasharray: '3 3' }}
        />
        <Line
          type="monotone"
          dataKey="previous"
          stroke="var(--mute)"
          strokeWidth={1.5}
          strokeDasharray="6 5"
          dot={false}
          activeDot={false}
        />
        <Line
          type="monotone"
          dataKey="profit"
          stroke="var(--teal)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: 'var(--surface)', stroke: 'var(--teal)', strokeWidth: 2 }}
        />
        <Line
          type="monotone"
          dataKey="revenue"
          stroke="var(--blue)"
          strokeWidth={2.5}
          dot={false}
          activeDot={{ r: 6, fill: 'var(--surface)', stroke: 'var(--blue)', strokeWidth: 3 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function PaymentDonut({
  data,
  center,
}: {
  data: { method: string; amount: number; color: string }[];
  center: string;
}) {
  return (
    <div className="relative size-[96px] shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="amount"
            nameKey="method"
            innerRadius={32}
            outerRadius={47}
            startAngle={90}
            endAngle={-270}
            stroke="none"
            isAnimationActive={false}
          >
            {data.map((d) => (
              <Cell key={d.method} fill={d.color} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 grid place-items-center font-extrabold text-[15px] text-ink">
        {center}
      </div>
    </div>
  );
}

/** Tiny trend line used on KPI cards and the hero banner. */
export function Sparkline({
  points,
  color,
  width = 40,
  height = 14,
  fill,
}: {
  points: number[];
  color: string;
  width?: number;
  height?: number;
  fill?: string;
}) {
  // A line needs two points (a new business has no history yet).
  if (points.length < 2) return <svg width={width} height={height} aria-hidden />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const line = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - 1 - ((p - min) / span) * (height - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {fill && <polygon points={`0,${height} ${line} ${width},${height}`} fill={fill} />}
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Vertical bars for sales by hour; the busiest hour is highlighted. */
export function HourlyBars({ data }: { data: { hour: string; sales: number }[] }) {
  const peak = Math.max(...data.map((d) => d.sales));
  return (
    <ResponsiveContainer width="100%" height={190}>
      <BarChart data={data} margin={{ top: 4, right: 0, left: -24, bottom: 0 }}>
        <XAxis dataKey="hour" tick={axisTick} axisLine={false} tickLine={false} interval={1} />
        <YAxis hide />
        <Tooltip
          cursor={{ fill: 'var(--line)' }}
          contentStyle={{
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            fontSize: 12,
            color: 'var(--ink)',
          }}
          formatter={(v: number) => [inr(v), 'Avg sales']}
        />
        <Bar dataKey="sales" radius={[6, 6, 0, 0]}>
          {data.map((d) => (
            <Cell
              key={d.hour}
              fill={d.sales === peak ? 'var(--vio)' : 'var(--blue)'}
              fillOpacity={d.sales === peak ? 1 : 0.45}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
