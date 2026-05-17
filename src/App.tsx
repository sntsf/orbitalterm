import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TerminalPane } from "./components/Terminal";
import { RdpPane } from "./components/RdpPane";
import { Welcome } from "./components/Welcome";
import { useAppStore } from "./store/useAppStore";

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
