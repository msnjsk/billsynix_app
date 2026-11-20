/**
 * The BillSynix logos, exactly as supplied (only scaled): <BrandLogo> has white "Bill" lettering
 * and the slogan, for dark backgrounds; <BrandBadge> is the dark-lettered version for light ones.
 */
export const APP_NAME = 'BillSynix';
export const APP_SLOGAN = 'Smart Billing. Smarter Business.';

/** The full logo. Size it by height (e.g. "h-12"); the width follows. Dark backgrounds only. */
export function BrandLogo({ className = 'h-12' }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a static asset, shown above the fold
    <img
      src="/brand/logo-full.png"
      alt={`${APP_NAME} — ${APP_SLOGAN}`}
      width={1200}
      height={409}
      className={`${className} w-auto max-w-none shrink-0 object-contain`}
      draggable={false}
    />
  );
}

/**
 * The light-background version (dark "Bill" lettering, no slogan), exactly as supplied. It has a
 * white background of its own, so it sits on a white rounded card wherever the page isn't white.
 */
export function BrandBadge({ className = 'h-9', padding = 'px-2 py-1' }: { className?: string; padding?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-xl bg-white ${padding}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a static asset */}
      <img
        src="/brand/logo-light.png"
        alt={APP_NAME}
        width={1200}
        height={266}
        className={`${className} w-auto max-w-none object-contain`}
        draggable={false}
      />
    </span>
  );
}
