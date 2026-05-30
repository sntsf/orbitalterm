import { useEffect, useRef, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { browserOpen, browserSetBounds, browserClose } from "../../lib/commands";
import { useI18nStore } from "../../store/useI18nStore";
import type { Tab } from "../../types";

export function BrowserPane({ tab }: { tab: Tab }) {
  const { lang } = useI18nStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const connId = tab.connection_id;

    const sync = () => {
      // Defer to next animation frame so layout is fully settled before reading bounds
      requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const visible = r.width > 1 && r.height > 1;
        console.debug('[BrowserPane] bounds', Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), 'dpr', window.devicePixelRatio);
        if (!openedRef.current) {
          if (!visible) return;
          browserOpen(connId, r.x, r.y, r.width, r.height)
            .then(() => { openedRef.current = true; setError(null); })
            .catch(e => setError(String(e)));
        } else {
          browserSetBounds(connId, r.x, r.y, r.width, r.height).catch(console.error);
        }
      });
    };

    const ro = new ResizeObserver(sync);
    ro.observe(el);

    return () => {
      ro.disconnect();
      if (openedRef.current) {
        browserClose(connId).catch(console.error);
        openedRef.current = false;
      }
    };
  }, [tab.connection_id]);

  const retry = () => {
    openedRef.current = false;
    setError(null);
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    browserOpen(tab.connection_id, r.x, r.y, r.width, r.height)
      .then(() => { openedRef.current = true; })
      .catch(e => setError(String(e)));
  };

  const es = lang === "es";

  return (
    <div ref={containerRef} className="absolute inset-0">
      {error && (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--color-text-muted)]">
          <AlertCircle size={32} className="text-[var(--color-danger)]" />
          <p className="text-sm max-w-xs text-center">{error}</p>
          <button
            onClick={retry}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-sm font-medium transition-colors"
          >
            <RefreshCw size={14} />
            {es ? "Reintentar" : "Retry"}
          </button>
        </div>
      )}
    </div>
  );
}
