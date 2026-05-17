import { MonitorDot } from "lucide-react";
import type { Tab } from "../../types";
import { useAppStore } from "../../store/useAppStore";

interface VncPaneProps {
  tab: Tab;
}

export function VncPane({ tab }: VncPaneProps) {
  const { getConnectionById } = useAppStore();
  const connection = getConnectionById(tab.connection_id);
  const host = connection?.host ?? "unknown";
  const port = connection?.port ?? 5900;

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-[var(--color-text-muted)]">
      <MonitorDot size={40} className="opacity-40" />
      <p className="text-sm font-medium text-[var(--color-text-primary)]">VNC Connection</p>
      <p className="text-xs">
        Target: <span className="text-[var(--color-accent)]">{host}:{port}</span>
      </p>
      <div className="max-w-xs text-center text-xs leading-relaxed">
        <p className="mb-2">VNC is not yet natively embedded. To connect, use a VNC client:</p>
        <code className="block bg-[var(--color-bg-elevated)] rounded px-3 py-2 text-[var(--color-text-primary)] font-mono">
          vncviewer {host}:{port}
        </code>
        <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
          Install: <code>sudo apt install tigervnc-viewer</code>
        </p>
      </div>
    </div>
  );
}
