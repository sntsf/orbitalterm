import { useEffect, useState } from "react";
import { Globe, ExternalLink, RefreshCw, AlertCircle } from "lucide-react";
import { browserOpen, browserClose } from "../../lib/commands";
import { useNotifStore } from "../../store/useNotifStore";
import { useI18nStore } from "../../store/useI18nStore";
import type { Tab } from "../../types";

export function BrowserPane({ tab }: { tab: Tab }) {
  const { lang } = useI18nStore();
  const [windowOpen, setWindowOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setError(null);
    try {
      await browserOpen(tab.connection_id);
      setWindowOpen(true);
    } catch (err) {
      const msg = String(err);
      setError(msg);
      useNotifStore.getState().add({
        connName: tab.connection_name,
        connType: "browser",
        host: "",
        raw: msg,
      });
    }
  };

  const close = async () => {
    try {
      await browserClose(tab.connection_id);
    } catch { /* already closed */ }
    setWindowOpen(false);
  };

  // Auto-open when the pane mounts
  useEffect(() => {
    open();
    return () => { close(); };
  }, [tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const es = lang === "es";

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 bg-[var(--color-bg-base)] text-[var(--color-text-muted)] select-none">
      <div className="flex flex-col items-center gap-3">
        <div className="w-16 h-16 rounded-2xl bg-[var(--color-accent)]/10 flex items-center justify-center">
          <Globe size={32} className="text-[var(--color-accent)]" />
        </div>
        <div className="text-center">
          <p className="text-[var(--color-text-primary)] font-semibold text-base">{tab.connection_name}</p>
          <p className="text-xs mt-0.5 opacity-60">
            {es ? "Conexión de navegador" : "Browser connection"}
          </p>
        </div>
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-3 max-w-xs text-center">
          <div className="flex items-center gap-2 text-[var(--color-danger)]">
            <AlertCircle size={16} />
            <span className="text-sm font-medium">{es ? "Error al abrir" : "Failed to open"}</span>
          </div>
          <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">{error}</p>
          <button
            onClick={open}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-sm font-medium transition-colors"
          >
            <RefreshCw size={14} />
            {es ? "Reintentar" : "Retry"}
          </button>
        </div>
      ) : windowOpen ? (
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-2 text-[var(--color-success)] text-sm">
            <span className="w-2 h-2 rounded-full bg-[var(--color-success)] animate-pulse" />
            {es ? "Ventana de navegador abierta" : "Browser window is open"}
          </div>
          <div className="flex gap-2">
            <button
              onClick={open}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-elevated)] text-xs transition-colors"
            >
              <ExternalLink size={13} />
              {es ? "Enfocar ventana" : "Focus window"}
            </button>
            <button
              onClick={close}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-elevated)] text-xs transition-colors"
            >
              {es ? "Cerrar navegador" : "Close browser"}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={open}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-sm font-medium transition-colors"
        >
          <Globe size={16} />
          {es ? "Abrir navegador" : "Open browser"}
        </button>
      )}

      <p className="text-xs opacity-40 max-w-xs text-center">
        {es
          ? "El navegador se abre en una ventana dedicada con los DNS personalizados de esta conexión aplicados."
          : "The browser opens in a dedicated window with this connection's custom DNS entries applied."}
      </p>
    </div>
  );
}
