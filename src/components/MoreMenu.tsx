'use client';

import Link from 'next/link';
import type { ComponentType } from 'react';
import { ChevronDown } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export type MoreItem = {
  label: string;
  icon?: ComponentType<{ className?: string }>;
  /** A short note under the label. */
  hint?: string;
  onSelect?: () => void;
  href?: string;
};

/**
 * Page header overflow: one main action stays visible, the occasional ones (import, export,
 * settings-like screens) go in here so headers stay short and never wrap.
 */
export function MoreMenu({ items, label = 'More' }: { items: (MoreItem | false | null | undefined)[]; label?: string }) {
  const list = items.filter((i): i is MoreItem => !!i);
  if (!list.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="card flex h-10 items-center gap-1.5 rounded-xl px-4 font-semibold">
          {label} <ChevronDown className="size-4 text-mute" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56 rounded-xl p-1.5 text-[13px]">
        {list.map((i) => {
          const Icon = i.icon;
          const body = (
            <>
              {Icon && <Icon className="size-4 shrink-0 text-sub" />}
              <span className="min-w-0">
                <span className="block">{i.label}</span>
                {i.hint && <span className="block text-[11px] text-mute">{i.hint}</span>}
              </span>
            </>
          );
          return i.href ? (
            <DropdownMenuItem key={i.label} asChild className="gap-2.5 py-2">
              <Link href={i.href}>{body}</Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem key={i.label} onSelect={i.onSelect} className="gap-2.5 py-2">
              {body}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
