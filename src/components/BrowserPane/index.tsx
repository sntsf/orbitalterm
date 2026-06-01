import { useEffect, useState } from "react";
import { AlertCircle, ExternalLink, Loader } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { browserOpen, browserClose } from "../../lib/commands";
import { useAppStore } from "../../store/useAppStore";
import { useI18nStore } from "../../store/useI18nStore";
import type { Tab } from "../../types";

function getInitialPath(url: string): string {
  try {
    const u = new URL(url.includes("://") ? url : `http://${url}`);
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}

export function BrowserPane({ tab }: { tab: Tab }) {
  const { lang } = useI18nStore();
  const { getConnectionById, setTabStatus } = useAppStore();
  const conn = getConnectionById(tab.connection_id);
  const [proxyPort, setProxyPort] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProxyPort(null);
    setError(null);
    setTabStatus(tab.id, "connecting");

    browserOpen(tab.connection_id)
      .then((port) => {
        if (!cancelled) {
          setProxyPort(port);
          setTabStatus(tab.id, "connected");
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String(e));
          setTabStatus(tab.id, "error");
        }
      });

    return () => {
      cancelled = true;
      setTabStatus(tab.id, "idle");
      browserClose(tab.connection_id).catch(console.error);
    };
  }, [tab.connection_id, tab.id]);

  const es = lang === "es";
  const url = conn?.url ?? "";
  const iframeSrc = proxyPort
    ? `http://127.0.0.1:${proxyPort}${getInitialPath(url)}`
    : null;

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--color-text-muted)]">
        <AlertCircle size={32} className="text-[var(--color-danger)]" />
        <p className="text-sm max-w-xs text-center">{error}</p>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setError(null);
              setProxyPort(null);
              setTabStatus(tab.id, "connecting");
            }}
            className="px-4 py-2 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-sm font-medium transition-colors"
          >
            {es ? "Reintentar" : "Retry"}
          </button>
          {url && (
            <button
              onClick={() => shellOpen(url).catch(console.error)}
              className="flex items-center gap-1 px-4 py-2 rounded-lg bg-[var(--color-bg-subtle)] hover:bg-[var(--color-bg-hover)] text-sm font-medium transition-colors"
            >
              <ExternalLink size={13} />
              {es ? "Abrir en navegador" : "Open in browser"}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!iframeSrc) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-[var(--color-text-muted)] text-sm">
        <Loader size={16} className="animate-spin" />
        {es ? "Iniciando proxy…" : "Starting proxy…"}
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1 bg-[var(--color-bg-subtle)] border-b border-[var(--color-border)] shrink-0">
        <span className="flex-1 text-xs text-[var(--color-text-muted)] truncate">{url}</span>
        {url && (
          <button
            title={es ? "Abrir en navegador externo" : "Open in external browser"}
            onClick={() => shellOpen(url).catch(console.error)}
            className="shrink-0 p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            <ExternalLink size={13} />
          </button>
        )}
      </div>
      <iframe
        key={iframeSrc}
        src={iframeSrc}
        className="flex-1 w-full"
        style={{ border: "none", display: "block" }}
        allow="fullscreen; autoplay; clipboard-read; clipboard-write"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-modals allow-downloads"
      />
    </div>
  );
}
