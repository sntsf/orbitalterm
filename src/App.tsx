import { memo, useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { TabBar, DetachedTabBar } from "./components/TabBar";
import { TerminalPane } from "./components/Terminal";
import { RdpPane } from "./components/RdpPane";
import { VncPane } from "./components/VncPane";
import { FtpBrowser } from "./components/FtpBrowser";
import { SftpDualPane } from "./components/SftpDualPane";
import { Welcome } from "./components/Welcome";
import { MenuBar } from "./components/MenuBar";
import { NotificationOverlay } from "./components/NotificationBar";
import { useAppStore } from "./store/useAppStore";
import { useNotifStore } from "./store/useNotifStore";
import {
  dockBack, ftpConnect, ftpDisconnect, getConnections, getFolders, getGroups, getWindowLabel,
  notifyDropZone, popDetachedSession,
} from "./lib/commands";
import { skipDisconnectSessions } from "./lib/sessionTransfer";
import type { Tab } from "./types";

// ── Standalone FTP pane ────────────────────────────────────────────────────────

function FtpStandalonePane({ tab }: { tab: Tab }) {
  const { getConnectionById, setTabStatus } = useAppStore();
  const connection = getConnectionById(tab.connection_id);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const handleConnect = (sid: string) => {
    setSessionId(sid);
    setTabStatus(tab.id, "connected");
  };

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    ftpConnect(connection.id)
      .then((sid) => { if (!cancelled) handleConnect(sid); })
      .catch((err) => {
        if (!cancelled) {
          setTabStatus(tab.id, "error");
          useNotifStore.getState().add({
            connName: connection?.name ?? tab.connection_name,
            connType: "ftp",
            host: connection?.host ?? "",
            raw: String(err),
          });
        }
      });
    return () => { cancelled = true; };
  }, [tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (sessionId) ftpDisconnect(sessionId).catch(console.error);
    };
  }, [sessionId]);

  return (
    <FtpBrowser
      sessionId={sessionId}
      connectionId={tab.connection_id}
      onConnect={handleConnect}
    />
  );
}

// ── Session renderer (shared between normal and detached layouts) ─────────────
// memo: prevents re-render when only activeTabId changes (CSS hidden/block swap).
// Without this, switching tabs re-renders RdpPane which recreates the onResize
// callback, causing EmbeddedViewer's ResizeObserver to reconnect and fire at
// size 0 (hidden element), triggering an unwanted rdpResizeSession call.

const SessionPane = memo(function SessionPane({ tab }: { tab: Tab }) {
  if (tab.connection_type === "ssh") return <TerminalPane tab={tab} />;
  if (tab.connection_type === "rdp") return <RdpPane tab={tab} />;
  if (tab.connection_type === "vnc") return <VncPane tab={tab} />;
  if (tab.connection_type === "sftp") return <SftpDualPane tab={tab} />;
  if (tab.connection_type === "ftp") return <FtpStandalonePane tab={tab} />;
  return <RdpPane tab={tab} />;
});

// ── Detached (torn-out) window layout ─────────────────────────────────────────

function DetachedApp({ connectionId, windowLabel }: { connectionId: string; windowLabel: string }) {
  const { connections, tabs, activeTabId, openTab, openTabConnected, setConnections, setFolders, setGroups } = useAppStore();

  // Load data (Sidebar not rendered in detached mode, so load here)
  useEffect(() => {
    Promise.all([getConnections(), getFolders(), getGroups()])
      .then(([conns, fldrs, grps]) => {
        setConnections(conns);
        setFolders(fldrs);
        setGroups(grps);
      })
      .catch(console.error);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open the target connection once loaded, resuming existing session if available
  useEffect(() => {
    if (connections.length === 0) return;
    const conn = connections.find((c) => c.id === connectionId);
    if (!conn) return;
    popDetachedSession(windowLabel)
      .then((sessionId) => {
        if (sessionId) {
          openTabConnected(conn, sessionId);
        } else {
          openTab(conn);
        }
      })
      .catch(() => openTab(conn));
  }, [connections, connectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag-to-dock: detect when this window is dragged near the main window's tab bar
  useEffect(() => {
    let mainBounds: { x: number; y: number; width: number; height: number } | null = null;
    let myWidth = 0;
    let dockTimer: ReturnType<typeof setTimeout> | null = null;
    let inDockZone = false;
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      const { WebviewWindow, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const { listen } = await import("@tauri-apps/api/event");
      const mainWin = new WebviewWindow("main");
      try {
        const pos = await mainWin.outerPosition();
        const size = await mainWin.outerSize();
        mainBounds = { x: pos.x, y: pos.y, width: size.width, height: size.height };
        myWidth = (await getCurrentWebviewWindow().outerSize()).width;
      } catch { return; }

      unlisten = await listen<{ x: number; y: number }>("tauri://move", (ev) => {
        if (!mainBounds) return;
        const { x, y } = ev.payload;
        const mb = mainBounds;
        // In "dock zone" when this window's top edge is within ±120px of main window's top
        // AND the horizontal range overlaps the main window
        const horizOverlap = x < mb.x + mb.width && x + myWidth > mb.x;
        const nearTop = y >= mb.y - 120 && y <= mb.y + 120;
        const nowInZone = horizOverlap && nearTop;

        if (nowInZone !== inDockZone) {
          inDockZone = nowInZone;
          notifyDropZone(nowInZone, nowInZone ? connectionId : undefined).catch(() => {});
        }

        if (nowInZone) {
          // Start debounce: if window rests here for 600ms, auto-dock
          if (!dockTimer) {
            dockTimer = setTimeout(() => {
              const state = useAppStore.getState();
              const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
              const sid = activeTab?.session_id ?? null;
              if (sid) skipDisconnectSessions.add(sid);
              notifyDropZone(false).catch(() => {});
              dockBack(connectionId, sid).catch(() => {});
            }, 600);
          }
        } else {
          if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
        }
      });
    };

    setup();
    return () => {
      unlisten?.();
      if (dockTimer) clearTimeout(dockTimer);
      if (inDockZone) notifyDropZone(false).catch(() => {});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <DetachedTabBar tab={activeTab} />
      <div className="flex-1 overflow-hidden bg-[var(--color-bg-base)] relative">
        {tabs.length === 0 ? (
          <Welcome />
        ) : (
          tabs.map((tab) => (
            <div key={tab.id} className={`absolute inset-0 ${tab.id === activeTabId ? "block" : "hidden"}`}>
              <SessionPane tab={tab} />
            </div>
          ))
        )}
        <NotificationOverlay />
      </div>
    </div>
  );
}

// ── Normal (main window) layout ───────────────────────────────────────────────

function MainApp() {
  const { tabs, activeTabId, sidebarVisible, openTab, openTabConnected, getConnectionById } = useAppStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Listen for dock-back events from detached windows
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{ connectionId: string; sessionId: string | null }>("orbital:dock-back", (ev) => {
        const conn = getConnectionById(ev.payload.connectionId);
        if (!conn) return;
        if (ev.payload.sessionId) {
          openTabConnected(conn, ev.payload.sessionId);
        } else {
          openTab(conn);
        }
      }).then((fn) => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <MenuBar />
      <div className="flex flex-1 overflow-hidden min-h-0">
        {sidebarVisible && <Sidebar />}

        <div className="flex flex-col flex-1 overflow-hidden">
          <TabBar />

          <div className="flex-1 overflow-hidden bg-[var(--color-bg-base)] relative">
            {tabs.length === 0 ? (
              <Welcome />
            ) : (
              tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`absolute inset-0 ${tab.id === activeTabId ? "block" : "hidden"}`}
                >
                  <SessionPane tab={tab} />
                </div>
              ))
            )}
            {tabs.length > 0 && !activeTab && <Welcome />}
            <NotificationOverlay />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── App root — decides which layout to render ─────────────────────────────────

export default function App() {
  // "checking" — waiting for Tauri to tell us our window label
  // "main"     — normal app window
  // otherwise  — full label of a detached session window (e.g. "detached-<id>")
  const [label, setLabel] = useState<"checking" | "main" | string>("checking");

  useEffect(() => {
    getWindowLabel()
      .then((l) => setLabel(l.startsWith("detached-") ? l : "main"))
      .catch(() => setLabel("main"));
  }, []);

  if (label === "checking") return null;
  if (label === "main") return <MainApp />;
  return <DetachedApp connectionId={label.slice("detached-".length)} windowLabel={label} />;
}
