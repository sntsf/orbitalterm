import { useEffect, useState } from "react";
import { AlertCircle, ExternalLink, Loader } from "lucide-react";
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
  const conn = useAppStore().getConnectionById(tab.connection_id);
  const [proxyPort, setProxyPort] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProxyPort(null);
    setError(null);

    browserOpen(tab.connection_id)
      .then((port) => {
        if (!cancelled) setProxyPort(port);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });

    return () => {
      cancelled = true;
      browserClose(tab.connection_id).catch(console.error);
    };
  }, [tab.connection_id]);

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
            onClick={() => { setError(null); setProxyPort(null); }}
            className="px-4 py-2 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-sm font-medium transition-colors"
          >
            {es ? "Reintentar" : "Retry"}
          </button>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 px-4 py-2 rounded-lg bg-[var(--color-bg-subtle)] hover:bg-[var(--color-bg-hover)] text-sm font-medium transition-colors"
            >
              <ExternalLink size={13} />
              {es ? "Abrir en navegador" : "Open in browser"}
            </a>
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
    <div className="absolute inset-0">
      <iframe
        key={iframeSrc}
        src={iframeSrc}
        className="w-full h-full"
        style={{ border: "none", display: "block" }}
        allow="fullscreen; autoplay; clipboard-read; clipboard-write"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-modals allow-downloads"
      />
    </div>
  );
}
