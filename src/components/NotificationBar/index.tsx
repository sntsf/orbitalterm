import { useEffect, useRef, useState } from "react";
import { AlertTriangle, X, Bell } from "lucide-react";
import { useNotifStore } from "../../store/useNotifStore";
import { useI18nStore } from "../../store/useI18nStore";
import { friendlyConnError } from "../../lib/connErrors";

const AUTO_HIDE_MS = 20_000;

export function NotificationOverlay() {
  const { notifs, dismiss } = useNotifStore();
  const { lang } = useI18nStore();
  const [showToast, setShowToast] = useState(false);
  const [progressKey, setProgressKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCountRef = useRef(0);

  const startTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setShowToast(false), AUTO_HIDE_MS);
    setProgressKey((k) => k + 1);
    setShowToast(true);
  };

  const closeToast = () => {
    setShowToast(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  // Auto-show when a new notification arrives
  useEffect(() => {
    if (notifs.length > prevCountRef.current) startTimer();
    prevCountRef.current = notifs.length;
  }, [notifs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  if (notifs.length === 0) return null;

  const latest = notifs[0];
  const friendly = friendlyConnError(latest.raw, lang);
  const tabLabel = lang === "es" ? "Notificaciones" : "Notifications";

  return (
    <>
      {/* Floating toast — absolute over content, does NOT affect layout */}
      {showToast && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-50 w-full max-w-md px-4 pointer-events-none">
          <div className="pointer-events-auto bg-[var(--color-bg-elevated)] border border-[var(--color-warning)]/50 rounded-lg shadow-2xl overflow-hidden">

            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 bg-[var(--color-warning)]/10 border-b border-[var(--color-warning)]/20">
              <AlertTriangle size={13} className="text-[var(--color-warning)] shrink-0" />
              <span className="text-[13px] font-semibold text-[var(--color-warning)] flex-1">
                {lang === "es" ? "Error de conexión" : "Connection error"}
              </span>
              <span className="text-[11px] text-[var(--color-text-muted)] mr-1">
                {new Date(latest.ts).toLocaleTimeString(lang === "es" ? "es-ES" : "en-US", {
                  hour: "2-digit", minute: "2-digit", second: "2-digit",
                })}
              </span>
              <button
                onClick={closeToast}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
              >
                <X size={13} />
              </button>
            </div>

            {/* Body */}
            <div className="px-3 py-2.5">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">
                  {latest.connName}
                </span>
                <span className="text-[10px] uppercase font-mono bg-[var(--color-bg-base)] text-[var(--color-text-muted)] px-1.5 py-0.5 rounded">
                  {latest.connType}
                </span>
                {latest.host && (
                  <span className="text-[12px] text-[var(--color-text-muted)]">{latest.host}</span>
                )}
              </div>
              <p className="text-[12px] text-[var(--color-text-muted)] leading-snug">{friendly}</p>

              {/* Previous count hint */}
              {notifs.length > 1 && (
                <button
                  onClick={() => dismiss(latest.id)}
                  className="mt-2 text-[11px] text-[var(--color-accent)] hover:underline"
                >
                  {lang === "es"
                    ? `+ ${notifs.length - 1} notificación(es) anterior(es)`
                    : `+ ${notifs.length - 1} earlier notification(s)`}
                </button>
              )}
            </div>

            {/* Countdown progress bar */}
            <ProgressBar key={progressKey} durationMs={AUTO_HIDE_MS} />
          </div>
        </div>
      )}

      {/* Persistent small tab at bottom — always visible when there are notifications */}
      <button
        onClick={() => (showToast ? closeToast() : startTimer())}
        className={[
          "absolute bottom-0 right-6 z-50 flex items-center gap-1.5 px-3 py-1",
          "rounded-t text-[12px] font-medium border border-b-0 shadow-md transition-colors",
          showToast
            ? "bg-[var(--color-bg-elevated)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"
            : "bg-[var(--color-warning)]/15 border-[var(--color-warning)]/40 text-[var(--color-warning)] hover:bg-[var(--color-warning)]/25",
        ].join(" ")}
        title={showToast
          ? (lang === "es" ? "Ocultar" : "Hide")
          : (lang === "es" ? "Ver notificación" : "Show notification")}
      >
        <Bell size={12} />
        <span>{tabLabel}</span>
        <span className="bg-[var(--color-warning)] text-black text-[9px] font-bold px-1.5 py-px rounded-full leading-none">
          {notifs.length}
        </span>
      </button>
    </>
  );
}

// ── Progress bar: shrinks from 100% → 0% over durationMs ─────────────────────

function ProgressBar({ durationMs }: { durationMs: number }) {
  const [width, setWidth] = useState(100);

  useEffect(() => {
    // Defer to next tick so the CSS transition fires after the first paint
    const t = setTimeout(() => setWidth(0), 30);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="h-0.5 bg-[var(--color-border)]">
      <div
        className="h-full bg-[var(--color-warning)] origin-left"
        style={{
          width: `${width}%`,
          transition: width === 0 ? `width ${durationMs}ms linear` : "none",
        }}
      />
    </div>
  );
}
