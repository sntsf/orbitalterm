import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TerminalPane } from "./components/Terminal";
import { RdpPane } from "./components/RdpPane";
import { VncPane } from "./components/VncPane";
import { SftpBrowser } from "./components/SftpBrowser";
import { Welcome } from "./components/Welcome";
import { useAppStore } from "./store/useAppStore";
import { useState } from "react";

function FtpPane() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--color-text-muted)]">
      <p className="text-sm font-medium text-[var(--color-text-primary)]">FTP Connection</p>
      <p className="text-xs text-center max-w-xs leading-relaxed">
        FTP is not yet natively embedded. Install FileZilla to connect:
      </p>
      <code className="bg-[var(--color-bg-elevated)] rounded px-3 py-2 text-xs text-[var(--color-text-primary)] font-mono">
        sudo apt install filezilla
      </code>
    </div>
  );
}

function SftpStandalonePane({ connectionId }: { connectionId: string }) {
  const [sftpSessionId, setSftpSessionId] = useState<string | null>(null);
  return (
    <SftpBrowser
      sessionId={sftpSessionId}
      connectionId={connectionId}
      onConnect={setSftpSessionId}
    />
  );
}

export default function App() {
  const { tabs, activeTabId } = useAppStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <div className="flex h-full overflow-hidden">
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
                    <SftpStandalonePane connectionId={tab.connection_id} />
                  ) : tab.connection_type === "ftp" ? (
                    <FtpPane />
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
