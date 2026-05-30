import { useEffect, useRef, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { browserOpen, browserSetPosition, browserClose } from "../../lib/commands";
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
      const r = el.getBoundingClientRect();
      const visible = r.width > 1 && r.height > 1;

      if (!openedRef.current) {
        if (!visible) return;
        browserOpen(connId, r.x, r.y, r.width, r.height)
          .then(() => {
            openedRef.current = true;
            setError(null);
          })
          .catch((e: unknown) => setError(String(e)));
      } else {
        browserSetPosition(connId, r.x, r.y, r.width, r.height, visible).catch(console.error);
      }
    };

    const ro = new ResizeObserver(() => { sync(); });
    ro.observe(el);

    // Also reposition when the main window moves.
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onMoved(() => { sync(); }).then(fn => { unlisten = fn; });

    return () => {
      ro.disconnect();
      unlisten?.();
      if (openedRef.current) {
        browserClose(connId).catch(console.error);
        openedRef.current = false;
      }
    };
  }, [tab.connection_id]);

  const es = lang === "es";

  return (
    <div ref={containerRef} className="absolute inset-0">
      {error && (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--color-text-muted)]">
          <AlertCircle size={32} className="text-[var(--color-danger)]" />
          <p className="text-sm max-w-xs text-center">{error}</p>
          <button
            onClick={() => { openedRef.current = false; setError(null); }}
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
