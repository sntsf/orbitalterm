import { useRef, useState, useEffect } from "react";
import { AlertCircle, ExternalLink } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useI18nStore } from "../../store/useI18nStore";
import type { Tab } from "../../types";

export function BrowserPane({ tab }: { tab: Tab }) {
  const { lang } = useI18nStore();
  const conn = useAppStore().getConnectionById(tab.connection_id);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [blocked, setBlocked] = useState(false);

  const rawUrl = conn?.url ?? "";
  const url = rawUrl
    ? rawUrl.includes("://")
      ? rawUrl
      : `https://${rawUrl}`
    : "";

  // Reset blocked state when URL changes (retry on reconnect)
  useEffect(() => {
    setBlocked(false);
  }, [url]);

  const es = lang === "es";

  if (!url) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-muted)] text-sm">
        {es ? "Sin URL configurada" : "No URL configured"}
      </div>
    );
  }

  if (blocked) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--color-text-muted)]">
        <AlertCircle size={32} className="text-[var(--color-danger)]" />
        <p className="text-sm max-w-xs text-center">
          {es
            ? "El sitio bloquea la incrustación. Ábrelo en el navegador del sistema."
            : "This site blocks embedding. Open it in the system browser."}
        </p>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-sm font-medium transition-colors"
        >
          <ExternalLink size={14} />
          {es ? "Abrir en navegador" : "Open in browser"}
        </a>
        <button
          onClick={() => setBlocked(false)}
          className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline"
        >
          {es ? "Reintentar" : "Retry"}
        </button>
      </div>
    );
  }

  return (
    <div className="absolute inset-0">
      <iframe
        ref={iframeRef}
        key={url}
        src={url}
        className="w-full h-full"
        style={{ border: "none", display: "block" }}
        allow="fullscreen; autoplay; clipboard-read; clipboard-write"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-modals allow-downloads"
        onError={() => setBlocked(true)}
      />
    </div>
  );
}
