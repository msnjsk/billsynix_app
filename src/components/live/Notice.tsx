'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';

/** A short message at the bottom of the screen (same look as the Branches toast). */
export function useNotice() {
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null);
  const timer = useRef(0);
  const show = useCallback((text: string, bad = false) => {
    setNotice({ text, bad });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNotice(null), bad ? 6000 : 3000);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const node = notice ? (
    <div
      role={notice.bad ? 'alert' : 'status'}
      className={`fixed bottom-6 left-1/2 z-[60] flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-2xl px-4 py-2.5 font-semibold text-onbrand shadow-2xl animate-in fade-in slide-in-from-bottom-3 ${notice.bad ? 'bg-coral' : 'bg-side'}`}
    >
      {notice.bad ? <TriangleAlert className="size-4 shrink-0" /> : <CircleCheck className="size-4 shrink-0 text-teal" />} {notice.text}
    </div>
  ) : null;
  return [node, show] as const;
}
