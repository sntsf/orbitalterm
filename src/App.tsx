import { memo, useEffect, useRef, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { TabBar, DetachedTabBar } from "./components/TabBar";
import { TerminalPane } from "./components/Terminal";
import { RdpPane } from "./components/RdpPane";
import { VncPane } from "./components/VncPane";
import { BrowserPane } from "./components/BrowserPane";
import { FtpBrowser } from "./components/FtpBrowser";
import { SftpDualPane } from "./components/SftpDualPane";
import { Welcome } from "./components/Welcome";
import { MenuBar } from "./components/MenuBar";
import { NotificationOverlay } from "./components/NotificationBar";
import { TransferPanel } from "./components/TransferPanel";
import { useAppStore } from "./store/useAppStore";
import { useNotifStore } from "./store/useNotifStore";
import {
  ftpConnect, ftpDisconnect, getConnections, getFolders, getGroups, getWindowLabel,
  popDetachedSession,
} from "./lib/commands";
import { skipDisconnectSessions } from "./lib/sessionTransfer";
import type { Tab } from "./types";

// ── Standalone FTP pane ────────────────────────────────────────────────────────

function FtpStandalonePane({ tab }: { tab: Tab }) {
  const { getConnectionById, setTabStatus, closeTab } = useAppStore();
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
          useNotifStore.getState().add({
            connName: connection?.name ?? tab.connection_name,
            connType: "ftp",
            host: connection?.host ?? "",
            raw: String(err),
          });
          closeTab(tab.id);
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
      onDisconnect={() => closeTab(tab.id)}
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
  if (tab.connection_type === "browser") return <BrowserPane tab={tab} />;
  return <RdpPane tab={tab} />;
});

// ── Detached (torn-out) window layout ─────────────────────────────────────────

function DetachedApp({ connectionId, windowLabel }: { connectionId: string; windowLabel: string }) {
  const { connections, tabs, activeTabId, openTab, openTabConnected, setConnections, setFolders, setGroups } = useAppStore();
  // Guard: popDetachedSession removes the entry on first call. React.StrictMode
  // runs effects twice — the second call returns null and would open a fresh
  // (blank) connection instead of restoring the transferred session.
  const didOpenRef = useRef(false);

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
    if (didOpenRef.current) return;
    didOpenRef.current = true;
    popDetachedSession(windowLabel)
      .then((sessionId) => {
        console.log("[DetachedApp] popDetachedSession:", sessionId, "label:", windowLabel);
        if (sessionId) {
          // Protect from React StrictMode's double-invoke cleanup: the first
          // cleanup fires before reparent and would call disconnectRdp without this.
          skipDisconnectSessions.add(sessionId);
          openTabConnected(conn, sessionId);
        } else {
          openTab(conn);
        }
      })
      .catch((e) => { console.error("[DetachedApp] popDetachedSession error:", e); openTab(conn); });
  }, [connections, connectionId]); // eslint-disable-line react-hooks/exhaustive-deps

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
          skipDisconnectSessions.add(ev.payload.sessionId);
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
      <TransferPanel />
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

  // Stop the webview's reload shortcuts (F5, Ctrl/Cmd+R) from tearing down the
  // whole frontend and dropping every open tab/session. We only cancel the
  // browser's default RELOAD action — the event still propagates, so panes can
  // give F5 their own meaning (SFTP/FTP refresh the listing, RDP/SSH forward it
  // to the remote session).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isReload =
        e.key === "F5" ||
        ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R"));
      if (isReload) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  if (label === "checking") return null;
  if (label === "main") return <MainApp />;
  return <DetachedApp connectionId={label.slice("detached-".length)} windowLabel={label} />;
}
