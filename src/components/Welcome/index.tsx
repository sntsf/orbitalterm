import { Terminal, Monitor, Download } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";

export function Welcome() {
  const { startNewConnection } = useAppStore();

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 text-center p-8 bg-[var(--color-bg-base)] h-full">
      <div>
        <div className="flex items-center justify-center gap-2 mb-2">
          <Terminal size={32} className="text-[var(--color-accent)]" />
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            OrbitalTerm
          </h1>
        </div>
        <p className="text-[var(--color-text-muted)] text-sm">
          Lightweight remote connection manager for sysadmins
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3 max-w-lg">
        <ActionCard
          icon={<Terminal size={18} />}
          title="New SSH"
          desc="Connect to a Linux / Unix server"
          onClick={startNewConnection}
          accent
        />
        <ActionCard
          icon={<Monitor size={18} />}
          title="New RDP"
          desc="Connect to a Windows server"
          onClick={startNewConnection}
        />
        <ActionCard
          icon={<Download size={18} />}
          title="Import"
          desc="Import from JSON or mRemoteNG"
          onClick={() => {}}
        />
      </div>

      <p className="text-xs text-[var(--color-text-muted)] max-w-xs">
        Double-click any connection in the sidebar to open a session tab.
        All data is stored locally on your machine.
      </p>
    </div>
  );
}

function ActionCard({
  icon, title, desc, onClick, accent = false,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "flex flex-col items-center gap-2 p-4 rounded-lg border text-center transition-colors",
        accent
          ? "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5 hover:bg-[var(--color-accent)]/10 text-[var(--color-accent-hover)]"
          : "border-[var(--color-border)] bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
      ].join(" ")}
    >
      {icon}
      <div>
        <p className="text-xs font-semibold">{title}</p>
        <p className="text-[10px] mt-0.5 opacity-70">{desc}</p>
      </div>
    </button>
  );
}
