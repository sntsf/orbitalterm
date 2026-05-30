import { useRef, useState } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useI18nStore } from "../../store/useI18nStore";
import type { Tab } from "../../types";

export function BrowserPane({ tab }: { tab: Tab }) {
  const { lang } = useI18nStore();
  const connection = useAppStore(s => s.getConnectionById(tab.connection_id));
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [errored, setErrored] = useState(false);

  const rawUrl = connection?.url ?? "";
  const url = rawUrl.includes("://") ? rawUrl : rawUrl ? `https://${rawUrl}` : "";

  const reload = () => {
    setErrored(false);
    if (iframeRef.current) iframeRef.current.src = url;
  };

  const es = lang === "es";

  if (!url) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-muted)] text-sm">
        {es ? "Sin URL configurada. Edita la conexión y agrega una URL." : "No URL configured. Edit the connection and add a URL."}
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      {errored && (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--color-text-muted)]">
          <AlertCircle size={32} className="text-[var(--color-danger)]" />
          <p className="text-sm max-w-xs text-center">
            {es
              ? "El sitio no permite ser cargado aquí (X-Frame-Options). Prueba abrirlo en el navegador del sistema."
              : "The site does not allow embedding (X-Frame-Options). Try opening it in the system browser."}
          </p>
          <button
            onClick={reload}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-sm font-medium transition-colors"
          >
            <RotateCcw size={14} />
            {es ? "Reintentar" : "Retry"}
          </button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={url}
        className="flex-1 w-full border-none bg-white"
        style={{ display: errored ? "none" : "block" }}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-top-navigation allow-modals allow-downloads"
        onError={() => setErrored(true)}
        title={tab.connection_name}
      />
    </div>
  );
}
