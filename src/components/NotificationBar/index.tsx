import { useEffect, useRef, useState } from "react";
import { AlertTriangle, X, ChevronUp, ChevronDown, Trash2 } from "lucide-react";
import { useNotifStore, type Notif } from "../../store/useNotifStore";
import { useI18nStore } from "../../store/useI18nStore";
import { friendlyConnError } from "../../lib/connErrors";

export function NotificationBar() {
  const { notifs, dismiss, clearAll } = useNotifStore();
  const { lang } = useI18nStore();
  const [expanded, setExpanded] = useState(false);
  const prevCount = useRef(0);

  // Auto-expand when a new notification arrives
  useEffect(() => {
    if (notifs.length > prevCount.current) {
      setExpanded(true);
    }
    prevCount.current = notifs.length;
  }, [notifs.length]);

  if (notifs.length === 0) return null;

  const latest = notifs[0];
  const label = lang === "es" ? "Notificaciones" : "Notifications";
  const clearLabel = lang === "es" ? "Limpiar todo" : "Clear all";

  return (
    <div className="shrink-0 border-t border-[var(--color-warning)]/30 bg-[var(--color-bg-elevated)]">
      {/* Slim header bar — always visible */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <AlertTriangle size={13} className="text-[var(--color-warning)] shrink-0" />
        <span className="text-[12px] font-semibold text-[var(--color-warning)] shrink-0">
          {label}
          {notifs.length > 1 && (
            <span className="ml-1 opacity-70 text-[11px]">({notifs.length})</span>
          )}
        </span>
        <span className="text-[12px] text-[var(--color-text-muted)] truncate flex-1 ml-1">
          — <span className="font-medium text-[var(--color-text-primary)]">{latest.connName}</span>
          {" · "}
          {friendlyConnError(latest.raw, lang)}
        </span>
        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              clearAll();
              setExpanded(false);
            }}
            className="p-0.5 rounded hover:text-[var(--color-danger)] text-[var(--color-text-muted)] transition-colors"
            title={clearLabel}
          >
            <Trash2 size={12} />
          </span>
          {expanded
            ? <ChevronDown size={12} className="text-[var(--color-text-muted)]" />
            : <ChevronUp size={12} className="text-[var(--color-text-muted)]" />}
        </div>
      </button>

      {/* Expanded notification list */}
      {expanded && (
        <div className="max-h-48 overflow-y-auto border-t border-[var(--color-border)]">
          {notifs.map((n) => (
            <NotifRow key={n.id} notif={n} lang={lang} onDismiss={() => dismiss(n.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function NotifRow({
  notif, lang, onDismiss,
}: {
  notif: Notif;
  lang: "es" | "en";
  onDismiss: () => void;
}) {
  const friendly = friendlyConnError(notif.raw, lang);
  const timeStr = new Date(notif.ts).toLocaleTimeString(
    lang === "es" ? "es-ES" : "en-US",
    { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  );

  return (
    <div className="flex items-start gap-2.5 px-3 py-2 border-b border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] group">
      <AlertTriangle size={13} className="text-[var(--color-warning)] shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
          <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">
            {notif.connName}
          </span>
          <span className="text-[10px] uppercase font-mono text-[var(--color-text-muted)] bg-[var(--color-bg-base)] px-1 rounded">
            {notif.connType}
          </span>
          {notif.host && (
            <span className="text-[11px] text-[var(--color-text-muted)]">{notif.host}</span>
          )}
          <span className="text-[11px] text-[var(--color-text-muted)] ml-auto">{timeStr}</span>
        </div>
        <p className="text-[12px] text-[var(--color-text-muted)] leading-snug">{friendly}</p>
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] opacity-0 group-hover:opacity-100 transition-all mt-0.5"
        title={lang === "es" ? "Descartar" : "Dismiss"}
      >
        <X size={12} />
      </button>
    </div>
  );
}
