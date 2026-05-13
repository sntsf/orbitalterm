import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TerminalPane } from "./components/Terminal";
import { Welcome } from "./components/Welcome";
import { ConnectionForm } from "./components/ConnectionForm";
import { useAppStore } from "./store/useAppStore";

export default function App() {
  const { tabs, activeTabId, showConnectionForm } = useAppStore();

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Titlebar space */}
      <div className="flex h-full overflow-hidden">
        {/* Sidebar */}
        <Sidebar />

        {/* Main area */}
        <div className="flex flex-col flex-1 overflow-hidden">
          <TabBar />

          {/* Content */}
          <div className="flex-1 overflow-hidden bg-[var(--color-bg-base)]">
            {activeTab ? (
              tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`w-full h-full ${tab.id === activeTabId ? "block" : "hidden"}`}
                >
                  <TerminalPane tab={tab} />
                </div>
              ))
            ) : (
              <Welcome />
            )}
          </div>
        </div>
      </div>

      {/* Modals */}
      {showConnectionForm && <ConnectionForm />}
    </div>
  );
}
