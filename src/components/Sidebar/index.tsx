import { useEffect } from "react";
import { Plus, Search, FolderOpen, Folder, Monitor, Terminal } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { getConnections, getFolders } from "../../lib/commands";
import type { Connection, Folder as FolderType } from "../../types";

export function Sidebar() {
  const {
    connections,
    folders,
    searchQuery,
    setConnections,
    setFolders,
    setSearchQuery,
    openConnectionForm,
    openTab,
    toggleFolder,
    selectedConnectionId,
    selectConnection,
  } = useAppStore();

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

  const rootConnections = filtered.filter((c) => !c.folder_id);
  const folderConnections = (folderId: string) =>
    filtered.filter((c) => c.folder_id === folderId);

  return (
    <aside className="flex flex-col h-full bg-[var(--color-bg-surface)] border-r border-[var(--color-border)] w-64 shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)]">
        <span className="font-semibold text-[var(--color-text-primary)] tracking-wide text-xs uppercase">
          Connections
        </span>
        <button
          onClick={() => openConnectionForm()}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
          title="New connection"
        >
          <Plus size={15} />
        </button>
      </div>

      {/* Search */}
      <div className="px-2 py-2 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2 bg-[var(--color-bg-elevated)] rounded px-2 py-1">
          <Search size={13} className="text-[var(--color-text-muted)] shrink-0" />
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="bg-transparent outline-none text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] w-full text-xs"
          />
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {/* Folders */}
        {folders.map((folder) => (
          <FolderItem
            key={folder.id}
            folder={folder}
            connections={folderConnections(folder.id)}
            onOpenTab={openTab}
            onToggle={() => toggleFolder(folder.id)}
            selectedId={selectedConnectionId}
            onSelect={selectConnection}
          />
        ))}

        {/* Root connections */}
        {rootConnections.map((conn) => (
          <ConnectionItem
            key={conn.id}
            connection={conn}
            selected={selectedConnectionId === conn.id}
            onSelect={() => selectConnection(conn.id)}
            onOpen={() => openTab(conn)}
            onEdit={() => openConnectionForm(conn)}
          />
        ))}

        {connections.length === 0 && (
          <div className="px-4 py-8 text-center text-[var(--color-text-muted)] text-xs">
            <Terminal size={24} className="mx-auto mb-2 opacity-40" />
            <p>No connections yet.</p>
            <button
              onClick={() => openConnectionForm()}
              className="mt-2 text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
            >
              Add your first connection
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function FolderItem({
  folder,
  connections,
  onOpenTab,
  onToggle,
  selectedId,
  onSelect,
}: {
  folder: FolderType;
  connections: Connection[];
  onOpenTab: (c: Connection) => void;
  onToggle: () => void;
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
          <ConnectionItem
            key={conn.id}
            connection={conn}
            selected={selectedId === conn.id}
            onSelect={() => onSelect(conn.id)}
            onOpen={() => onOpenTab(conn)}
            onEdit={() => {}}
            indent
          />
        ))}
    </div>
  );
}

function ConnectionItem({
  connection,
  selected,
  onSelect,
  onOpen,
  indent = false,
}: {
  connection: Connection;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onEdit?: () => void;
  indent?: boolean;
}) {
  const isSSH = connection.type === "ssh";
  return (
    <button
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={[
        "flex items-center gap-2 w-full px-3 py-1.5 transition-colors text-left group",
        indent ? "pl-8" : "",
        selected
          ? "bg-[var(--color-accent)]/20 text-[var(--color-accent-hover)]"
          : "hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
      ].join(" ")}
    >
      {isSSH ? (
        <Terminal size={13} className="shrink-0" />
      ) : (
        <Monitor size={13} className="shrink-0" />
      )}
      <span className="text-xs truncate flex-1">{connection.name}</span>
      <span
        className={`text-[10px] uppercase font-medium px-1 rounded ${
          isSSH
            ? "text-[var(--color-success)] bg-[var(--color-success)]/10"
            : "text-[var(--color-accent)] bg-[var(--color-accent)]/10"
        }`}
      >
        {connection.type}
      </span>
    </button>
  );
}
