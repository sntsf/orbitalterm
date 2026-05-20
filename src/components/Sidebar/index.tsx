import { useEffect, useRef, useState } from "react";
import {
  Plus, Search, FolderOpen, Folder, Terminal,
  Copy, Trash2, Plug, FolderPlus, Edit2, FolderInput as FolderInputIcon,
} from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import {
  getConnections, getFolders, deleteConnection, saveConnection,
  saveFolder, deleteFolder, getFolders as refetchFolders,
} from "../../lib/commands";
import { ContextMenu, useContextMenu } from "../ContextMenu";
import { PropertiesPanel } from "../PropertiesPanel";
import { TuxIcon, WindowsIcon, VncIcon, FtpIcon, SftpIcon } from "../ConnectionIcons";
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

  // Inline folder creation state
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Folder rename state
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderName, setRenameFolderName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getConnections().then(setConnections).catch(console.error);
    getFolders().then(setFolders).catch(console.error);
  }, []);

  useEffect(() => {
    if (creatingFolder && folderInputRef.current) {
      folderInputRef.current.focus();
    }
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
          c.host.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : connections;

  const rootConns = filtered.filter((c) => !c.folder_id);
  const folderConns = (folderId: string) => filtered.filter((c) => c.folder_id === folderId);

  // Start creating a root folder
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
      } catch (err) {
        console.error(err);
      }
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

  // Folder rename handlers
  const startRenameFolder = (folder: FolderType) => {
    setRenamingFolderId(folder.id);
    setRenameFolderName(folder.name);
  };

  const confirmRenameFolder = async () => {
    // Note: save_folder with same id would be update; but our backend only has save_folder
    // We use a workaround: delete and recreate isn't ideal, so we just skip for now
    // and close the rename UI. A proper rename command would be needed for persistence.
    setRenamingFolderId(null);
    setRenameFolderName("");
  };

  const cancelRenameFolder = () => {
    setRenamingFolderId(null);
    setRenameFolderName("");
  };

  // Remove a folder and refresh
  const removeFolder = async (folder: FolderType) => {
    try {
      await deleteFolder(folder.id);
      setFolders(await refetchFolders());
      setConnections(await getConnections());
    } catch (err) {
      console.error(err);
    }
  };

  // Folder context menu
  const folderMenu = (e: React.MouseEvent, folder: FolderType) =>
    openMenu(e, [
      {
        label: "New subfolder",
        icon: <FolderPlus size={12} />,
        action: () => startCreateFolder(folder.id),
      },
      {
        label: "Rename",
        icon: <Edit2 size={12} />,
        action: () => startRenameFolder(folder),
      },
      { separator: true },
      {
        label: "Delete",
        icon: <Trash2 size={12} />,
        action: () => removeFolder(folder),
        danger: true,
      },
    ]);

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
      rdp_admin: conn.rdp_admin,
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
            onClick={() => startCreateFolder(null)}
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
            onFolderContextMenu={folderMenu}
            selectedId={selectedConnectionId}
            onSelect={selectConnection}
            isRenaming={renamingFolderId === folder.id}
            renameName={renameFolderName}
            onRenameChange={setRenameFolderName}
            onRenameConfirm={confirmRenameFolder}
            onRenameCancel={cancelRenameFolder}
            renameInputRef={renamingFolderId === folder.id ? renameInputRef : undefined}
            creatingSubfolder={creatingFolder && newFolderParentId === folder.id}
            subfoldersNewName={creatingFolder && newFolderParentId === folder.id ? newFolderName : ""}
            onSubfolderNameChange={setNewFolderName}
            onSubfolderConfirm={confirmCreateFolder}
            onSubfolderCancel={cancelCreateFolder}
            subfolderInputRef={creatingFolder && newFolderParentId === folder.id ? folderInputRef : undefined}
          />
        ))}

        {/* Inline root folder creation */}
        {creatingFolder && newFolderParentId === null && (
          <InlineFolderInput
            value={newFolderName}
            onChange={setNewFolderName}
            onConfirm={confirmCreateFolder}
            onCancel={cancelCreateFolder}
            inputRef={folderInputRef}
          />
        )}

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

function InlineFolderInput({
  value, onChange, onConfirm, onCancel, inputRef, indent = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  inputRef?: React.RefObject<HTMLInputElement>;
  indent?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1 ${indent ? "pl-8" : "pl-3"}`}>
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

function FolderItem({
  folder, connections, onOpen, onToggle, onContextMenu, onFolderContextMenu,
  selectedId, onSelect,
  isRenaming, renameName, onRenameChange, onRenameConfirm, onRenameCancel, renameInputRef,
  creatingSubfolder, subfoldersNewName, onSubfolderNameChange, onSubfolderConfirm,
  onSubfolderCancel, subfolderInputRef,
}: {
  folder: FolderType;
  connections: Connection[];
  onOpen: (c: Connection) => void;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent, c: Connection) => void;
  onFolderContextMenu: (e: React.MouseEvent, f: FolderType) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  isRenaming: boolean;
  renameName: string;
  onRenameChange: (v: string) => void;
  onRenameConfirm: () => void;
  onRenameCancel: () => void;
  renameInputRef?: React.RefObject<HTMLInputElement>;
  creatingSubfolder: boolean;
  subfoldersNewName: string;
  onSubfolderNameChange: (v: string) => void;
  onSubfolderConfirm: () => void;
  onSubfolderCancel: () => void;
  subfolderInputRef?: React.RefObject<HTMLInputElement>;
}) {
  const Icon = folder.expanded ? FolderOpen : Folder;
  return (
    <div>
      {isRenaming ? (
        <div className="flex items-center gap-2 px-3 py-1">
          <Icon size={13} className="text-[var(--color-text-muted)] shrink-0" />
          <input
            ref={renameInputRef}
            type="text"
            value={renameName}
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
          onClick={onToggle}
          onContextMenu={(e) => onFolderContextMenu(e, folder)}
          className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <Icon size={13} />
          <span className="text-xs truncate flex-1 text-left">{folder.name}</span>
        </button>
      )}
      {folder.expanded && (
        <>
          {creatingSubfolder && (
            <InlineFolderInput
              value={subfoldersNewName}
              onChange={onSubfolderNameChange}
              onConfirm={onSubfolderConfirm}
              onCancel={onSubfolderCancel}
              inputRef={subfolderInputRef}
              indent
            />
          )}
          {connections.map((conn) => (
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
        </>
      )}
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
  const typeColors: Record<string, string> = {
    ssh: "text-[var(--color-success)] bg-[var(--color-success)]/10",
    rdp: "text-[var(--color-accent)] bg-[var(--color-accent)]/10",
    vnc: "text-purple-400 bg-purple-400/10",
    ftp: "text-yellow-400 bg-yellow-400/10",
    sftp: "text-cyan-400 bg-cyan-400/10",
  };

  const TypeIcon = () => {
    switch (conn.type) {
      case "ssh": return <TuxIcon size={12} className="shrink-0" />;
      case "rdp": return <WindowsIcon size={12} className="shrink-0" />;
      case "vnc": return <VncIcon size={12} className="shrink-0" />;
      case "ftp": return <FtpIcon size={12} className="shrink-0" />;
      case "sftp": return <SftpIcon size={12} className="shrink-0" />;
      default: return <TuxIcon size={12} className="shrink-0" />;
    }
  };

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
      <TypeIcon />
      <span className="text-xs truncate flex-1">{conn.name}</span>
      <span
        className={`text-[9px] uppercase font-semibold px-1 rounded ${
          typeColors[conn.type] ?? "text-[var(--color-text-muted)] bg-[var(--color-bg-elevated)]"
        }`}
      >
        {conn.type}
      </span>
    </button>
  );
}
