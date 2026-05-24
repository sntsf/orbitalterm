import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TerminalPane } from "./components/Terminal";
import { RdpPane } from "./components/RdpPane";
import { VncPane } from "./components/VncPane";
import { FtpBrowser } from "./components/FtpBrowser";
import { SftpDualPane } from "./components/SftpDualPane";
import { Welcome } from "./components/Welcome";
import { MenuBar } from "./components/MenuBar";
import { useAppStore } from "./store/useAppStore";
import { ftpConnect, ftpDisconnect } from "./lib/commands";
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
      .catch(() => { if (!cancelled) setTabStatus(tab.id, "error"); });
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

// ── App root ───────────────────────────────────────────────────────────────────

export default function App() {
  const { tabs, activeTabId } = useAppStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <MenuBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />

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
                  {tab.connection_type === "ssh" ? (
                    <TerminalPane tab={tab} />
                  ) : tab.connection_type === "rdp" ? (
                    <RdpPane tab={tab} />
                  ) : tab.connection_type === "vnc" ? (
                    <VncPane tab={tab} />
                  ) : tab.connection_type === "sftp" ? (
                    <SftpDualPane tab={tab} />
                  ) : tab.connection_type === "ftp" ? (
                    <FtpStandalonePane tab={tab} />
                  ) : (
                    <RdpPane tab={tab} />
                  )}
                </div>
              ))
            )}
            {tabs.length > 0 && !activeTab && <Welcome />}
          </div>
        </div>
      </div>
    </div>
  );
}
