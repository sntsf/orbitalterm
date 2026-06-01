import { useRef, useState } from "react";

interface MenuItem {
  label?: string;
  icon?: React.ReactNode;
  action?: () => void;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  return (
    <>
      {/* Invisible overlay to catch clicks outside */}
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />

      <div
        ref={ref}
        className="fixed z-50 min-w-44 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded-lg shadow-2xl py-1 overflow-hidden"
        style={{ left: x, top: y }}
      >
        {items.map((item, i) =>
          item.separator ? (
            <div key={i} className="my-1 border-t border-[var(--color-border)]" />
          ) : (
            <button
              key={i}
              disabled={item.disabled}
              onClick={() => { if (!item.disabled) { item.action?.(); onClose(); } }}
              className={[
                "flex items-center gap-2.5 w-full px-3 py-1.5 text-xs text-left transition-colors",
                item.disabled
                  ? "opacity-40 cursor-not-allowed"
                  : item.danger
                  ? "text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
                  : "text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]",
              ].join(" ")}
            >
              {item.icon && <span className="opacity-70">{item.icon}</span>}
              {item.label}
            </button>
          )
        )}
      </div>
    </>
  );
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const open = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const close = () => setMenu(null);

  return { menu, open, close };
}
