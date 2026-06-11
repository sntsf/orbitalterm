import { useEffect, useRef, useState } from "react";
import { AlertTriangle, X, Bell } from "lucide-react";
import { useNotifStore } from "../../store/useNotifStore";
import { useI18nStore } from "../../store/useI18nStore";
import { friendlyConnErrorNotif } from "../../lib/connErrors";

const AUTO_HIDE_MS = 20_000;

export function NotificationOverlay() {
  const { notifs } = useNotifStore();
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

  useEffect(() => {
    if (notifs.length > prevCountRef.current) startTimer();
    prevCountRef.current = notifs.length;
  }, [notifs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  if (notifs.length === 0) return null;

  const latest = notifs[0];
  const friendly = friendlyConnErrorNotif(latest.raw, lang, latest.connType);
  const tabLabel = lang === "es" ? "Notificaciones" : "Notifications";
  const timeStr = new Date(latest.ts).toLocaleTimeString(
    lang === "es" ? "es-ES" : "en-US",
    { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  );

  return (
    <>
      {/* ── Full notification bar ── */}
      {showToast && (
        <div className="absolute bottom-0 left-0 right-0 z-50 bg-[var(--color-bg-elevated)] border-t border-[var(--color-warning)]/40 shadow-2xl">
          <ProgressBar key={progressKey} durationMs={AUTO_HIDE_MS} />

          <div className="flex items-start gap-3 px-4 py-3">
            <AlertTriangle size={18} className="text-[var(--color-warning)] shrink-0 mt-0.5" />

            <div className="flex flex-col gap-1 flex-1 min-w-0">
              {/* Top row: label · connection identity · time · close */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-semibold text-[var(--color-warning)] shrink-0">
                  {lang === "es" ? "Error de conexión" : "Connection error"}
                </span>
                <div className="w-px h-4 bg-[var(--color-border)] shrink-0" />
                <span className="text-[13px] font-semibold text-[var(--color-text-primary)] shrink-0">
                  {latest.connName}
                </span>
                <span className="text-[10px] uppercase font-mono bg-[var(--color-bg-base)] text-[var(--color-text-muted)] px-1.5 py-0.5 rounded shrink-0">
                  {latest.connType}
                </span>
                {latest.host && (
                  <span className="text-[12px] text-[var(--color-text-muted)] shrink-0">
                    {latest.host}
                  </span>
                )}
                <div className="flex-1" />
                <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{timeStr}</span>
                {notifs.length > 1 && (
                  <span className="text-[10px] bg-[var(--color-bg-base)] border border-[var(--color-border)] text-[var(--color-text-muted)] px-1.5 py-px rounded shrink-0">
                    +{notifs.length - 1}
                  </span>
                )}
                <button
                  onClick={closeToast}
                  className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
                  title={lang === "es" ? "Cerrar" : "Close"}
                >
                  <X size={14} />
                </button>
              </div>

              {/* Error detail — up to 2 lines with line-break support */}
              <span className="text-[12px] text-[var(--color-text-muted)] whitespace-pre-line leading-snug">
                {friendly}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Small persistent tab when bar is hidden ── */}
      {!showToast && (
        <button
          onClick={startTimer}
          className="absolute bottom-0 right-6 z-50 flex items-center gap-1.5 px-3 py-1 rounded-t text-[12px] font-medium border border-b-0 shadow-md transition-colors bg-[var(--color-warning)]/15 border-[var(--color-warning)]/40 text-[var(--color-warning)] hover:bg-[var(--color-warning)]/25"
          title={lang === "es" ? "Ver notificación" : "Show notification"}
        >
          <Bell size={12} />
          <span>{tabLabel}</span>
          <span className="bg-[var(--color-warning)] text-black text-[9px] font-bold px-1.5 py-px rounded-full leading-none">
            {notifs.length}
          </span>
        </button>
      )}
    </>
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
