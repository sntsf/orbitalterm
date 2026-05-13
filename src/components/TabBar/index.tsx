import { X, Terminal, Monitor } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab } = useAppStore();

  if (tabs.length === 0) return null;

  return (
    <div className="flex items-center bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] overflow-x-auto shrink-0">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const Icon = tab.connection_type === "ssh" ? Terminal : Monitor;
        return (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={[
              "flex items-center gap-2 px-3 py-2 border-r border-[var(--color-border)] cursor-pointer shrink-0 group transition-colors min-w-0 max-w-48",
              isActive
                ? "bg-[var(--color-bg-base)] text-[var(--color-text-primary)] border-t-2 border-t-[var(--color-accent)]"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-primary)]",
            ].join(" ")}
          >
            <Icon size={12} className="shrink-0" />
            <span className="text-xs truncate flex-1">{tab.connection_name}</span>
            <StatusDot status={tab.status} />
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)] transition-all"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle: "bg-[var(--color-text-muted)]",
    connecting: "bg-[var(--color-warning)] animate-pulse",
    connected: "bg-[var(--color-success)]",
    error: "bg-[var(--color-danger)]",
  };
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${colors[status] ?? colors.idle}`}
    />
  );
}
