import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Monitor, RefreshCw, AlertCircle, CheckCircle, PackageOpen } from "lucide-react";
import {
  connectRdp,
  disconnectRdp,
  rdpStatus,
  rdpMouseInput,
  rdpKeyInput,
  rdpResizeSession,
  rdpGetLinuxClipboard,
  rdpSetClipboard,
} from "../../lib/commands";
import { useAppStore } from "../../store/useAppStore";
import type { Tab } from "../../types";

function parseMissingClient(msg: string): { pkg: string; rest: string } | null {
  const match = msg.match(/^NO_RDP_CLIENT:(\S+)\n([\s\S]*)$/);
  if (!match) return null;
  return { pkg: match[1], rest: match[2] };
}

function isMissingPassword(msg: string): boolean {
  return msg.startsWith("NO_PASSWORD\n");
}

interface RdpPaneProps {
  tab: Tab;
}

// ── Embedded canvas viewer (Linux) ────────────────────────────────────────────

interface EmbeddedViewerProps {
  sessionId: string;
  width: number;
  height: number;
  onSessionError: (msg: string) => void;
  onResize: (w: number, h: number) => void;
}

function EmbeddedViewer({ sessionId, width, height, onSessionError, onResize }: EmbeddedViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Dynamic resize: when the container changes size, resize the RDP session
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.max(640, Math.floor(entry.contentRect.width));
      const h = Math.max(480, Math.floor(entry.contentRect.height));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        rdpResizeSession(sessionId, w, h).catch(() => {});
        onResize(w, h);
      }, 400);
    });
    observer.observe(container);
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [sessionId, onResize]);

  // Frame + error listeners
  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    listen<string>(`rdp-frame-${sessionId}`, (event) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = `data:image/jpeg;base64,${event.payload}`;
    }).then((fn) => unlistens.push(fn));
    listen<string>(`rdp-error-${sessionId}`, (event) => {
      onSessionError(event.payload);
    }).then((fn) => unlistens.push(fn));
    return () => { unlistens.forEach((fn) => fn()); };
  }, [sessionId, onSessionError]);

  // Coordinate mapping: canvas logical → remote resolution
  function remoteCoords(e: React.MouseEvent<HTMLCanvasElement>): [number, number] {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = width / rect.width;
    const scaleY = height / rect.height;
    return [
      Math.round((e.clientX - rect.left) * scaleX),
      Math.round((e.clientY - rect.top) * scaleY),
    ];
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const [x, y] = remoteCoords(e);
    rdpMouseInput(sessionId, 6, 0, x, y).catch(() => {});
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const [x, y] = remoteCoords(e);
    // X11 button numbers: 1=left, 2=middle, 3=right
    const btn = e.button === 0 ? 1 : e.button === 1 ? 2 : 3;
    rdpMouseInput(sessionId, 4, btn, x, y).catch(() => {});
  }

  function onMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
    const [x, y] = remoteCoords(e);
    const btn = e.button === 0 ? 1 : e.button === 1 ? 2 : 3;
    rdpMouseInput(sessionId, 5, btn, x, y).catch(() => {});
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const [x, y] = remoteCoords(e as unknown as React.MouseEvent<HTMLCanvasElement>);
    const btn = e.deltaY < 0 ? 4 : 5;
    rdpMouseInput(sessionId, 4, btn, x, y).catch(() => {});
    rdpMouseInput(sessionId, 5, btn, x, y).catch(() => {});
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
    e.preventDefault();
    // Ctrl+V: sync Linux clipboard → Xvfb first so cliprdr can offer it to Windows,
    // then send V after a short delay for the cliprdr negotiation to complete.
    if (e.ctrlKey && e.key === "v") {
      rdpGetLinuxClipboard()
        .then(async (text) => {
          if (text) {
            await rdpSetClipboard(sessionId, text).catch(() => {});
            // Give xfreerdp3 time to detect the new clipboard owner and send
            // CB_FORMAT_LIST_PDU to Windows before we forward the V keypress.
            await new Promise((r) => setTimeout(r, 300));
          }
          rdpKeyInput(sessionId, true, "v").catch(() => {});
          rdpKeyInput(sessionId, false, "v").catch(() => {});
        })
        .catch(() => {
          rdpKeyInput(sessionId, true, "v").catch(() => {});
        });
      return;
    }
    rdpKeyInput(sessionId, true, e.key).catch(() => {});
  }

  function onKeyUp(e: React.KeyboardEvent<HTMLCanvasElement>) {
    e.preventDefault();
    // V keyup is already sent inside the async Ctrl+V handler above.
    if (e.ctrlKey && e.key === "v") return;
    rdpKeyInput(sessionId, false, e.key).catch(() => {});
  }

  function onContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault();
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-black overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        tabIndex={0}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "crosshair", outline: "none", display: "block" }}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onContextMenu={onContextMenu}
      />
    </div>
  );
}

// ── Main RdpPane ──────────────────────────────────────────────────────────────

export function RdpPane({ tab }: RdpPaneProps) {
  const [status, setStatus] = useState<"connecting" | "connected" | "error">("connecting");
  const [errorMsg, setErrorMsg] = useState("");
  const [embedded, setEmbedded] = useState(false);
  const [frameSize, setFrameSize] = useState({ width: 1280, height: 800 });
  const sessionIdRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { setTabStatus, setTabSessionId, getConnectionById } = useAppStore();

  const connect = async (isRetry = false) => {
    // Kill previous session before retrying so Xvfb is freed and Windows
    // has time to clean up before we create a new session.
    if (sessionIdRef.current) {
      await disconnectRdp(sessionIdRef.current).catch(() => {});
      sessionIdRef.current = null;
    }
    if (isRetry) {
      // Give Windows ~5s to release the session after the previous disconnect.
      setStatus("connecting");
      setErrorMsg("");
      setTabStatus(tab.id, "connecting");
      await new Promise((r) => setTimeout(r, 5000));
    }

    setStatus("connecting");
    setErrorMsg("");
    setTabStatus(tab.id, "connecting");

    try {
      const el = containerRef.current;
      const w = el ? Math.max(640, Math.floor(el.clientWidth)) : 1280;
      const h = el ? Math.max(480, Math.floor(el.clientHeight)) : 800;
      const result = await connectRdp(tab.connection_id, w, h);
      sessionIdRef.current = result.session_id;
      setTabSessionId(tab.id, result.session_id);
      setEmbedded(result.embedded);
      if (result.embedded) {
        setFrameSize({ width: result.width, height: result.height });
      }
      setStatus("connected");
      setTabStatus(tab.id, "connected");
    } catch (err) {
      setErrorMsg(String(err));
      setStatus("error");
      setTabStatus(tab.id, "error");
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

  // Poll rdp_status every 2s only for non-embedded (external window) sessions
  useEffect(() => {
    if (status !== "connected" || embedded) return;
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
  }, [status, embedded]);

  // Embedded canvas mode: render canvas immediately after connected
  if (status === "connected" && embedded && sessionIdRef.current) {
    return (
      <EmbeddedViewer
        sessionId={sessionIdRef.current}
        width={frameSize.width}
        height={frameSize.height}
        onSessionError={(msg) => { setEmbedded(false); setStatus("error"); setErrorMsg(msg); }}
        onResize={(w, h) => setFrameSize({ width: w, height: h })}
      />
    );
  }

  const connection = getConnectionById(tab.connection_id);

  return (
    <div ref={containerRef} className="flex flex-col items-center justify-center h-full gap-5 text-center px-8 bg-[var(--color-bg-base)]">
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

      {status === "connected" && !embedded && (
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
            onClick={() => connect(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded text-xs border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            <RefreshCw size={12} />
            Reconnect
          </button>
        </div>
      )}

      {status === "error" && (() => {
        if (isMissingPassword(errorMsg)) {
          return (
            <div className="flex flex-col items-center gap-3 max-w-sm text-center">
              <AlertCircle size={28} className="text-[var(--color-warning)]" />
              <p className="text-sm font-medium text-[var(--color-text-primary)]">
                Contraseña no guardada
              </p>
              <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
                Para conectarte en modo embebido necesitás guardar la contraseña.
                Cerrá esta pestaña, seleccioná la conexión en el sidebar,
                ingresá la contraseña en Propiedades y guardá.
              </p>
            </div>
          );
        }
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
                onClick={() => connect(true)}
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
              onClick={() => connect(true)}
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
