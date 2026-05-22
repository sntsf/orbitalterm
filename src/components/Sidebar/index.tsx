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

  const [panelHeight, setPanelHeight] = useState(() => {
    const saved = localStorage.getItem("orbitalterm:panelHeight");
    return saved ? Math.max(120, Math.min(600, Number(saved))) : 320;
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("orbitalterm:sidebarWidth");
    return saved ? Math.max(180, Math.min(520, Number(saved))) : 256;
  });

  // Persist sizes
  useEffect(() => { localStorage.setItem("orbitalterm:panelHeight", String(panelHeight)); }, [panelHeight]);
  useEffect(() => { localStorage.setItem("orbitalterm:sidebarWidth", String(sidebarWidth)); }, [sidebarWidth]);

  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  // Sidebar horizontal resize
  const sidebarDragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

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
      setPanelHeight(Math.max(120, Math.min(600, startH.current + delta)));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onSidebarResizeDown = (e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDragging.current = true;
    startX.current = e.clientX;
    startW.current = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      if (!sidebarDragging.current) return;
      const delta = ev.clientX - startX.current;
      setSidebarWidth(Math.max(180, Math.min(520, startW.current + delta)));
    };
    const onUp = () => {
      sidebarDragging.current = false;
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
    <aside
      className="flex flex-col h-full bg-[var(--color-bg-surface)] border-r border-[var(--color-border)] shrink-0 relative"
      style={{ width: sidebarWidth }}
    >
      {/* Right-edge drag handle for sidebar width */}
      <div
        onMouseDown={onSidebarResizeDown}
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-20 hover:bg-[var(--color-accent)] transition-colors"
        title="Drag to resize sidebar"
      />
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] shrink-0">
        <img
          src="/logo_icon.png"
          alt="OrbitalTerm"
          className="h-6 w-auto object-contain select-none"
          draggable={false}
        />
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
              <div className="flex items-center gap-1 py-0.5 pr-2">
                <TreePrefix continuations={[]} isLast={false} />
                <FolderInputIcon size={11} className="text-[var(--color-text-muted)] shrink-0" />
                <input
                  ref={folderInputRef}
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmCreateFolder();
                    if (e.key === "Escape") cancelCreateFolder();
                  }}
                  onBlur={cancelCreateFolder}
                  placeholder="Nombre de carpeta…"
                  className="flex-1 ml-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-1 py-0 text-[11px] text-[var(--color-text-primary)] outline-none"
                />
              </div>
            )}

            {(() => {
              // Build combined root child list for correct isLast calculation
              const rootChildren: Array<
                { kind: "folder"; item: FolderType } | { kind: "conn"; item: Connection }
              > = [
                ...displayFolders.map((f) => ({ kind: "folder" as const, item: f })),
                ...rootConns.map((c) => ({ kind: "conn" as const, item: c })),
              ];
              return rootChildren.map((child, idx) => {
                const childIsLast = idx === rootChildren.length - 1;
                if (child.kind === "folder") {
                  return (
                    <FolderItem
                      key={child.item.id}
                      folder={child.item}
                      continuations={[]}
                      isLast={childIsLast}
                      {...sharedProps}
                    />
                  );
                } else {
                  const conn = child.item;
                  return (
                    <ConnItem
                      key={conn.id}
                      conn={conn}
                      continuations={[]}
                      isLast={childIsLast}
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
                  );
                }
              });
            })()}

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
      <div className="border-t border-[var(--color-border)] shrink-0 overflow-y-auto" style={{ height: panelHeight }}>
        <PropertiesPanel />
      </div>

      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </aside>
  );
}

// ── Tree prefix ───────────────────────────────────────────────────────────────

function TreePrefix({ continuations, isLast }: { continuations: boolean[]; isLast: boolean }) {
  return (
    <span
      className="font-mono shrink-0 select-none text-[var(--color-border)]"
      style={{ fontSize: "10px", whiteSpace: "pre", lineHeight: 1 }}
    >
      {continuations.map((c) => (c ? "│  " : "   ")).join("")}{isLast ? "└─" : "├─"}{" "}
    </span>
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

// ── FolderItem (recursive) ────────────────────────────────────────────────────

function FolderItem({
  folder, continuations, isLast, ...shared
}: { folder: FolderType; continuations: boolean[]; isLast: boolean } & SharedProps) {
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

  const isFolderDropTarget = dropTarget === `folder:${folder.id}`;
  const Icon = folder.expanded ? FolderOpen : Folder;
  const isRenaming = renamingFolderId === folder.id;
  const creatingSubfolder = creatingFolder && newFolderParentId === folder.id;
  const childContinuations = [...continuations, !isLast];

  // Combined children for consistent "isLast" calculation
  const childItems: Array<{ kind: "folder"; item: FolderType } | { kind: "conn"; item: Connection }> = [
    ...subfolders.map((f) => ({ kind: "folder" as const, item: f })),
    ...myConns.map((c) => ({ kind: "conn" as const, item: c })),
  ];

  return (
    <div>
      {isRenaming ? (
        <div className="flex items-center gap-1 py-0.5 pr-3">
          <TreePrefix continuations={continuations} isLast={isLast} />
          <Icon size={12} className="text-amber-400 shrink-0" />
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
            className="flex-1 ml-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-1 py-0 text-[11px] text-[var(--color-text-primary)] outline-none"
          />
        </div>
      ) : (
        <button
          onClick={() => toggleFolder(folder.id)}
          onContextMenu={(e) => onFolderContextMenu(e, folder)}
          onDragOver={(e) => { e.preventDefault(); onDropTarget(`folder:${folder.id}`); }}
          onDragLeave={() => onDropTarget(null)}
          onDrop={(e) => { e.preventDefault(); onDropOnFolder(folder.id); }}
          className={[
            "flex items-center w-full py-0.5 pr-2 transition-colors text-left",
            isFolderDropTarget
              ? "bg-[var(--color-accent)]/20 text-amber-400"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]",
          ].join(" ")}
        >
          <TreePrefix continuations={continuations} isLast={isLast} />
          <Icon size={12} className="text-amber-400 shrink-0" />
          <span className="text-[11px] truncate flex-1 ml-1 text-left font-medium">{folder.name}</span>
          {folder.expanded
            ? <ChevronDown size={9} className="shrink-0 opacity-40 mr-0.5" />
            : <ChevronRight size={9} className="shrink-0 opacity-30 mr-0.5" />}
        </button>
      )}

      {folder.expanded && (
        <div>
          {creatingSubfolder && (
            <div className="flex items-center gap-1 py-0.5 pr-2">
              <TreePrefix continuations={childContinuations} isLast={childItems.length === 0} />
              <FolderInputIcon size={11} className="text-[var(--color-text-muted)] shrink-0" />
              <input
                ref={folderInputRef}
                type="text"
                value={newFolderName}
                onChange={(e) => onSubfolderNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubfolderConfirm();
                  if (e.key === "Escape") onSubfolderCancel();
                }}
                onBlur={onSubfolderCancel}
                placeholder="Nombre de carpeta…"
                className="flex-1 ml-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-1 py-0 text-[11px] text-[var(--color-text-primary)] outline-none"
              />
            </div>
          )}

          {childItems.map((child, idx) => {
            const childIsLast = idx === childItems.length - 1;
            if (child.kind === "folder") {
              return (
                <FolderItem
                  key={child.item.id}
                  folder={child.item}
                  continuations={childContinuations}
                  isLast={childIsLast}
                  {...shared}
                />
              );
            } else {
              const conn = child.item;
              return (
                <ConnItem
                  key={conn.id}
                  conn={conn}
                  continuations={childContinuations}
                  isLast={childIsLast}
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
              );
            }
          })}
        </div>
      )}
    </div>
  );
}

// ── ConnItem ──────────────────────────────────────────────────────────────────

const connTypeColors: Record<string, string> = {
  ssh:  "text-[var(--color-success)] bg-[var(--color-success)]/10",
  rdp:  "text-[var(--color-accent)] bg-[var(--color-accent)]/10",
  vnc:  "text-purple-400 bg-purple-400/10",
  ftp:  "text-yellow-400 bg-yellow-400/10",
  sftp: "text-cyan-400 bg-cyan-400/10",
};

function ConnItem({
  conn, continuations, isLast, selected, onSelect, onOpen, onContextMenu,
  dragging = false, isDropTarget = false,
  onDragStart, onDragEnd, onDragOver, onDrop,
}: {
  conn: Connection;
  continuations: boolean[];
  isLast: boolean;
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
  const TypeIcon = () => {
    switch (conn.type) {
      case "ssh":  return <TuxIcon size={11} className="shrink-0" />;
      case "rdp":  return <WindowsIcon size={11} className="shrink-0" />;
      case "vnc":  return <VncIcon size={11} className="shrink-0" />;
      case "ftp":  return <FtpIcon size={11} className="shrink-0" />;
      case "sftp": return <SftpIcon size={11} className="shrink-0" />;
      default:     return <TuxIcon size={11} className="shrink-0" />;
    }
  };

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
      className={[
        "flex items-center w-full py-0.5 pr-2 transition-colors text-left",
        dragging ? "opacity-40" : "",
        isDropTarget ? "border-t-2 border-[var(--color-accent)]" : "",
        selected
          ? "bg-[var(--color-accent)]/20 text-[var(--color-accent-hover)]"
          : "hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
      ].join(" ")}
    >
      <TreePrefix continuations={continuations} isLast={isLast} />
      <TypeIcon />
      <span className="text-[11px] truncate flex-1 ml-1">{conn.name}</span>
      <span className={`text-[8px] uppercase font-semibold px-1 rounded shrink-0 ml-1 ${connTypeColors[conn.type] ?? "text-[var(--color-text-muted)] bg-[var(--color-bg-elevated)]"}`}>
        {conn.type}
      </span>
    </button>
  );
}
