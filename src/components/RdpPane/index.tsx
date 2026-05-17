import { useEffect, useRef, useState } from "react";
import { Monitor, RefreshCw, AlertCircle, CheckCircle, PackageOpen } from "lucide-react";
import { connectRdp, disconnectRdp, rdpStatus } from "../../lib/commands";
import { useAppStore } from "../../store/useAppStore";
import type { Tab } from "../../types";

/** Parse the sentinel "NO_RDP_CLIENT:<pkg>" prefix the backend emits. */
function parseMissingClient(msg: string): { pkg: string; rest: string } | null {
  const match = msg.match(/^NO_RDP_CLIENT:(\S+)\n([\s\S]*)$/);
  if (!match) return null;
  return { pkg: match[1], rest: match[2] };
}

interface RdpPaneProps {
  tab: Tab;
}

export function RdpPane({ tab }: RdpPaneProps) {
  const [status, setStatus] = useState<"connecting" | "connected" | "error">("connecting");
  const [errorMsg, setErrorMsg] = useState("");
  const sessionIdRef = useRef<string | null>(null);
  const { setTabStatus, setTabSessionId, getConnectionById } = useAppStore();

  const connect = async () => {
    setStatus("connecting");
    setErrorMsg("");
    setTabStatus(tab.id, "connecting");

    const connection = getConnectionById(tab.connection_id);
    const label = connection
      ? `${connection.username}@${connection.host}:${connection.port}`
      : tab.connection_name;

    try {
      const sessionId = await connectRdp(tab.connection_id);
      sessionIdRef.current = sessionId;
      setTabSessionId(tab.id, sessionId);
      setStatus("connected");
      setTabStatus(tab.id, "connected");
    } catch (err) {
      setErrorMsg(String(err));
      setStatus("error");
      setTabStatus(tab.id, "error");
      // Suppress unused warning
      void label;
    }
  };

  useEffect(() => {
    connect();
    return () => {
      if (sessionIdRef.current) {
        disconnectRdp(sessionIdRef.current).catch(console.error);
      }
    };
  }, [tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll rdp_status every 2s to detect when the external window is closed
  useEffect(() => {
    if (status !== "connected") return;
    const interval = setInterval(async () => {
      if (!sessionIdRef.current) return;
      try {
        const s = await rdpStatus(sessionIdRef.current);
        if (s === "disconnected") {
          setStatus("error");
          setErrorMsg("La sesión RDP terminó. La ventana fue cerrada o se perdió la conexión.");
          clearInterval(interval);
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [status]);

  const connection = getConnectionById(tab.connection_id);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 text-center px-8 bg-[var(--color-bg-base)]">
      <Monitor
        size={52}
        className={
          status === "connected"
            ? "text-[var(--color-accent)] opacity-80"
            : status === "error"
            ? "text-[var(--color-danger)] opacity-60"
            : "text-[var(--color-text-muted)] opacity-40 animate-pulse"
        }
      />

      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
          {tab.connection_name}
        </h2>
        {connection && (
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            {connection.host}:{connection.port} · {connection.username}
          </p>
        )}
      </div>

      {status === "connecting" && (
        <p className="text-sm text-[var(--color-text-muted)] animate-pulse">
          Launching RDP client…
        </p>
      )}

      {status === "connected" && (
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-2 text-[var(--color-success)] text-sm">
            <CheckCircle size={15} />
            RDP session active in external window
          </div>
          <p className="text-xs text-[var(--color-text-muted)] max-w-xs">
            The RDP client was launched. Close it to end the session, or use
            Reconnect to open a new window.
          </p>
          <button
            onClick={connect}
            className="flex items-center gap-2 px-3 py-1.5 rounded text-xs border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            <RefreshCw size={12} />
            Reconnect
          </button>
        </div>
      )}

      {status === "error" && (() => {
        const missing = parseMissingClient(errorMsg);
        if (missing) {
          return (
            <div className="flex flex-col items-center gap-4 max-w-sm text-center">
              <div className="flex items-center gap-2 text-[var(--color-warning)]">
                <PackageOpen size={18} />
                <span className="text-sm font-medium">No RDP client installed</span>
              </div>
              <p className="text-xs text-[var(--color-text-muted)] whitespace-pre-line leading-relaxed">
                {missing.rest.split("\n").slice(1).join("\n")}
              </p>
              <div className="flex flex-col gap-2 w-full">
                <p className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
                  Install command
                </p>
                <code
                  className="bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-3 py-2 text-xs font-mono text-[var(--color-text-primary)] text-left cursor-pointer select-all"
                  title="Click to copy"
                  onClick={() => navigator.clipboard.writeText(`sudo apt install freerdp3-x11`)}
                >
                  sudo apt install freerdp3-x11
                </code>
                <p className="text-[10px] text-[var(--color-text-muted)]">
                  After installing, click Retry below.
                </p>
              </div>
              <button
                onClick={connect}
                className="flex items-center gap-2 px-3 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white font-medium transition-colors"
              >
                <RefreshCw size={12} />
                Retry
              </button>
            </div>
          );
        }
        return (
          <div className="flex flex-col items-center gap-3 max-w-sm">
            <div className="flex items-start gap-2 text-[var(--color-danger)] text-sm text-left">
              <AlertCircle size={15} className="shrink-0 mt-0.5" />
              <span className="whitespace-pre-line">{errorMsg}</span>
            </div>
            <button
              onClick={connect}
              className="flex items-center gap-2 px-3 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white font-medium transition-colors"
            >
              <RefreshCw size={12} />
              Retry
            </button>
          </div>
        );
      })()}
    </div>
  );
}
