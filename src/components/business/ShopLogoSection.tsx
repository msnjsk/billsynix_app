'use client';

import { useRef, useState } from 'react';
import { ImagePlus, LoaderCircle, Store, Trash2, Upload } from 'lucide-react';
import { StoreAvatar } from '@/components/brand/StoreAvatar';
import { errorMessage } from '@/lib/api/client';
import { can, isLive } from '@/lib/live/session';
import { logoProblem, removeShopLogo, setShopLogo, useShopLogo } from '@/lib/shop-logo';

/**
 * Business profile → Shop logo. Saved as soon as it's picked (separately from the profile form),
 * and shown as the shop's picture across the app.
 */
export function ShopLogoSection() {
  const logo = useShopLogo();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const allowed = !isLive() || can('tenant:update');

  const pick = async (file: File | undefined) => {
    if (!file) return;
    const problem = logoProblem(file);
    if (problem) return setMsg({ ok: false, text: problem });
    setBusy('upload');
    setMsg(null);
    try {
      await setShopLogo(file);
      setMsg({ ok: true, text: isLive() ? 'Logo saved — every computer of the business shows it.' : 'Logo saved.' });
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  };

  const remove = async () => {
    setBusy('remove');
    setMsg(null);
    try {
      await removeShopLogo();
      setMsg({ ok: true, text: 'Logo removed — the store’s initials show instead.' });
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-blue/10 text-blue">
          <Store className="size-[18px]" />
        </span>
        <div>
          <h2 className="text-[15px] font-bold text-ink">Shop logo</h2>
          <p className="mt-0.5 text-[12px] text-sub">Your shop&apos;s picture across the app — the profile picture in the sidebar and top bar.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-5">
        <button
          type="button"
          disabled={!allowed || !!busy}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            if (allowed) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (allowed) void pick(e.dataTransfer.files[0]);
          }}
          aria-label={logo ? 'Change the shop logo' : 'Upload a shop logo'}
          className={`group relative grid size-28 shrink-0 place-items-center rounded-2xl border-2 border-dashed transition disabled:cursor-default ${
            dragging ? 'border-blue bg-blue/5' : 'border-line hover:border-blue/50'
          }`}
        >
          {busy === 'upload' ? (
            <LoaderCircle className="size-6 animate-spin text-blue" />
          ) : logo ? (
            <StoreAvatar className="size-24" rounded="rounded-xl" />
          ) : (
            <span className="flex flex-col items-center gap-1 text-[11px] font-semibold text-mute group-hover:text-blue">
              <ImagePlus className="size-6" /> Add logo
            </span>
          )}
        </button>

        <div className="min-w-[220px] flex-1 space-y-2 text-[12.5px]">
          {allowed ? (
            <>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => input.current?.click()}
                  className="flex h-9 items-center gap-1.5 rounded-xl gbv px-4 font-semibold text-onbrand disabled:opacity-50"
                >
                  <Upload className="size-4" /> {logo ? 'Change logo' : 'Upload logo'}
                </button>
                {logo && (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => void remove()}
                    className="flex h-9 items-center gap-1.5 rounded-xl border border-line px-3 font-semibold text-sub hover:border-coral hover:text-coral disabled:opacity-50"
                  >
                    {busy === 'remove' ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Remove
                  </button>
                )}
              </div>
              <p className="text-mute">PNG, JPG or WebP. A square logo on a clear or white background looks best. Drop a file on the box, or click to pick one.</p>
            </>
          ) : (
            <p className="text-sub">Only the owner or an admin can change the shop logo.</p>
          )}
          {msg && <p className={`font-semibold ${msg.ok ? 'text-teal' : 'text-coral'}`}>{msg.text}</p>}
        </div>
      </div>

      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
    </section>
  );
}
