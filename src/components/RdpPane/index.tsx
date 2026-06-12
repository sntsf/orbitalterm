import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Monitor, RefreshCw, AlertCircle, CheckCircle, PackageOpen } from "lucide-react";
import {
  connectRdp,
  disconnectRdp,
  rdpStatus,
  rdpMouseInput,
  rdpKeyInput,
  rdpResizeSession,
  rdpRefreshSession,
  rdpWindowsReposition,
  rdpWindowsVisibility,
  rdpWindowsReparent,
} from "../../lib/commands";
import { useAppStore } from "../../store/useAppStore";
import { useNotifStore, NOTIF_H_EXPANDED } from "../../store/useNotifStore";
import { useT, useI18nStore } from "../../store/useI18nStore";
import { friendlyConnError } from "../../lib/connErrors";
import { skipDisconnectSessions } from "../../lib/sessionTransfer";
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

// ── Windows native window viewer ─────────────────────────────────────────────
// On Windows the RDP session is an mstsc.exe window reparented inside Tauri.
// This component is just a transparent placeholder that keeps the native window
// positioned and sized correctly.

interface WindowsViewerProps {
  sessionId: string;
  tabId: string;
  transferred?: boolean;
}

// Renders a transparent placeholder that tracks its own position and drives
// the native WS_POPUP window to stay in sync. Disconnect detection is handled
// by RdpPane directly so the listener is registered once and never re-created.
function WindowsEmbeddedViewer({ sessionId, tabId, transferred }: WindowsViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const reparentedRef = useRef(false);
  const { activeTabId } = useAppStore();
  const { notifs, expanded } = useNotifStore();
  // Only reserve space when the bar is expanded. When minimized the badge lives
  // in the TabBar (always in the HTML zone, never covered by the native window).
  const notifReserve = expanded && notifs.length > 0 ? NOTIF_H_EXPANDED : 0;

  // Show/hide by watching the active tab only. Menus no longer hide the WS_POPUP —
  // instead they carve a SetWindowRgn hole so the HTML menu renders through.
  useEffect(() => {
    const isActive = activeTabId === tabId;
    if (isActive) {
      rdpWindowsVisibility(sessionId, true).catch(() => {});
      requestAnimationFrame(() => {
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        if (transferred && !reparentedRef.current) {
          reparentedRef.current = true;
          rdpWindowsReparent(sessionId, Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height))
            .catch((e) => console.error("[WinViewer] reparent failed:", e));
        } else {
          rdpWindowsReposition(sessionId, Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)).catch(() => {});
        }
      });
    } else {
      rdpWindowsVisibility(sessionId, false).catch(() => {});
    }
  }, [activeTabId, tabId, sessionId, transferred]);

  // Reposition on window resize while this tab is active.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const sync = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        rdpWindowsReposition(sessionId, Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)).catch(() => {});
      }
    };

    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [sessionId]);

  return (
    <>
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: notifReserve > 0 ? `calc(100% - ${notifReserve}px)` : "100%",
          background: "transparent",
        }}
      />
      {notifReserve > 0 && (
        <div style={{
          height: `${notifReserve}px`,
          background: "var(--color-bg-elevated)",
          borderTop: "1px solid var(--color-border)",
        }} />
      )}
    </>
  );
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
      // Skip when element is hidden (display:none gives size 0,0)
      if (entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
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
    listen<{ x: number; y: number; data: string }>(`rdp-frame-${sessionId}`, (event) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { x, y, data } = event.payload;
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      createImageBitmap(new Blob([bytes], { type: "image/jpeg" })).then((bmp) => {
        ctx.drawImage(bmp, x, y);
        bmp.close();
      });
    }).then((fn) => unlistens.push(fn));
    listen<string>(`rdp-error-${sessionId}`, (event) => {
      onSessionError(event.payload);
    }).then((fn) => unlistens.push(fn));
    // Clean user logoff — show a neutral "session ended" message, not the red error UI.
    listen(`rdp-disconnected-${sessionId}`, () => {
      onSessionError("SESSION_ENDED");
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

  // RDP PTR_FLAGS constants
  const PTR_MOVE   = 0x0800;
  const PTR_DOWN   = 0x8000;
  const PTR_BTN1   = 0x1000; // left
  const PTR_BTN2   = 0x2000; // right
  const PTR_BTN3   = 0x4000; // middle
  const PTR_WHEEL  = 0x0200;
  const PTR_WHEEL_NEG = 0x0100;

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const [x, y] = remoteCoords(e);
    rdpMouseInput(sessionId, PTR_MOVE, x, y).catch(() => {});
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const [x, y] = remoteCoords(e);
    const btn = e.button === 0 ? PTR_BTN1 : e.button === 1 ? PTR_BTN3 : PTR_BTN2;
    rdpMouseInput(sessionId, btn | PTR_DOWN, x, y).catch(() => {});
  }

  function onMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
    const [x, y] = remoteCoords(e);
    const btn = e.button === 0 ? PTR_BTN1 : e.button === 1 ? PTR_BTN3 : PTR_BTN2;
    rdpMouseInput(sessionId, btn, x, y).catch(() => {});
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const [x, y] = remoteCoords(e as unknown as React.MouseEvent<HTMLCanvasElement>);
    // Clamp magnitude to 0–255 (fits in low byte of PTR_FLAGS)
    const magnitude = Math.min(255, Math.round(Math.abs(e.deltaY)));
    const flags = e.deltaY < 0
      ? PTR_WHEEL | magnitude
      : PTR_WHEEL | PTR_WHEEL_NEG | magnitude;
    rdpMouseInput(sessionId, flags, x, y).catch(() => {});
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
    e.preventDefault();
    rdpKeyInput(sessionId, true, e.code).catch(() => {});
  }

  function onKeyUp(e: React.KeyboardEvent<HTMLCanvasElement>) {
    e.preventDefault();
    rdpKeyInput(sessionId, false, e.code).catch(() => {});
  }

  function onFocus() {
    // Request a full-screen repaint from Windows whenever the canvas is
    // focused (e.g. after switching tabs or clicking back into the session).
    rdpRefreshSession(sessionId).catch(() => {});
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
        onFocus={onFocus}
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
  const [nativeWindow, setNativeWindow] = useState(false);
  useEffect(() => { nativeWindowRef.current = nativeWindow; }, [nativeWindow]);
  const [frameSize, setFrameSize] = useState({ width: 1280, height: 800 });
  const sessionIdRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nativeWindowRef = useRef(false);
  // Generation counter: incremented each time a new connect() is initiated
  // (including by the useEffect cleanup on unmount/re-mount). Any in-flight
  // connect() that finds its generation outdated discards the session it
  // created. This prevents React 18 StrictMode's double-invoke from opening
  // two simultaneous RDP connections to the same server.
  const connectGenRef = useRef(0);
  const { setTabStatus, setTabSessionId, getConnectionById, closeTab } = useAppStore();
  const t = useT();
  const { lang } = useI18nStore();
  const isWindows = /Windows/i.test(navigator.userAgent);

  const connect = async (isRetry = false, adminMode = false) => {
    const gen = ++connectGenRef.current;

    if (sessionIdRef.current) {
      await disconnectRdp(sessionIdRef.current).catch(() => {});
      sessionIdRef.current = null;
    }
    // If a newer connect() started while we were awaiting, abort.
    if (gen !== connectGenRef.current) return;

    if (isRetry) {
      setStatus("connecting");
      setErrorMsg("");
      setTabStatus(tab.id, "connecting");
      await new Promise((r) => setTimeout(r, 5000));
      if (gen !== connectGenRef.current) return;
    }

    setStatus("connecting");
    setErrorMsg("");
    setTabStatus(tab.id, "connecting");

    // Yield ONE event-loop turn before calling the backend.
    // React 18 StrictMode double-invokes useEffect within a single scheduler
    // task.  By awaiting a 0-ms timeout here, we let that scheduler task
    // finish (including the cleanup gen-bump and the second effect's gen
    // increment) BEFORE we issue the expensive Tauri IPC call.  The gen
    // check below then catches the stale call and aborts it without ever
    // touching the Rust backend.  Skip this yield for user-initiated retries
    // which already have their own 5-second delay.
    if (!isRetry) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (gen !== connectGenRef.current) return;
    }

    try {
      const el = containerRef.current;
      const w = el ? Math.max(640, Math.floor(el.clientWidth)) : 1280;
      const h = el ? Math.max(480, Math.floor(el.clientHeight)) : 800;
      const rect = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
      const result = await connectRdp(tab.connection_id, w, h, adminMode, Math.round(rect.left), Math.round(rect.top));

      if (gen !== connectGenRef.current) {
        // Superseded — discard this session so we don't leak an RDP connection.
        disconnectRdp(result.session_id).catch(() => {});
        return;
      }

      sessionIdRef.current = result.session_id;
      setTabSessionId(tab.id, result.session_id);
      setEmbedded(result.embedded);
      setNativeWindow(result.native_window);
      if (result.embedded && !result.native_window) {
        setFrameSize({ width: result.width, height: result.height });
        setTimeout(() => {
          if (sessionIdRef.current === result.session_id) {
            rdpRefreshSession(result.session_id).catch(() => {});
          }
        }, 800);
      }
      setStatus("connected");
      setTabStatus(tab.id, "connected");
    } catch (err) {
      if (gen === connectGenRef.current) {
        const raw = String(err);
        if (raw.startsWith("NO_RDP_CLIENT") || raw.startsWith("NO_PASSWORD")) {
          // Show inline UI for these special cases (package not installed / no credentials)
          setErrorMsg(raw);
          setStatus("error");
          setTabStatus(tab.id, "error");
        } else {
          const conn = getConnectionById(tab.connection_id);
          useNotifStore.getState().add({
            connName: tab.connection_name,
            connType: "rdp",
            host: conn?.host ?? "",
            raw,
          });
          closeTab(tab.id);
        }
      }
    }
  };

  useEffect(() => {
    if (tab.session_id) {
      sessionIdRef.current = tab.session_id;
      setTabSessionId(tab.id, tab.session_id);
      setEmbedded(true);
      if (isWindows) {
        // Native RDP transfer: mark as native window so WindowsEmbeddedViewer renders.
        // The viewer will call rdpWindowsReparent on first sync to move the WS_POPUP
        // from the old owner (main window) to this window.
        setNativeWindow(true);
      }
      setStatus("connected");
      setTabStatus(tab.id, "connected");
      if (!isWindows) {
        rdpRefreshSession(tab.session_id).catch(() => {});
      }
    } else {
      connect();
    }
    return () => {
      connectGenRef.current++;
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sid) {
        if (skipDisconnectSessions.has(sid)) {
          skipDisconnectSessions.delete(sid);
        } else if (nativeWindowRef.current) {
          // Windows embedded RDP: check whether this is a tab switch (tab still
          // in store) or a tab close (tab removed). On switch, hide but keep the
          // session alive so switching back restores without reconnecting.
          const tabStillOpen = useAppStore.getState().tabs.some((t) => t.id === tab.id);
          if (tabStillOpen) {
            rdpWindowsVisibility(sid, false).catch(() => {});
          } else {
            disconnectRdp(sid).catch(console.error);
          }
        } else {
          disconnectRdp(sid).catch(console.error);
        }
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
          setErrorMsg("SESSION_ENDED");
          clearInterval(interval);
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [status, embedded]);

  // Stable callback reference — prevents EmbeddedViewer's ResizeObserver
  // effect from reconnecting on every RdpPane re-render.
  const handleResize = useCallback(
    (w: number, h: number) => setFrameSize({ width: w, height: h }),
    [],
  );

  // Register the rdp-disconnected listener here (not inside WindowsEmbeddedViewer)
  // so it is set up ONCE when nativeWindow becomes true and never re-created due
  // to inline callback churn. The STA thread emits this event after the loop exits
  // regardless of the exit reason (logoff, WM_QUIT, parent destroyed, etc.).
  useEffect(() => {
    if (!nativeWindow) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const unlistens: UnlistenFn[] = [];

    // Normal session end (user logged off after a real connection) — just close the tab
    listen(`rdp-disconnected-${sid}`, () => {
      const s = sessionIdRef.current;
      if (s) { disconnectRdp(s).catch(() => {}); sessionIdRef.current = null; }
      closeTab(tab.id);
    }).then((fn) => unlistens.push(fn));

    // Connection failed before ever connecting (server off, port closed, etc.)
    listen<string>(`rdp-error-${sid}`, (e) => {
      const s = sessionIdRef.current;
      if (s) { disconnectRdp(s).catch(() => {}); sessionIdRef.current = null; }
      const raw = e.payload || "connection timed out";
      const conn = getConnectionById(tab.connection_id);
      useNotifStore.getState().add({
        connName: tab.connection_name,
        connType: "rdp",
        host: conn?.host ?? "",
        raw,
      });
      closeTab(tab.id);
    }).then((fn) => unlistens.push(fn));

    return () => { unlistens.forEach((fn) => fn()); };
  }, [nativeWindow]); // eslint-disable-line react-hooks/exhaustive-deps

  // Windows native window: transparent placeholder that drives mstsc position
  if (status === "connected" && embedded && nativeWindow && sessionIdRef.current) {
    return (
      <WindowsEmbeddedViewer
        sessionId={sessionIdRef.current}
        tabId={tab.id}
        transferred={!!tab.session_id}
      />
    );
  }

  // Linux canvas mode: receive JPEG frames via Tauri events
  if (status === "connected" && embedded && !nativeWindow && sessionIdRef.current) {
    return (
      <EmbeddedViewer
        sessionId={sessionIdRef.current}
        width={frameSize.width}
        height={frameSize.height}
        onSessionError={(msg) => {
          if (msg !== "SESSION_ENDED") {
            const conn = getConnectionById(tab.connection_id);
            useNotifStore.getState().add({
              connName: tab.connection_name,
              connType: "rdp",
              host: conn?.host ?? "",
              raw: msg,
            });
          }
          closeTab(tab.id);
        }}
        onResize={handleResize}
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
            : status === "error" && errorMsg !== "SESSION_ENDED"
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
          {t("rdpLaunching")}
        </p>
      )}

      {status === "connected" && !embedded && (
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-2 text-[var(--color-success)] text-sm">
            <CheckCircle size={15} />
            {t("rdpSessionExternal")}
          </div>
          <p className="text-xs text-[var(--color-text-muted)] max-w-xs">
            {t("rdpExternalHint")}
          </p>
          <button
            onClick={() => connect(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded text-xs border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            <RefreshCw size={12} />
            {t("connReconnect")}
          </button>
        </div>
      )}

      {status === "error" && (() => {
        if (errorMsg === "SESSION_ENDED") {
          return (
            <div className="flex flex-col items-center gap-3 max-w-sm text-center">
              <CheckCircle size={28} className="text-[var(--color-text-muted)] opacity-50" />
              <p className="text-sm text-[var(--color-text-muted)]">
                {t("connSessionEnded")}
              </p>
              <button
                onClick={() => connect(true)}
                className="flex items-center gap-2 px-3 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white font-medium transition-colors"
              >
                <RefreshCw size={12} />
                {t("connReconnect")}
              </button>
            </div>
          );
        }
        if (isMissingPassword(errorMsg)) {
          return (
            <div className="flex flex-col items-center gap-3 max-w-sm text-center">
              <AlertCircle size={28} className="text-[var(--color-warning)]" />
              <p className="text-sm font-medium text-[var(--color-text-primary)]">
                {t("rdpNoPasswordTitle")}
              </p>
              <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
                {t("rdpNoPasswordDesc")}
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
                <span className="text-sm font-medium">{t("rdpMissingClientTitle")}</span>
              </div>
              <p className="text-xs text-[var(--color-text-muted)] whitespace-pre-line leading-relaxed">
                {missing.rest.split("\n").slice(1).join("\n")}
              </p>
              <div className="flex flex-col gap-2 w-full">
                <p className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
                  {t("rdpInstallCmd")}
                </p>
                <code
                  className="bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-3 py-2 text-xs font-mono text-[var(--color-text-primary)] text-left cursor-pointer select-all"
                  title="Click to copy"
                  onClick={() => navigator.clipboard.writeText(`sudo apt install freerdp3-x11`)}
                >
                  sudo apt install freerdp3-x11
                </code>
                <p className="text-[10px] text-[var(--color-text-muted)]">
                  {t("rdpInstallHint")}
                </p>
              </div>
              <button
                onClick={() => connect(true)}
                className="flex items-center gap-2 px-3 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white font-medium transition-colors"
              >
                <RefreshCw size={12} />
                {t("connRetry")}
              </button>
            </div>
          );
        }
        return (
          <div className="flex flex-col items-center gap-3 max-w-sm">
            <div className="flex items-start gap-2 text-[var(--color-danger)] text-sm text-left">
              <AlertCircle size={15} className="shrink-0 mt-0.5" />
              <span className="whitespace-pre-line">{friendlyConnError(errorMsg, lang, "rdp")}</span>
            </div>
            <button
              onClick={() => connect(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white font-medium transition-colors"
            >
              <RefreshCw size={12} />
              {t("connRetry")}
            </button>
          </div>
        );
      })()}
    </div>
  );
}
