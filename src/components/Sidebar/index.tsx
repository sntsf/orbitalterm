import { useEffect, useRef, useState } from "react";
import {
  Plus, Search, FolderOpen, Folder, Monitor, Terminal,
  Copy, Trash2, Plug, FolderPlus,
} from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { getConnections, getFolders, deleteConnection, saveConnection } from "../../lib/commands";
import { ContextMenu, useContextMenu } from "../ContextMenu";
import { PropertiesPanel } from "../PropertiesPanel";
import type { Connection, Folder as FolderType } from "../../types";

export function Sidebar() {
  const {
    connections, folders, searchQuery,
    setConnections, setFolders, setSearchQuery,
    selectConnection, selectedConnectionId,
    openTab, toggleFolder, startNewConnection,
  } = useAppStore();

  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  // Draggable divider state
  const [panelHeight, setPanelHeight] = useState(220);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  useEffect(() => {
    getConnections().then(setConnections).catch(console.error);
    getFolders().then(setFolders).catch(console.error);
  }, []);

  const filtered = searchQuery
    ? connections.filter(
        (c) =>
          c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.host.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : connections;

  const rootConns = filtered.filter((c) => !c.folder_id);
  const folderConns = (folderId: string) => filtered.filter((c) => c.folder_id === folderId);

  // Duplicate a connection
  const duplicate = async (conn: Connection) => {
    await saveConnection({
      name: `${conn.name} (copy)`,
      type: conn.type,
      host: conn.host,
      port: conn.port,
      username: conn.username,
      auth_type: conn.auth_type,
      key_path: conn.key_path,
      folder_id: conn.folder_id,
      notes: conn.notes,
      description: conn.description,
      domain: conn.domain,
    });
    setConnections(await getConnections());
  };

  const remove = async (conn: Connection) => {
    await deleteConnection(conn.id);
    setConnections(await getConnections());
    selectConnection(null);
  };

  const connMenu = (e: React.MouseEvent, conn: Connection) =>
    openMenu(e, [
      {
        label: "Connect",
        icon: <Plug size={12} />,
        action: () => openTab(conn),
      },
      {
        label: "Duplicate",
        icon: <Copy size={12} />,
        action: () => duplicate(conn),
      },
      { separator: true },
      {
        label: "Delete",
        icon: <Trash2 size={12} />,
        action: () => remove(conn),
        danger: true,
      },
    ]);

  // Divider drag handlers
  const onDividerDown = (e: React.MouseEvent) => {
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = panelHeight;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startY.current - ev.clientY;
      setPanelHeight(Math.max(120, Math.min(480, startH.current + delta)));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <aside className="flex flex-col h-full bg-[var(--color-bg-surface)] border-r border-[var(--color-border)] w-64 shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] shrink-0">
        <span className="font-semibold text-[var(--color-text-primary)] tracking-wide text-xs uppercase">
          Connections
        </span>
        <div className="flex gap-0.5">
          <button
            onClick={startNewConnection}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
            title="New connection"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={() => {}}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
            title="New folder"
          >
            <FolderPlus size={14} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-2 py-1.5 border-b border-[var(--color-border)] shrink-0">
        <div className="flex items-center gap-2 bg-[var(--color-bg-elevated)] rounded px-2 py-1">
          <Search size={12} className="text-[var(--color-text-muted)] shrink-0" />
          <input
            type="text"
            placeholder="Search…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="bg-transparent outline-none text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] w-full text-xs"
          />
        </div>
      </div>

      {/* Connection tree */}
      <div className="flex-1 overflow-y-auto py-0.5 min-h-0">
        {folders.map((folder) => (
          <FolderItem
            key={folder.id}
            folder={folder}
            connections={folderConns(folder.id)}
            onOpen={openTab}
            onToggle={() => toggleFolder(folder.id)}
            onContextMenu={connMenu}
            selectedId={selectedConnectionId}
            onSelect={selectConnection}
          />
        ))}

        {rootConns.map((conn) => (
          <ConnItem
            key={conn.id}
            conn={conn}
            selected={selectedConnectionId === conn.id}
            onSelect={() => selectConnection(conn.id)}
            onOpen={() => openTab(conn)}
            onContextMenu={(e) => connMenu(e, conn)}
          />
        ))}

        {connections.length === 0 && (
          <div className="px-4 py-6 text-center text-[var(--color-text-muted)] text-xs">
            <Terminal size={20} className="mx-auto mb-2 opacity-30" />
            <p>No connections yet.</p>
            <button
              onClick={startNewConnection}
              className="mt-1 text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
            >
              Add the first one
            </button>
          </div>
        )}
      </div>

      {/* Draggable divider */}
      <div
        onMouseDown={onDividerDown}
        className="h-1 cursor-row-resize bg-[var(--color-border)] hover:bg-[var(--color-accent)] transition-colors shrink-0"
        title="Drag to resize"
      />

      {/* Properties panel */}
      <div
        className="border-t border-[var(--color-border)] shrink-0 overflow-hidden"
        style={{ height: panelHeight }}
      >
        <PropertiesPanel />
      </div>

      {/* Context menu */}
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </aside>
  );
}

function FolderItem({
  folder, connections, onOpen, onToggle, onContextMenu, selectedId, onSelect,
}: {
  folder: FolderType;
  connections: Connection[];
  onOpen: (c: Connection) => void;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent, c: Connection) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const Icon = folder.expanded ? FolderOpen : Folder;
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
      >
        <Icon size={13} />
        <span className="text-xs truncate">{folder.name}</span>
      </button>
      {folder.expanded &&
        connections.map((conn) => (
          <ConnItem
            key={conn.id}
            conn={conn}
            selected={selectedId === conn.id}
            onSelect={() => onSelect(conn.id)}
            onOpen={() => onOpen(conn)}
            onContextMenu={(e) => onContextMenu(e, conn)}
            indent
          />
        ))}
    </div>
  );
}

function ConnItem({
  conn, selected, onSelect, onOpen, onContextMenu, indent = false,
}: {
  conn: Connection;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  indent?: boolean;
}) {
  const isSSH = conn.type === "ssh";
  return (
    <button
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      className={[
        "flex items-center gap-2 w-full py-1.5 pr-3 transition-colors text-left group",
        indent ? "pl-8" : "pl-3",
        selected
          ? "bg-[var(--color-accent)]/20 text-[var(--color-accent-hover)]"
          : "hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
      ].join(" ")}
    >
      {isSSH ? (
        <Terminal size={12} className="shrink-0" />
      ) : (
        <Monitor size={12} className="shrink-0" />
      )}
      <span className="text-xs truncate flex-1">{conn.name}</span>
      <span
        className={`text-[9px] uppercase font-semibold px-1 rounded ${
          isSSH
            ? "text-[var(--color-success)] bg-[var(--color-success)]/10"
            : "text-[var(--color-accent)] bg-[var(--color-accent)]/10"
        }`}
      >
        {conn.type}
      </span>
    </button>
  );
}
