'use client';

import { useShopLogo } from '@/lib/shop-logo';
import { useBusinessProfile } from '@/lib/business-profile';

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'S';

/**
 * The shop's picture: its uploaded logo, or the store's initials until one is added
 * (Business profile → Shop logo).
 */
export function StoreAvatar({ className = 'size-10', rounded = 'rounded-full' }: { className?: string; rounded?: string }) {
  const logo = useShopLogo();
  const { displayName } = useBusinessProfile();
  if (logo)
    return (
      <span className={`${className} ${rounded} grid shrink-0 place-items-center overflow-hidden bg-white ring-1 ring-line`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a data URL kept on this computer */}
        <img src={logo} alt={`${displayName} logo`} className="size-full object-contain p-0.5" draggable={false} />
      </span>
    );
  return (
    <span
      className={`${className} ${rounded} grid shrink-0 place-items-center gbv text-[12px] font-bold text-onbrand`}
      title={displayName}
      aria-label={`${displayName} — no logo yet`}
    >
      {initialsOf(displayName)}
    </span>
  );
}
