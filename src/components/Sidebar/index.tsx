import { useEffect, useRef, useState } from "react";
import {
  Plus, Search, FolderOpen, Folder, Terminal,
  Copy, Trash2, Plug, FolderPlus, Edit2, FolderInput as FolderInputIcon,
  ChevronRight, ChevronDown, Network,
} from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import {
  getConnections, getFolders, deleteConnection, saveConnection,
  saveFolder, deleteFolder, getFolders as refetchFolders, reorderConnections,
} from "../../lib/commands";
import { ContextMenu, useContextMenu } from "../ContextMenu";
import { PropertiesPanel } from "../PropertiesPanel";
import { TuxIcon, WindowsIcon, VncIcon, FtpIcon, SftpIcon } from "../ConnectionIcons";
import type { Connection, Folder as FolderType } from "../../types";

// ── Sidebar ────────────────────────────────────────────────────────────────────

export function Sidebar() {
  const {
    connections, folders, searchQuery,
    setConnections, setFolders, setSearchQuery,
    selectConnection, selectedConnectionId,
    openTab, toggleFolder, startNewConnection,
  } = useAppStore();

  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const [panelHeight, setPanelHeight] = useState(220);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderName, setRenameFolderName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [rootExpanded, setRootExpanded] = useState(true);

  useEffect(() => {
    getConnections().then(setConnections).catch(console.error);
    getFolders().then(setFolders).catch(console.error);
  }, []);

  useEffect(() => {
    if (creatingFolder && folderInputRef.current) folderInputRef.current.focus();
  }, [creatingFolder]);

  useEffect(() => {
    if (renamingFolderId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingFolderId]);

  const filtered = searchQuery
    ? connections.filter(
        (c) =>
          c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.host.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : connections;

  // In search mode: show all folders flat (depth=0), no recursive children
  // In tree mode: show only root folders recursively
  const displayFolders = searchQuery
    ? folders
    : folders.filter((f) => f.parent_id === null);

  const rootConns = searchQuery
    ? []
    : connections.filter((c) => !c.folder_id);

  const startCreateFolder = (parentId: string | null = null) => {
    setNewFolderName("");
    setNewFolderParentId(parentId);
    setCreatingFolder(true);
  };

  const confirmCreateFolder = async () => {
    const name = newFolderName.trim();
    if (name) {
      try {
        await saveFolder(name, newFolderParentId);
        setFolders(await refetchFolders());
      } catch (err) { console.error(err); }
    }
    setCreatingFolder(false);
    setNewFolderName("");
    setNewFolderParentId(null);
  };

  const cancelCreateFolder = () => {
    setCreatingFolder(false);
    setNewFolderName("");
    setNewFolderParentId(null);
  };

  const startRenameFolder = (folder: FolderType) => {
    setRenamingFolderId(folder.id);
    setRenameFolderName(folder.name);
  };

  const confirmRenameFolder = async () => {
    setRenamingFolderId(null);
    setRenameFolderName("");
  };

  const cancelRenameFolder = () => {
    setRenamingFolderId(null);
    setRenameFolderName("");
  };

  const removeFolder = async (folder: FolderType) => {
    try {
      await deleteFolder(folder.id);
      setFolders(await refetchFolders());
      setConnections(await getConnections());
    } catch (err) { console.error(err); }
  };

  const handleDragEnd = () => { setDragId(null); setDropTarget(null); };

  const handleDropOnConn = async (target: Connection) => {
    if (!dragId || dragId === target.id) { handleDragEnd(); return; }
    const dragged = connections.find((c) => c.id === dragId);
    if (!dragged) { handleDragEnd(); return; }
    const level = connections
      .filter((c) => c.folder_id === target.folder_id)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    const without = level.filter((c) => c.id !== dragId);
    const idx = without.findIndex((c) => c.id === target.id);
    without.splice(idx, 0, { ...dragged, folder_id: target.folder_id });
    const updates = without.map((c, i) => ({ id: c.id, sort_order: i * 10, folder_id: target.folder_id }));
    await reorderConnections(updates).catch(console.error);
    setConnections(await getConnections());
    handleDragEnd();
  };

  const handleDropOnFolder = async (folderId: string) => {
    if (!dragId) { handleDragEnd(); return; }
    const dragged = connections.find((c) => c.id === dragId);
    if (!dragged || dragged.folder_id === folderId) { handleDragEnd(); return; }
    const maxSort = connections
      .filter((c) => c.folder_id === folderId)
      .reduce((m, c) => Math.max(m, c.sort_order), -10) + 10;
    await reorderConnections([{ id: dragId, sort_order: maxSort, folder_id: folderId }]).catch(console.error);
    setConnections(await getConnections());
    handleDragEnd();
  };

  const folderMenu = (e: React.MouseEvent, folder: FolderType) =>
    openMenu(e, [
      { label: "New subfolder", icon: <FolderPlus size={12} />, action: () => startCreateFolder(folder.id) },
      { label: "Rename", icon: <Edit2 size={12} />, action: () => startRenameFolder(folder) },
      { separator: true },
      { label: "Delete", icon: <Trash2 size={12} />, action: () => removeFolder(folder), danger: true },
    ]);

  const duplicate = async (conn: Connection) => {
    await saveConnection({
      name: `${conn.name} (copy)`, type: conn.type, host: conn.host, port: conn.port,
      username: conn.username, auth_type: conn.auth_type, key_path: conn.key_path,
      folder_id: conn.folder_id, notes: conn.notes, description: conn.description,
      domain: conn.domain, rdp_admin: conn.rdp_admin,
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
      { label: "Connect", icon: <Plug size={12} />, action: () => openTab(conn) },
      { label: "Duplicate", icon: <Copy size={12} />, action: () => duplicate(conn) },
      { separator: true },
      { label: "Delete", icon: <Trash2 size={12} />, action: () => remove(conn), danger: true },
    ]);

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

  // Shared props passed down to every FolderItem / ConnItem
  const sharedProps = {
    allFolders: searchQuery ? ([] as FolderType[]) : folders,
    allConnections: searchQuery ? filtered : connections,
    openTab,
    toggleFolder,
    onConnContextMenu: connMenu,
    onFolderContextMenu: folderMenu,
    selectedId: selectedConnectionId,
    onSelect: selectConnection,
    renamingFolderId,
    renameFolderName,
    onRenameChange: setRenameFolderName,
    onRenameConfirm: confirmRenameFolder,
    onRenameCancel: cancelRenameFolder,
    renameInputRef,
    creatingFolder,
    newFolderParentId,
    newFolderName,
    onSubfolderNameChange: setNewFolderName,
    onSubfolderConfirm: confirmCreateFolder,
    onSubfolderCancel: cancelCreateFolder,
    folderInputRef,
    dragId,
    dropTarget,
    onDragStart: setDragId,
    onDragEnd: handleDragEnd,
    onDropTarget: setDropTarget,
    onDropOnConn: handleDropOnConn,
    onDropOnFolder: handleDropOnFolder,
  };

  return (
    <aside className="flex flex-col h-full bg-[var(--color-bg-surface)] border-r border-[var(--color-border)] w-64 shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] shrink-0">
        <span className="font-semibold text-[var(--color-text-primary)] tracking-wide text-xs uppercase">
          Connections
        </span>
        <div className="flex gap-0.5">
          <button onClick={startNewConnection}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
            title="New connection">
            <Plus size={14} />
          </button>
          <button onClick={() => startCreateFolder(null)}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
            title="New folder">
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
      <div className="flex-1 overflow-y-auto min-h-0 py-0.5">

        {/* Root "Conexiones" node */}
        {!searchQuery && (
          <button
            onClick={() => setRootExpanded((v) => !v)}
            className="flex items-center gap-1.5 w-full px-2 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            {rootExpanded
              ? <ChevronDown size={11} className="shrink-0 text-[var(--color-text-muted)]" />
              : <ChevronRight size={11} className="shrink-0 text-[var(--color-text-muted)]" />}
            <Network size={13} className="shrink-0 text-[var(--color-accent)]" />
            <span className="text-xs font-medium flex-1 text-left text-[var(--color-text-primary)]">Conexiones</span>
            <span className="text-[9px] text-[var(--color-text-muted)] opacity-60">{connections.length}</span>
          </button>
        )}

        {/* Tree content */}
        {(searchQuery || rootExpanded) && (
          <div>
            {/* Inline root folder creation */}
            {creatingFolder && newFolderParentId === null && (
              <InlineFolderInput
                value={newFolderName}
                onChange={setNewFolderName}
                onConfirm={confirmCreateFolder}
                onCancel={cancelCreateFolder}
                inputRef={folderInputRef}
                depth={searchQuery ? 0 : 1}
              />
            )}

            {displayFolders.map((folder) => (
              <FolderItem
                key={folder.id}
                folder={folder}
                depth={searchQuery ? 0 : 1}
                {...sharedProps}
              />
            ))}

            {/* Root-level connections (no folder) */}
            {rootConns.map((conn) => (
              <ConnItem
                key={conn.id}
                conn={conn}
                depth={1}
                selected={selectedConnectionId === conn.id}
                onSelect={() => selectConnection(conn.id)}
                onOpen={() => openTab(conn)}
                onContextMenu={(e) => connMenu(e, conn)}
                dragging={dragId === conn.id}
                isDropTarget={dropTarget === conn.id}
                onDragStart={() => setDragId(conn.id)}
                onDragEnd={handleDragEnd}
                onDragOver={() => setDropTarget(conn.id)}
                onDrop={() => handleDropOnConn(conn)}
              />
            ))}

            {connections.length === 0 && (
              <div className="px-4 py-6 text-center text-[var(--color-text-muted)] text-xs">
                <Terminal size={20} className="mx-auto mb-2 opacity-30" />
                <p>No connections yet.</p>
                <button onClick={startNewConnection}
                  className="mt-1 text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">
                  Add the first one
                </button>
              </div>
            )}

            {/* Search: flat list of matching connections with folder hint */}
            {searchQuery && filtered.length === 0 && (
              <div className="px-4 py-4 text-center text-[var(--color-text-muted)] text-xs">
                No results
              </div>
            )}
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
      <div className="border-t border-[var(--color-border)] shrink-0 overflow-hidden" style={{ height: panelHeight }}>
        <PropertiesPanel />
      </div>

      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </aside>
  );
}

// ── Shared types ──────────────────────────────────────────────────────────────

interface SharedProps {
  allFolders: FolderType[];
  allConnections: Connection[];
  openTab: (c: Connection) => void;
  toggleFolder: (id: string) => void;
  onConnContextMenu: (e: React.MouseEvent, c: Connection) => void;
  onFolderContextMenu: (e: React.MouseEvent, f: FolderType) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  renamingFolderId: string | null;
  renameFolderName: string;
  onRenameChange: (v: string) => void;
  onRenameConfirm: () => void;
  onRenameCancel: () => void;
  renameInputRef: React.RefObject<HTMLInputElement>;
  creatingFolder: boolean;
  newFolderParentId: string | null;
  newFolderName: string;
  onSubfolderNameChange: (v: string) => void;
  onSubfolderConfirm: () => void;
  onSubfolderCancel: () => void;
  folderInputRef: React.RefObject<HTMLInputElement>;
  dragId: string | null;
  dropTarget: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDropTarget: (id: string | null) => void;
  onDropOnConn: (c: Connection) => void;
  onDropOnFolder: (folderId: string) => void;
}

// ── InlineFolderInput ─────────────────────────────────────────────────────────

function InlineFolderInput({
  value, onChange, onConfirm, onCancel, inputRef, depth = 0,
}: {
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  inputRef?: React.RefObject<HTMLInputElement>;
  depth?: number;
}) {
  return (
    <div className="flex items-center gap-2 py-1 pr-3" style={{ paddingLeft: `${depth * 14 + 8}px` }}>
      <FolderInputIcon size={13} className="text-[var(--color-text-muted)] shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onConfirm();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={onCancel}
        placeholder="Folder name…"
        className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-2 py-0.5 text-xs text-[var(--color-text-primary)] outline-none"
      />
    </div>
  );
}

// ── FolderItem (recursive) ────────────────────────────────────────────────────

function FolderItem({ folder, depth, ...shared }: { folder: FolderType; depth: number } & SharedProps) {
  const {
    allFolders, allConnections, openTab, toggleFolder,
    onConnContextMenu, onFolderContextMenu, selectedId, onSelect,
    renamingFolderId, renameFolderName, onRenameChange, onRenameConfirm, onRenameCancel, renameInputRef,
    creatingFolder, newFolderParentId, newFolderName,
    onSubfolderNameChange, onSubfolderConfirm, onSubfolderCancel, folderInputRef,
    dragId, dropTarget, onDragStart, onDragEnd, onDropTarget, onDropOnConn, onDropOnFolder,
  } = shared;

  const subfolders = allFolders
    .filter((f) => f.parent_id === folder.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  const myConns = allConnections
    .filter((c) => c.folder_id === folder.id)
    .sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));

  const hasChildren = subfolders.length > 0 || myConns.length > 0;
  const isFolderDropTarget = dropTarget === `folder:${folder.id}`;
  const pl = depth * 14 + 8;
  const Icon = folder.expanded ? FolderOpen : Folder;
  const isRenaming = renamingFolderId === folder.id;
  const creatingSubfolder = creatingFolder && newFolderParentId === folder.id;

  return (
    <div>
      {isRenaming ? (
        <div className="flex items-center gap-2 py-1 pr-3" style={{ paddingLeft: `${pl}px` }}>
          <Icon size={13} className="text-amber-400 shrink-0" />
          <input
            ref={renameInputRef}
            type="text"
            value={renameFolderName}
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameConfirm();
              if (e.key === "Escape") onRenameCancel();
            }}
            onBlur={onRenameCancel}
            className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-2 py-0.5 text-xs text-[var(--color-text-primary)] outline-none"
          />
        </div>
      ) : (
        <button
          onClick={() => toggleFolder(folder.id)}
          onContextMenu={(e) => onFolderContextMenu(e, folder)}
          onDragOver={(e) => { e.preventDefault(); onDropTarget(`folder:${folder.id}`); }}
          onDragLeave={() => onDropTarget(null)}
          onDrop={(e) => { e.preventDefault(); onDropOnFolder(folder.id); }}
          style={{ paddingLeft: `${pl}px` }}
          className={[
            "flex items-center gap-1.5 w-full py-1 pr-3 transition-colors text-left",
            isFolderDropTarget
              ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]",
          ].join(" ")}
        >
          {/* Chevron */}
          {hasChildren ? (
            folder.expanded
              ? <ChevronDown size={10} className="shrink-0 opacity-60" />
              : <ChevronRight size={10} className="shrink-0 opacity-60" />
          ) : (
            <span className="w-2.5 shrink-0" />
          )}
          {/* Folder icon in amber */}
          <Icon size={13} className="text-amber-400 shrink-0" />
          <span className="text-xs truncate flex-1">{folder.name}</span>
          {myConns.length > 0 && (
            <span className="text-[9px] opacity-40 shrink-0 ml-1">{myConns.length}</span>
          )}
        </button>
      )}

      {folder.expanded && (
        <div>
          {/* Subfolder creation input */}
          {creatingSubfolder && (
            <InlineFolderInput
              value={newFolderName}
              onChange={onSubfolderNameChange}
              onConfirm={onSubfolderConfirm}
              onCancel={onSubfolderCancel}
              inputRef={folderInputRef}
              depth={depth + 1}
            />
          )}

          {/* Recursive subfolders */}
          {subfolders.map((sub) => (
            <FolderItem key={sub.id} folder={sub} depth={depth + 1} {...shared} />
          ))}

          {/* Connections in this folder */}
          {myConns.map((conn) => (
            <ConnItem
              key={conn.id}
              conn={conn}
              depth={depth + 1}
              selected={selectedId === conn.id}
              onSelect={() => onSelect(conn.id)}
              onOpen={() => openTab(conn)}
              onContextMenu={(e) => onConnContextMenu(e, conn)}
              dragging={dragId === conn.id}
              isDropTarget={dropTarget === conn.id}
              onDragStart={() => onDragStart(conn.id)}
              onDragEnd={onDragEnd}
              onDragOver={() => onDropTarget(conn.id)}
              onDrop={() => onDropOnConn(conn)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── ConnItem ──────────────────────────────────────────────────────────────────

function ConnItem({
  conn, depth, selected, onSelect, onOpen, onContextMenu,
  dragging = false, isDropTarget = false,
  onDragStart, onDragEnd, onDragOver, onDrop,
}: {
  conn: Connection;
  depth: number;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  dragging?: boolean;
  isDropTarget?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOver?: () => void;
  onDrop?: () => void;
}) {
  const typeColors: Record<string, string> = {
    ssh:  "text-[var(--color-success)]  bg-[var(--color-success)]/10",
    rdp:  "text-[var(--color-accent)]   bg-[var(--color-accent)]/10",
    vnc:  "text-purple-400 bg-purple-400/10",
    ftp:  "text-yellow-400 bg-yellow-400/10",
    sftp: "text-cyan-400   bg-cyan-400/10",
  };

  const TypeIcon = () => {
    switch (conn.type) {
      case "ssh":  return <TuxIcon     size={12} className="shrink-0" />;
      case "rdp":  return <WindowsIcon size={12} className="shrink-0" />;
      case "vnc":  return <VncIcon     size={12} className="shrink-0" />;
      case "ftp":  return <FtpIcon     size={12} className="shrink-0" />;
      case "sftp": return <SftpIcon    size={12} className="shrink-0" />;
      default:     return <TuxIcon     size={12} className="shrink-0" />;
    }
  };

  const pl = depth * 14 + 8;

  return (
    <button
      draggable
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onDragStart={(e) => { e.stopPropagation(); onDragStart?.(); }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => { e.preventDefault(); onDragOver?.(); }}
      onDrop={(e) => { e.preventDefault(); onDrop?.(); }}
      style={{ paddingLeft: `${pl}px` }}
      className={[
        "flex items-center gap-2 w-full py-1.5 pr-3 transition-colors text-left",
        dragging ? "opacity-40" : "",
        isDropTarget ? "border-t-2 border-[var(--color-accent)]" : "",
        selected
          ? "bg-[var(--color-accent)]/20 text-[var(--color-accent-hover)]"
          : "hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
      ].join(" ")}
    >
      <TypeIcon />
      <span className="text-xs truncate flex-1">{conn.name}</span>
      <span
        className={`text-[9px] uppercase font-semibold px-1 rounded shrink-0 ${
          typeColors[conn.type] ?? "text-[var(--color-text-muted)] bg-[var(--color-bg-elevated)]"
        }`}
      >
        {conn.type}
      </span>
    </button>
  );
}
