import { useEffect, useRef, useState } from "react";
import { AlertTriangle, X, ChevronDown, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { useNotifStore } from "../../store/useNotifStore";
import { useI18nStore } from "../../store/useI18nStore";
import { friendlyConnErrorNotif } from "../../lib/connErrors";

const AUTO_HIDE_MS = 20_000;

export function NotificationOverlay() {
  const { notifs, dismiss, clearAll, expanded, show, hide } = useNotifStore();
  const { lang } = useI18nStore();
  const [progressKey, setProgressKey] = useState(0);
  const [idx, setIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCountRef = useRef(0);

  const startTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => hide(), AUTO_HIDE_MS);
    setProgressKey((k) => k + 1);
    show();
  };

  const minimize = () => {
    hide();
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  // New notification arrived → jump to it and restart timer
  useEffect(() => {
    if (notifs.length > prevCountRef.current) {
      setIdx(0);
      startTimer();
    }
    prevCountRef.current = notifs.length;
  }, [notifs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep idx in bounds; hide bar when all dismissed
  useEffect(() => {
    if (notifs.length === 0) { hide(); return; }
    setIdx((i) => Math.min(i, notifs.length - 1));
  }, [notifs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // Only render when expanded — the minimized state lives in the TabBar badge
  if (!expanded || notifs.length === 0) return null;

  const safeIdx = Math.min(idx, notifs.length - 1);
  const current = notifs[safeIdx];
  const friendly = friendlyConnErrorNotif(current.raw, lang, current.connType);
  const timeStr = new Date(current.ts).toLocaleTimeString(
    lang === "es" ? "es-ES" : "en-US",
    { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  );

  const goPrev = () => setIdx((i) => Math.max(0, i - 1));
  const goNext = () => setIdx((i) => Math.min(notifs.length - 1, i + 1));

  return (
    <div className="absolute bottom-0 left-0 right-0 z-50 bg-[var(--color-bg-elevated)] border-t border-[var(--color-warning)]/40 shadow-2xl">
      <ProgressBar key={progressKey} durationMs={AUTO_HIDE_MS} />

      <div className="flex items-start gap-3 px-4 py-3">
        <AlertTriangle size={18} className="text-[var(--color-warning)] shrink-0 mt-0.5" />

        <div className="flex flex-col gap-1 flex-1 min-w-0">
          {/* Top row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-semibold text-[var(--color-warning)] shrink-0">
              {lang === "es" ? "Error de conexión" : "Connection error"}
            </span>
            <div className="w-px h-4 bg-[var(--color-border)] shrink-0" />
            <span className="text-[13px] font-semibold text-[var(--color-text-primary)] shrink-0">
              {current.connName}
            </span>
            <span className="text-[10px] uppercase font-mono bg-[var(--color-bg-base)] text-[var(--color-text-muted)] px-1.5 py-0.5 rounded shrink-0">
              {current.connType}
            </span>
            {current.host && (
              <span className="text-[12px] text-[var(--color-text-muted)] shrink-0">
                {current.host}
              </span>
            )}
            <div className="flex-1" />
            <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{timeStr}</span>

            {/* Prev / counter / next */}
            {notifs.length > 1 && (
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  onClick={goPrev}
                  disabled={safeIdx === 0}
                  className="p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30 transition-colors"
                  title={lang === "es" ? "Anterior" : "Previous"}
                >
                  <ChevronLeft size={13} />
                </button>
                <span className="text-[10px] text-[var(--color-text-muted)] font-mono px-0.5 tabular-nums">
                  {safeIdx + 1}/{notifs.length}
                </span>
                <button
                  onClick={goNext}
                  disabled={safeIdx === notifs.length - 1}
                  className="p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30 transition-colors"
                  title={lang === "es" ? "Siguiente" : "Next"}
                >
                  <ChevronRight size={13} />
                </button>
              </div>
            )}

            {/* Minimize — collapses bar, badge stays in TabBar */}
            <button
              onClick={minimize}
              className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
              title={lang === "es" ? "Minimizar" : "Minimize"}
            >
              <ChevronDown size={15} />
            </button>

            {/* Dismiss current */}
            <button
              onClick={() => dismiss(current.id)}
              className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
              title={lang === "es" ? "Descartar esta" : "Dismiss this"}
            >
              <X size={14} />
            </button>

            {/* Clear all */}
            <button
              onClick={clearAll}
              className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
              title={lang === "es" ? "Limpiar todas" : "Clear all"}
            >
              <Trash2 size={13} />
            </button>
          </div>

          {/* Error detail */}
          <span className="text-[12px] text-[var(--color-text-muted)] whitespace-pre-line leading-snug">
            {friendly}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Countdown progress bar ────────────────────────────────────────────────────

function ProgressBar({ durationMs }: { durationMs: number }) {
  const [width, setWidth] = useState(100);

  useEffect(() => {
    const t = setTimeout(() => setWidth(0), 30);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="h-0.5 bg-[var(--color-border)]">
      <div
        className="h-full bg-[var(--color-warning)]"
        style={{
          width: `${width}%`,
          transition: width === 0 ? `width ${durationMs}ms linear` : "none",
        }}
      />
    </div>
  );
}
