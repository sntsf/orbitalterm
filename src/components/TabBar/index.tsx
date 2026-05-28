import { useRef, useState } from "react";
import { X, RefreshCw, PanelLeftClose } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { ConnIconDisplay, DEFAULT_CONN_ICON } from "../../lib/connIcons";
import { dockBack, openDetachedWindow, storeDetachedSession } from "../../lib/commands";
import { skipDisconnectSessions } from "../../lib/sessionTransfer";
import type { Tab } from "../../types";

type MenuState = { tabId: string; x: number; y: number } | null;

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, reconnectTab, reorderTabs } = useAppStore();
  const [menu, setMenu] = useState<MenuState>(null);
  const [dragSrcId, setDragSrcId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  if (tabs.length === 0) return null;

  const closeMenu = () => setMenu(null);

  async function tearOut(tab: Tab) {
    try {
      const label = `detached-${tab.connection_id}`;
      if (tab.session_id) {
        skipDisconnectSessions.add(tab.session_id);
        await storeDetachedSession(label, tab.session_id);
      }
      await openDetachedWindow(tab.connection_id, tab.connection_name);
      closeTab(tab.id);
    } catch (err) {
      if (tab.session_id) skipDisconnectSessions.delete(tab.session_id);
      console.error("tearOut error:", err);
    }
  }

  return (
    <>
      <div
        ref={barRef}
        className="flex items-center bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] overflow-x-auto shrink-0 select-none"
        onClick={closeMenu}
        onDragOver={(e) => e.preventDefault()}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isDragging = tab.id === dragSrcId;
          const isDropTarget = tab.id === dropTargetId && tab.id !== dragSrcId;
          const iconKey = tab.icon || DEFAULT_CONN_ICON[tab.connection_type] || "server";

          return (
            <div
              key={tab.id}
              draggable
              onClick={() => setActiveTab(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
              }}
              onDragStart={(e) => {
                setDragSrcId(tab.id);
                // Don't set any dataTransfer data — the OS would create a file
                // if the tab is dropped on the desktop. Track state in dragSrcId only.
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (tab.id !== dragSrcId) setDropTargetId(tab.id);
              }}
              onDragLeave={() => {
                if (dropTargetId === tab.id) setDropTargetId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragSrcId && dragSrcId !== tab.id) reorderTabs(dragSrcId, tab.id);
                setDragSrcId(null);
                setDropTargetId(null);
              }}
              onDragEnd={(e) => {
                const rect = barRef.current?.getBoundingClientRect();
                // If dropped well below the tab bar → tear out to new window
                if (rect && e.clientY > rect.bottom + 60) {
                  tearOut(tab);
                }
                setDragSrcId(null);
                setDropTargetId(null);
              }}
              className={[
                "flex items-center gap-2 px-3 py-2 border-r border-[var(--color-border)] cursor-pointer shrink-0 group transition-colors min-w-0 max-w-48",
                isDragging ? "opacity-40" : "",
                isDropTarget ? "border-l-2 border-l-[var(--color-accent)]" : "",
                isActive
                  ? "bg-[var(--color-bg-base)] text-[var(--color-text-primary)] border-t-2 border-t-[var(--color-accent)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-primary)]",
              ].join(" ")}
            >
              <ConnIconDisplay iconKey={iconKey} size={16} />
              <span className="text-xs truncate flex-1">{tab.connection_name}</span>
              <StatusDot status={tab.status} />
              <button
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)] transition-all"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeMenu} />
          <div
            className="fixed z-50 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded shadow-lg py-1 min-w-36"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              onClick={() => {
                const tab = tabs.find((t) => t.id === menu.tabId);
                if (tab) tearOut(tab);
                closeMenu();
              }}
            >
              <PanelLeftClose size={11} />
              Separar ventana
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              onClick={() => { reconnectTab(menu.tabId); closeMenu(); }}
            >
              <RefreshCw size={11} />
              Reconectar
            </button>
            <div className="border-t border-[var(--color-border)] my-1" />
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--color-danger)] hover:bg-[var(--color-bg-hover)] transition-colors"
              onClick={() => { closeTab(menu.tabId); closeMenu(); }}
            >
              <X size={11} />
              Cerrar
            </button>
          </div>
        </>
      )}
    </>
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
    <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${colors[status] ?? colors.idle}`} />
  );
}

// ── DetachedTabBar — shown in torn-out windows ────────────────────────────────

export function DetachedTabBar({ tab }: { tab: Tab | undefined }) {
  const handleDockBack = () => {
    if (!tab) return;
    const sid = tab.session_id ?? null;
    if (sid) skipDisconnectSessions.add(sid);
    dockBack(tab.connection_id, sid).catch(console.error);
  };

  const onTabDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
  };

  const onTabDragEnd = async (e: React.DragEvent) => {
    if (!tab) return;

    const { screenX, screenY } = e;
    // screenX/Y are logical pixels; convert to physical to compare with Tauri's outerPosition
    const dpr = window.devicePixelRatio || 1;
    const physX = Math.round(screenX * dpr);
    const physY = Math.round(screenY * dpr);

    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const mainWin = new WebviewWindow("main");
      const [mainPos, mainSize] = await Promise.all([
        mainWin.outerPosition(),
        mainWin.outerSize(),
      ]);
      // outerPosition includes the title bar. Be generous: check top 180px
      // of the outer window which covers any title bar + tab bar combination.
      const overTabBar =
        physX >= mainPos.x &&
        physX <= mainPos.x + mainSize.width &&
        physY >= mainPos.y &&
        physY <= mainPos.y + 180;

      if (overTabBar) handleDockBack();
    } catch { /* ignore – window might be moving */ }
  };

  return (
    <div className="flex items-center bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] shrink-0 select-none">
      {tab && (
        <div
          draggable
          onDragStart={onTabDragStart}
          onDragEnd={onTabDragEnd}
          className="flex items-center gap-2 px-3 py-2 border-r border-[var(--color-border)] bg-[var(--color-bg-base)] border-t-2 border-t-[var(--color-accent)] text-[var(--color-text-primary)] min-w-0 max-w-64 cursor-grab active:cursor-grabbing"
        >
          <ConnIconDisplay iconKey={tab.icon || DEFAULT_CONN_ICON[tab.connection_type] || "server"} size={16} />
          <span className="text-xs truncate flex-1">{tab.connection_name}</span>
          <StatusDot status={tab.status} />
        </div>
      )}
      <button
        onClick={handleDockBack}
        className="ml-auto mr-2 flex items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] rounded transition-colors"
        title="Volver a la ventana principal"
      >
        <PanelLeftClose size={12} />
        Dock back
      </button>
    </div>
  );
}
