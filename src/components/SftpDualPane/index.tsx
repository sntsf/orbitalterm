import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  ChevronLeft, ChevronRight, RefreshCw, FolderPlus, Pencil, Trash2,
  ArrowRight, ArrowLeft, Loader, WifiOff, HardDrive, Home, Eye, EyeOff,
  File, Folder,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../store/useAppStore";
import {
  sftpConnect, sftpDisconnect, sftpListDir, sftpUpload, sftpDownload,
  sftpMkdir, sftpRename, sftpDelete,
  localListDir, localGetHome, localGetParent, localMkdir,
} from "../../lib/commands";
import type { LocalEntry } from "../../lib/commands";
import type { SftpEntry } from "../../types";
import type { Tab } from "../../types";

// Re-export LocalEntry so the rest of the file can use it without duplication
type AnyEntry = (SftpEntry | LocalEntry) & { is_dir: boolean; name: string; path: string; size: number };

interface SftpProgress { transferred: number; total: number }
interface CtxMenu { x: number; y: number; side: "local" | "remote"; entry?: AnyEntry }

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(b: number) {
  if (b === 0) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(1)} GB`;
}

function formatDate(ts: number) {
  return ts ? new Date(ts * 1000).toLocaleDateString() : "—";
}

// ── File Panel ────────────────────────────────────────────────────────────────

interface PanelProps {
  title: string;
  accentClass: string;           // tailwind text-color class for header
  path: string;
  entries: AnyEntry[];
  selected: Set<string>;
  loading: boolean;
  error: string | null;
  showHidden: boolean;
  onToggleHidden: () => void;
  onNavigate: (path: string) => void;
  onUp: () => void;
  onHome: () => void;
  onRefresh: () => void;
  onSelect: (e: React.MouseEvent, entry: AnyEntry) => void;
  onCtxMenu: (e: React.MouseEvent, entry?: AnyEntry) => void;
  onMkdir?: () => void;
  renamingPath?: string;
  renameValue?: string;
  onRenameChange?: (v: string) => void;
  onRenameCommit?: () => void;
  onRenameCancel?: () => void;
}

function FilePanel({
  title, accentClass, path, entries, selected, loading, error,
  showHidden, onToggleHidden,
  onNavigate, onUp, onHome, onRefresh, onSelect, onCtxMenu,
  onMkdir,
  renamingPath, renameValue, onRenameChange, onRenameCommit, onRenameCancel,
}: PanelProps) {
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState(path);
  const pathRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setPathInput(path); }, [path]);
  useEffect(() => { if (editingPath) { pathRef.current?.focus(); pathRef.current?.select(); } }, [editingPath]);
  useEffect(() => { if (renamingPath) { renameRef.current?.focus(); renameRef.current?.select(); } }, [renamingPath]);

  const commitPath = () => {
    setEditingPath(false);
    const p = pathInput.trim() || "/";
    if (p !== path) onNavigate(p);
  };

  const visible = showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));

  return (
    <div
      className="flex flex-col h-full bg-[var(--color-bg-surface)] min-w-0"
      onContextMenu={(e) => { e.preventDefault(); onCtxMenu(e); }}
    >
      {/* Header */}
      <div className={`flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] shrink-0 ${accentClass}`}>
        <span className="text-[10px] font-semibold uppercase tracking-wider">{title}</span>
        <span className="ml-auto text-[10px] opacity-60">{visible.length} elementos</span>
      </div>

      {/* Path bar */}
      <div className="flex items-center gap-0.5 px-1 py-0.5 border-b border-[var(--color-border)] shrink-0 bg-[var(--color-bg-elevated)]">
        <button onClick={onUp} title="Subir un nivel"
          className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors">
          <ChevronLeft size={11} />
        </button>
        <button onClick={onHome} title="Inicio"
          className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors">
          <Home size={11} />
        </button>
        {editingPath ? (
          <input ref={pathRef} value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitPath();
              if (e.key === "Escape") { setEditingPath(false); setPathInput(path); }
            }}
            onBlur={commitPath}
            className="flex-1 bg-transparent border border-[var(--color-accent)] rounded px-1.5 py-0 text-[10px] font-mono text-[var(--color-text-primary)] outline-none"
          />
        ) : (
          <button onClick={() => setEditingPath(true)}
            className="flex-1 text-left text-[10px] font-mono text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] truncate px-1"
            title={path}>{path}
          </button>
        )}
        <button onClick={onToggleHidden} title={showHidden ? "Ocultar archivos ocultos" : "Mostrar archivos ocultos"}
          className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors">
          {showHidden ? <EyeOff size={11} /> : <Eye size={11} />}
        </button>
        <button onClick={onRefresh} title="Refrescar"
          className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors">
          <RefreshCw size={11} />
        </button>
        {onMkdir && (
          <button onClick={onMkdir} title="Nueva carpeta"
            className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors">
            <FolderPlus size={11} />
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="px-2 py-1 text-[10px] text-[var(--color-danger)] bg-[var(--color-danger)]/10 shrink-0">
          {error}
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto min-h-0 text-xs">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader size={16} className="animate-spin text-[var(--color-text-muted)]" />
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-[var(--color-bg-surface)] z-10">
              <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)] text-[10px]">
                <th className="text-left px-2 py-0.5 font-medium">Nombre</th>
                <th className="text-right px-2 py-0.5 font-medium w-16">Tamaño</th>
                <th className="text-right px-2 py-0.5 font-medium w-20">Modificado</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => {
                const isSel = selected.has(entry.path);
                return (
                  <tr
                    key={entry.path}
                    className={`cursor-pointer border-b border-[var(--color-border)]/30 ${
                      isSel
                        ? "bg-[var(--color-accent)]/20"
                        : "hover:bg-[var(--color-bg-hover)]"
                    }`}
                    onClick={(e) => onSelect(e, entry)}
                    onDoubleClick={() => { if (entry.is_dir) onNavigate(entry.path); }}
                    onContextMenu={(e) => { e.stopPropagation(); onCtxMenu(e, entry); }}
                  >
                    <td className="px-2 py-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {entry.is_dir
                          ? <Folder size={11} className="text-[var(--color-accent)] shrink-0" />
                          : <File size={11} className={isSel ? "text-[var(--color-accent)] shrink-0" : "text-[var(--color-text-muted)] shrink-0"} />}
                        {renamingPath === entry.path ? (
                          <input
                            ref={renameRef}
                            value={renameValue}
                            onChange={(e) => onRenameChange?.(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") onRenameCommit?.();
                              if (e.key === "Escape") onRenameCancel?.();
                            }}
                            onBlur={onRenameCommit}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 min-w-0 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-1 py-0 text-[11px] text-[var(--color-text-primary)] outline-none"
                          />
                        ) : (
                          <span className="truncate text-[var(--color-text-primary)] text-[11px]" title={entry.name}>
                            {entry.name}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-0.5 text-right text-[var(--color-text-muted)] text-[10px] whitespace-nowrap">
                      {entry.is_dir ? "—" : formatBytes(entry.size)}
                    </td>
                    <td className="px-2 py-0.5 text-right text-[var(--color-text-muted)] text-[10px] whitespace-nowrap">
                      {formatDate(entry.modified as number)}
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && !loading && (
                <tr>
                  <td colSpan={3} className="px-2 py-6 text-center text-[var(--color-text-muted)] text-xs">
                    Carpeta vacía
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Selection status */}
      <div className="px-2 py-0.5 border-t border-[var(--color-border)] shrink-0 text-[10px] text-[var(--color-text-muted)] bg-[var(--color-bg-elevated)]">
        {selected.size > 0
          ? `${selected.size} seleccionado${selected.size > 1 ? "s" : ""}`
          : `${visible.length} elemento${visible.length !== 1 ? "s" : ""}`}
      </div>
    </div>
  );
}

// ── Main dual-pane component ──────────────────────────────────────────────────

export function SftpDualPane({ tab }: { tab: Tab }) {
  const { getConnectionById, setTabStatus } = useAppStore();
  const connection = getConnectionById(tab.connection_id);

  // SFTP session
  const sessionIdRef = useRef<string | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [connError, setConnError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  // Local panel
  const [localPath, setLocalPath] = useState("");
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([]);
  const [localSelected, setLocalSelected] = useState<Set<string>>(new Set());
  const localLastClick = useRef<string | null>(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showLocalHidden, setShowLocalHidden] = useState(false);

  // Remote panel
  const [remotePath, setRemotePath] = useState("/");
  const [remoteEntries, setRemoteEntries] = useState<SftpEntry[]>([]);
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(new Set());
  const remoteLastClick = useRef<string | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [showRemoteHidden, setShowRemoteHidden] = useState(false);

  // Remote inline actions
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newFolderMode, setNewFolderMode] = useState<"local" | "remote" | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const newFolderRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (newFolderMode) newFolderRef.current?.focus(); }, [newFolderMode]);

  // Transfer state
  const [transferring, setTransferring] = useState(false);
  const [transferLabel, setTransferLabel] = useState<string | null>(null);
  const [progress, setProgress] = useState<SftpProgress>({ transferred: 0, total: 0 });

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  // ── Local navigation ────────────────────────────────────────────────────────

  const loadLocal = useCallback(async (path: string) => {
    setLocalLoading(true);
    setLocalError(null);
    try {
      const result = await localListDir(path);
      setLocalEntries(result as LocalEntry[]);
      setLocalPath(path);
      setLocalSelected(new Set());
      localLastClick.current = null;
    } catch (err) {
      setLocalError(String(err));
    } finally {
      setLocalLoading(false);
    }
  }, []);

  const localUp = async () => {
    const parent = await localGetParent(localPath);
    if (parent !== localPath) loadLocal(parent);
  };

  const localHome = async () => {
    const home = await localGetHome();
    loadLocal(home);
  };

  // ── Remote navigation ───────────────────────────────────────────────────────

  const loadRemote = useCallback(async (sid: string, path: string) => {
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      const result = await sftpListDir(sid, path);
      setRemoteEntries(result);
      setRemotePath(path);
      setRemoteSelected(new Set());
      remoteLastClick.current = null;
    } catch (err) {
      const s = String(err);
      if (s.includes("session not found") || s.includes("closed")) setDisconnected(true);
      else setRemoteError(s);
    } finally {
      setRemoteLoading(false);
    }
  }, []);

  const remoteUp = () => {
    if (remotePath === "/" || !sessionIdRef.current) return;
    const parts = remotePath.split("/").filter(Boolean);
    parts.pop();
    loadRemote(sessionIdRef.current, "/" + parts.join("/"));
  };

  const remoteHome = () => {
    if (!sessionIdRef.current) return;
    const home = connection?.username ? `/home/${connection.username}` : "/";
    loadRemote(sessionIdRef.current, home);
  };

  // ── SFTP connect / reconnect ────────────────────────────────────────────────

  const connectSftp = useCallback(async () => {
    if (!connection) return;
    setConnecting(true);
    setConnError(null);
    setDisconnected(false);
    try {
      const sid = await sftpConnect(connection.id);
      sessionIdRef.current = sid;
      setTabStatus(tab.id, "connected");
      const home = connection.username ? `/home/${connection.username}` : "/";
      // Try home dir, fall back to root
      try { await loadRemote(sid, home); } catch { await loadRemote(sid, "/"); }
    } catch (err) {
      setConnError(String(err));
      setTabStatus(tab.id, "error");
    } finally {
      setConnecting(false);
    }
  }, [connection, tab.id, setTabStatus, loadRemote]);

  // ── Initial load ────────────────────────────────────────────────────────────

  useEffect(() => {
    localGetHome().then((home) => loadLocal(home)).catch(console.error);
    connectSftp();
    return () => {
      if (sessionIdRef.current) {
        sftpDisconnect(sessionIdRef.current).catch(console.error);
      }
    };
  }, [tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Progress listeners ──────────────────────────────────────────────────────

  useEffect(() => {
    const cleanups: (() => void)[] = [];
    listen<SftpProgress>("sftp-upload-progress", (e) => setProgress(e.payload))
      .then((fn) => cleanups.push(fn));
    listen<SftpProgress>("sftp-download-progress", (e) => setProgress(e.payload))
      .then((fn) => cleanups.push(fn));
    return () => cleanups.forEach((fn) => fn());
  }, []);

  // ── Selection helpers ───────────────────────────────────────────────────────

  function makeToggle<T extends AnyEntry>(
    entries: T[],
    setSelected: React.Dispatch<React.SetStateAction<Set<string>>>,
    lastClick: React.MutableRefObject<string | null>,
  ) {
    return (e: React.MouseEvent, entry: T) => {
      if (e.shiftKey && lastClick.current) {
        const li = entries.findIndex((en) => en.path === lastClick.current);
        const ci = entries.findIndex((en) => en.path === entry.path);
        const start = Math.min(li, ci);
        const end = Math.max(li, ci);
        setSelected(new Set(entries.slice(start, end + 1).map((en) => en.path)));
        return;
      }
      lastClick.current = entry.path;
      if (e.ctrlKey || e.metaKey) {
        setSelected((prev) => {
          const next = new Set(prev);
          next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path);
          return next;
        });
      } else {
        setSelected(new Set([entry.path]));
      }
    };
  }

  const toggleLocal = makeToggle(
    localEntries as AnyEntry[],
    setLocalSelected,
    localLastClick,
  );

  const toggleRemote = makeToggle(
    remoteEntries as AnyEntry[],
    setRemoteSelected,
    remoteLastClick,
  );

  // ── Transfer: local → remote (upload) ──────────────────────────────────────

  const handleUpload = async () => {
    if (!sessionIdRef.current || transferring) return;
    const toUpload = localEntries.filter(
      (e) => localSelected.has(e.path) && !e.is_dir,
    );
    if (toUpload.length === 0) return;

    setTransferring(true);
    for (const entry of toUpload) {
      const remoteDest =
        remotePath === "/"
          ? `/${entry.name}`
          : `${remotePath}/${entry.name}`;
      flushSync(() => {
        setTransferLabel(`↑ ${entry.name}`);
        setProgress({ transferred: 0, total: entry.size });
      });
      try {
        await sftpUpload(sessionIdRef.current!, entry.path, remoteDest);
      } catch (err) {
        setRemoteError(String(err));
        break;
      }
    }
    setTransferLabel(null);
    setTransferring(false);
    if (sessionIdRef.current) loadRemote(sessionIdRef.current, remotePath);
  };

  // ── Transfer: remote → local (download) ────────────────────────────────────

  const handleDownload = async () => {
    if (!sessionIdRef.current || transferring) return;
    const toDownload = remoteEntries.filter(
      (e) => remoteSelected.has(e.path) && !e.is_dir,
    );
    if (toDownload.length === 0) return;

    setTransferring(true);
    for (const entry of toDownload) {
      const localDest = localPath.endsWith("/")
        ? `${localPath}${entry.name}`
        : `${localPath}/${entry.name}`;
      flushSync(() => {
        setTransferLabel(`↓ ${entry.name}`);
        setProgress({ transferred: 0, total: entry.size });
      });
      try {
        await sftpDownload(sessionIdRef.current!, entry.path, localDest);
      } catch (err) {
        setLocalError(String(err));
        break;
      }
    }
    setTransferLabel(null);
    setTransferring(false);
    loadLocal(localPath);
  };

  // ── Remote mkdir ────────────────────────────────────────────────────────────

  const handleRemoteMkdir = async () => {
    const name = newFolderName.trim();
    setNewFolderMode(null);
    setNewFolderName("");
    if (!name || !sessionIdRef.current) return;
    const path = remotePath === "/" ? `/${name}` : `${remotePath}/${name}`;
    try {
      await sftpMkdir(sessionIdRef.current, path);
      loadRemote(sessionIdRef.current, remotePath);
    } catch (err) {
      setRemoteError(String(err));
    }
  };

  const handleLocalMkdir = async () => {
    const name = newFolderName.trim();
    setNewFolderMode(null);
    setNewFolderName("");
    if (!name) return;
    const path = localPath.endsWith("/") ? `${localPath}${name}` : `${localPath}/${name}`;
    try {
      await localMkdir(path);
    } catch (err) {
      setLocalError(String(err));
    }
    loadLocal(localPath);
  };

  // ── Remote rename ───────────────────────────────────────────────────────────

  const commitRename = async () => {
    const newName = renameValue.trim();
    const oldPath = renamingPath;
    setRenamingPath(null);
    setRenameValue("");
    if (!oldPath || !newName || !sessionIdRef.current) return;
    const dir = oldPath.substring(0, oldPath.lastIndexOf("/")) || "/";
    const newPath = dir === "/" ? `/${newName}` : `${dir}/${newName}`;
    try {
      await sftpRename(sessionIdRef.current, oldPath, newPath);
      loadRemote(sessionIdRef.current, remotePath);
    } catch (err) {
      setRemoteError(String(err));
    }
  };

  // ── Remote delete ───────────────────────────────────────────────────────────

  const handleRemoteDelete = async (entry: SftpEntry) => {
    if (!sessionIdRef.current || !confirm(`¿Eliminar "${entry.name}"?`)) return;
    try {
      await sftpDelete(sessionIdRef.current, entry.path, entry.is_dir);
      loadRemote(sessionIdRef.current, remotePath);
    } catch (err) {
      setRemoteError(String(err));
    }
  };

  // ── Context menus ───────────────────────────────────────────────────────────

  const openCtxMenu = (e: React.MouseEvent, side: "local" | "remote", entry?: AnyEntry) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, side, entry });
  };

  // ── Derived values ──────────────────────────────────────────────────────────

  const uploadCount = localEntries.filter(
    (e) => localSelected.has(e.path) && !e.is_dir,
  ).length;
  const downloadCount = remoteEntries.filter(
    (e) => remoteSelected.has(e.path) && !e.is_dir,
  ).length;
  const pct = progress.total > 0 ? Math.round((progress.transferred * 100) / progress.total) : 0;

  // ── Connecting state ────────────────────────────────────────────────────────

  if (connecting) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 bg-[var(--color-bg-base)] text-[var(--color-text-muted)]">
        <Loader size={28} className="animate-spin opacity-60" />
        <span className="text-xs">Conectando a SFTP…</span>
        {connection && (
          <span className="text-[10px] font-mono">{connection.username}@{connection.host}</span>
        )}
      </div>
    );
  }

  if (connError || disconnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 bg-[var(--color-bg-base)] text-[var(--color-text-muted)]">
        <WifiOff size={28} className="opacity-40" />
        <span className="text-xs font-medium text-[var(--color-text-primary)]">
          {disconnected ? "Sesión SFTP perdida" : "Error de conexión"}
        </span>
        {connError && <p className="text-[10px] text-[var(--color-danger)] max-w-xs text-center px-4">{connError}</p>}
        <button
          onClick={async () => { setReconnecting(true); await connectSftp(); setReconnecting(false); }}
          disabled={reconnecting}
          className="px-4 py-1.5 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-xs rounded transition-colors disabled:opacity-50"
        >
          {reconnecting ? "Reconectando…" : "Reconectar"}
        </button>
      </div>
    );
  }

  // ── Full dual-pane layout ───────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg-base)]" onClick={() => setCtxMenu(null)}>

      {/* Connection info bar */}
      <div className="flex items-center gap-2 px-3 py-0.5 bg-[var(--color-bg-elevated)] border-b border-[var(--color-border)] shrink-0">
        <HardDrive size={10} className="text-cyan-400 shrink-0" />
        <span className="text-[10px] text-[var(--color-text-muted)]">
          Conectado a <span className="text-[var(--color-text-primary)] font-mono">{connection?.username}@{connection?.host}:{connection?.port}</span>
        </span>
        <button
          onClick={() => {
            if (sessionIdRef.current) {
              sftpDisconnect(sessionIdRef.current).catch(console.error);
              sessionIdRef.current = null;
            }
            setDisconnected(true);
          }}
          className="ml-auto text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
        >
          Desconectar
        </button>
      </div>

      {/* Two panels + center column */}
      <div className="flex flex-1 overflow-hidden">

        {/* Local panel */}
        <div className="flex-1 min-w-0 border-r border-[var(--color-border)] flex flex-col">
          {newFolderMode === "local" && (
            <div className="px-3 pt-2 pb-1 border-b border-[var(--color-border)] flex items-center gap-2 shrink-0">
              <Folder size={12} className="text-green-400 shrink-0" />
              <input
                ref={newFolderRef}
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleLocalMkdir();
                  if (e.key === "Escape") { setNewFolderMode(null); setNewFolderName(""); }
                }}
                onBlur={handleLocalMkdir}
                placeholder="Nombre de carpeta…"
                className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-2 py-0.5 text-xs text-[var(--color-text-primary)] outline-none"
              />
            </div>
          )}
          <div className="flex-1 min-h-0">
          <FilePanel
            title="PC Local"
            accentClass="text-green-400 bg-green-400/5"
            path={localPath}
            entries={localEntries as AnyEntry[]}
            selected={localSelected}
            loading={localLoading}
            error={localError}
            showHidden={showLocalHidden}
            onToggleHidden={() => setShowLocalHidden((v) => !v)}
            onNavigate={loadLocal}
            onUp={localUp}
            onHome={localHome}
            onRefresh={() => loadLocal(localPath)}
            onSelect={(e, entry) => toggleLocal(e, entry as LocalEntry)}
            onCtxMenu={(e, entry) => openCtxMenu(e, "local", entry)}
            onMkdir={() => { setNewFolderMode("local"); setNewFolderName(""); }}
          />
          </div>
        </div>

        {/* Transfer column */}
        <div className="w-14 shrink-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-bg-elevated)] border-r border-[var(--color-border)]">
          {/* Upload: local → remote */}
          <button
            onClick={handleUpload}
            disabled={uploadCount === 0 || transferring}
            title={uploadCount > 0 ? `Subir ${uploadCount} archivo${uploadCount > 1 ? "s" : ""} al servidor` : "Selecciona archivos locales para subir"}
            className={`flex flex-col items-center gap-1 p-2 rounded-lg transition-all ${
              uploadCount > 0 && !transferring
                ? "text-cyan-400 bg-cyan-400/10 hover:bg-cyan-400/20"
                : "text-[var(--color-text-muted)] opacity-30 cursor-default"
            }`}
          >
            <ArrowRight size={18} />
            {uploadCount > 0 && (
              <span className="text-[9px] font-bold leading-none">{uploadCount}</span>
            )}
          </button>

          {/* Download: remote → local */}
          <button
            onClick={handleDownload}
            disabled={downloadCount === 0 || transferring}
            title={downloadCount > 0 ? `Descargar ${downloadCount} archivo${downloadCount > 1 ? "s" : ""} al PC` : "Selecciona archivos remotos para descargar"}
            className={`flex flex-col items-center gap-1 p-2 rounded-lg transition-all ${
              downloadCount > 0 && !transferring
                ? "text-cyan-400 bg-cyan-400/10 hover:bg-cyan-400/20"
                : "text-[var(--color-text-muted)] opacity-30 cursor-default"
            }`}
          >
            <ArrowLeft size={18} />
            {downloadCount > 0 && (
              <span className="text-[9px] font-bold leading-none">{downloadCount}</span>
            )}
          </button>
        </div>

        {/* Remote panel */}
        <div className="flex-1 min-w-0">
          {newFolderMode === "remote" ? (
            <div className="px-3 pt-2 pb-1 border-b border-[var(--color-border)] flex items-center gap-2">
              <Folder size={12} className="text-[var(--color-accent)] shrink-0" />
              <input
                ref={newFolderRef}
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRemoteMkdir();
                  if (e.key === "Escape") { setNewFolderMode(null); setNewFolderName(""); }
                }}
                onBlur={handleRemoteMkdir}
                placeholder="Nombre de carpeta…"
                className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-2 py-0.5 text-xs text-[var(--color-text-primary)] outline-none"
              />
            </div>
          ) : null}
          <FilePanel
            title="Servidor Remoto"
            accentClass="text-cyan-400 bg-cyan-400/5"
            path={remotePath}
            entries={remoteEntries as AnyEntry[]}
            selected={remoteSelected}
            loading={remoteLoading}
            error={remoteError}
            showHidden={showRemoteHidden}
            onToggleHidden={() => setShowRemoteHidden((v) => !v)}
            onNavigate={(p) => sessionIdRef.current && loadRemote(sessionIdRef.current, p)}
            onUp={remoteUp}
            onHome={remoteHome}
            onRefresh={() => sessionIdRef.current && loadRemote(sessionIdRef.current, remotePath)}
            onSelect={(e, entry) => toggleRemote(e, entry as SftpEntry)}
            onCtxMenu={(e, entry) => openCtxMenu(e, "remote", entry)}
            onMkdir={() => { setNewFolderMode("remote"); setNewFolderName(""); }}
            renamingPath={renamingPath ?? undefined}
            renameValue={renameValue}
            onRenameChange={setRenameValue}
            onRenameCommit={commitRename}
            onRenameCancel={() => { setRenamingPath(null); setRenameValue(""); }}
          />
        </div>
      </div>

      {/* Transfer progress bar */}
      <div
        className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg-elevated)]"
        style={{ height: transferLabel ? "36px" : "0", overflow: "hidden", transition: "height 0.15s" }}
      >
        {transferLabel && (
          <div className="flex flex-col justify-center px-3 h-full gap-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[var(--color-text-muted)] truncate">{transferLabel}</span>
              <span className="text-[10px] font-mono text-[var(--color-text-muted)] ml-3 shrink-0">
                {formatBytes(progress.transferred)} / {formatBytes(progress.total)} · {pct}%
              </span>
            </div>
            <div className="w-full bg-[var(--color-bg-base)] rounded-full h-1">
              <div
                className="bg-cyan-400 h-1 rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="fixed z-50 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded shadow-lg py-0.5 min-w-[160px]"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.side === "remote" ? (
            ctxMenu.entry ? (
              <>
                {!ctxMenu.entry.is_dir && (
                  <CtxItem icon={<ArrowLeft size={12} />} label="Descargar al PC"
                    onClick={() => {
                      remoteSelected.size === 0 && ctxMenu.entry &&
                        setRemoteSelected(new Set([ctxMenu.entry.path]));
                      handleDownload();
                      setCtxMenu(null);
                    }} />
                )}
                {ctxMenu.entry.is_dir && (
                  <CtxItem icon={<ChevronRight size={12} />} label="Abrir"
                    onClick={() => {
                      sessionIdRef.current && loadRemote(sessionIdRef.current, ctxMenu.entry!.path);
                      setCtxMenu(null);
                    }} />
                )}
                <CtxItem icon={<Pencil size={12} />} label="Renombrar"
                  onClick={() => { setRenamingPath(ctxMenu.entry!.path); setRenameValue(ctxMenu.entry!.name); setCtxMenu(null); }} />
                <div className="my-0.5 border-t border-[var(--color-border)]" />
                <CtxItem icon={<Trash2 size={12} />} label="Eliminar" danger
                  onClick={() => { handleRemoteDelete(ctxMenu.entry as SftpEntry); setCtxMenu(null); }} />
              </>
            ) : (
              <CtxItem icon={<FolderPlus size={12} />} label="Nueva carpeta"
                onClick={() => { setNewFolderMode("remote"); setNewFolderName(""); setCtxMenu(null); }} />
            )
          ) : (
            ctxMenu.entry && !ctxMenu.entry.is_dir ? (
              <CtxItem icon={<ArrowRight size={12} />} label="Subir al servidor"
                onClick={() => {
                  if (ctxMenu.entry) setLocalSelected(new Set([ctxMenu.entry.path]));
                  handleUpload();
                  setCtxMenu(null);
                }} />
            ) : (
              <CtxItem icon={<FolderPlus size={12} />} label="Nueva carpeta"
                onClick={() => { setNewFolderMode("local"); setNewFolderName(""); setCtxMenu(null); }} />
            )
          )}
        </div>
      )}
    </div>
  );
}

function CtxItem({
  icon, label, onClick, danger = false,
}: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 w-full px-3 py-1 text-[11px] text-left transition-colors ${
        danger
          ? "text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
          : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]"
      }`}
    >
      {icon}{label}
    </button>
  );
}
