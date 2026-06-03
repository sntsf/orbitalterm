import { useRef, useState } from "react";
import { X, RefreshCw, PanelLeftClose } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { ConnIconDisplay, DEFAULT_CONN_ICON } from "../../lib/connIcons";
import { dockBack, openDetachedWindow, rdpWindowsVisibility, storeDetachedSession } from "../../lib/commands";
import { skipDisconnectSessions } from "../../lib/sessionTransfer";
import type { Tab } from "../../types";

type MenuState = { tabId: string; x: number; y: number } | null;

const TEAR_THRESHOLD = 60; // px below bar bottom to trigger tear-out

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, reconnectTab, reorderTabs } = useAppStore();
  const [menu, setMenu] = useState<MenuState>(null);
  const [dragSrcId, setDragSrcId] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Drag state tracked in refs to avoid stale closures in pointermove/pointerup
  const dragRef = useRef<{
    tabId: string;
    tab: Tab;
    moved: boolean;
    insertBefore: string | null; // "__end__" or tab id or null
  } | null>(null);

  if (tabs.length === 0) return null;

  const closeMenu = () => setMenu(null);

  // Windows native RDP sessions use a Win32 child window bound to the original
  // parent HWND — it cannot be transferred to a new Tauri window.  Skip the
  // session store so the old session disconnects cleanly and the new window
  // starts a fresh connection instead of trying to reparent the Win32 window.
  const isWindows = /Windows/i.test(navigator.userAgent);

  async function tearOut(tab: Tab) {
    try {
      const label = `detached-${tab.connection_id}`;
      const isNativeRdp = tab.connection_type === "rdp" && isWindows;

      if (isNativeRdp) {
        // Windows native RDP: hide the WS_POPUP and close the tab immediately
        // before opening the detached window. The detached window starts its own
        // fresh RDP session so no session transfer is needed. Closing first
        // prevents the tab getting stuck if openDetachedWindow throws.
        if (tab.session_id) {
          await rdpWindowsVisibility(tab.session_id, false).catch(() => {});
        }
        closeTab(tab.id);
        await openDetachedWindow(tab.connection_id, tab.connection_name);
        return;
      }

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

  function calcInsertBefore(clientX: number): string | null {
    const bar = barRef.current;
    if (!bar) return null;
    const tabEls = Array.from(bar.querySelectorAll<HTMLElement>("[data-tab-id]"));
    for (const el of tabEls) {
      const rect = el.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (clientX < mid) return el.dataset.tabId ?? null;
    }
    return "__end__";
  }

  function onPointerDown(e: React.PointerEvent, tab: Tab) {
    // Only left button; don't interfere with right-click context menu
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const startY = e.clientY;

    dragRef.current = { tabId: tab.id, tab, moved: false, insertBefore: null };

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragRef.current) return;

      if (!dragRef.current.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;

      if (!dragRef.current.moved) {
        dragRef.current.moved = true;
        setDragSrcId(tab.id);
      }

      const insert = calcInsertBefore(ev.clientX);
      dragRef.current.insertBefore = insert;

      // Determine visual dropBefore (skip self)
      const { tabs: curTabs } = useAppStore.getState();
      const srcIdx = curTabs.findIndex((t) => t.id === tab.id);
      let visual: string | null = insert;
      if (insert === tab.id) {
        // cursor is left of self — show indicator before self (no-op visually)
        visual = null;
      } else if (insert === "__end__") {
        // past last tab
        const last = curTabs[curTabs.length - 1];
        visual = last && last.id !== tab.id ? "__end__" : null;
      } else if (insert !== null) {
        // insert before `insert`; suppress if insert is immediately after src
        const insertIdx = curTabs.findIndex((t) => t.id === insert);
        visual = insertIdx === srcIdx + 1 ? null : insert;
      }
      setDropBefore(visual);
    }

    function onUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);

      const state = dragRef.current;
      dragRef.current = null;
      setDragSrcId(null);
      setDropBefore(null);

      if (!state || !state.moved) return;

      const bar = barRef.current;
      const barRect = bar?.getBoundingClientRect();

      if (barRect && ev.clientY > barRect.bottom + TEAR_THRESHOLD) {
        tearOut(state.tab);
        return;
      }

      const insertBefore = state.insertBefore;
      if (insertBefore !== null && insertBefore !== state.tabId) {
        reorderTabs(state.tabId, insertBefore === "__end__" ? null : insertBefore);
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <>
      <div
        ref={barRef}
        className="flex items-center bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] overflow-x-auto shrink-0 select-none"
        onClick={closeMenu}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isDragging = tab.id === dragSrcId;
          const iconKey = tab.icon || DEFAULT_CONN_ICON[tab.connection_type] || "server";
          const isLast = tabs[tabs.length - 1]?.id === tab.id;
          const showLeftBorder = dropBefore === tab.id && tab.id !== dragSrcId;
          const showRightBorder = isLast && dropBefore === "__end__" && tab.id !== dragSrcId;

          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              onPointerDown={(e) => onPointerDown(e, tab)}
              onClick={() => {
                // Suppress click if this was a drag
                if (dragRef.current?.moved) return;
                setActiveTab(tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
              }}
              className={[
                "flex items-center gap-2 px-3 py-2 border-r border-[var(--color-border)] cursor-pointer shrink-0 group transition-colors min-w-0 max-w-48 touch-none",
                isDragging ? "opacity-40" : "",
                showLeftBorder ? "border-l-2 border-l-[var(--color-accent)]" : "",
                showRightBorder ? "border-r-2 border-r-[var(--color-accent)]" : "",
                isActive
                  ? "bg-[var(--color-bg-base)] text-[var(--color-text-primary)] border-t-2 border-t-[var(--color-accent)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-primary)]",
              ].join(" ")}
            >
              <ConnIconDisplay iconKey={iconKey} size={16} />
              <span className="text-xs truncate flex-1">{tab.connection_name}</span>
              <StatusDot status={tab.status} />
              <button
                onPointerDown={(e) => e.stopPropagation()}
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
