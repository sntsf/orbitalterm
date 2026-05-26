import { useEffect, useState } from "react";
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
  ftpConnect, ftpDisconnect, getConnections, getFolders, getGroups, getWindowLabel,
} from "./lib/commands";
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

function SessionPane({ tab }: { tab: Tab }) {
  if (tab.connection_type === "ssh") return <TerminalPane tab={tab} />;
  if (tab.connection_type === "rdp") return <RdpPane tab={tab} />;
  if (tab.connection_type === "vnc") return <VncPane tab={tab} />;
  if (tab.connection_type === "sftp") return <SftpDualPane tab={tab} />;
  if (tab.connection_type === "ftp") return <FtpStandalonePane tab={tab} />;
  return <RdpPane tab={tab} />;
}

// ── Detached (torn-out) window layout ─────────────────────────────────────────

function DetachedApp({ connectionId }: { connectionId: string }) {
  const { connections, tabs, activeTabId, openTab, setConnections, setFolders, setGroups } = useAppStore();

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

  // Auto-open the target connection once loaded
  useEffect(() => {
    if (connections.length === 0) return;
    const conn = connections.find((c) => c.id === connectionId);
    if (conn) openTab(conn);
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
  const { tabs, activeTabId, sidebarVisible, openTab, getConnectionById } = useAppStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Listen for dock-back events from detached windows
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{ connectionId: string }>("orbital:dock-back", (ev) => {
        const conn = getConnectionById(ev.payload.connectionId);
        if (conn) openTab(conn);
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
  // string     — connectionId for a detached session window
  const [mode, setMode] = useState<"checking" | "main" | string>("checking");

  useEffect(() => {
    getWindowLabel()
      .then((label) => {
        if (label.startsWith("detached-")) {
          setMode(label.slice("detached-".length)); // connectionId
        } else {
          setMode("main");
        }
      })
      .catch(() => setMode("main"));
  }, []);

  if (mode === "checking") return null;
  if (mode === "main") return <MainApp />;
  return <DetachedApp connectionId={mode} />;
}
