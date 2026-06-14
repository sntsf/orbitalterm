import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { flushSync } from "react-dom";
import {
  Folder, FolderOpen, File, Upload, Download, FolderPlus, FilePlus, RefreshCw,
  HardDrive, ChevronLeft, Pencil, Trash2, WifiOff, ChevronRight, Lock,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  sftpConnect, sftpConnectFromSsh, sftpListDir, sftpUpload, sftpDownload, sftpMkdir,
  sftpCreateFile, sftpRename, sftpDelete, sftpChmod,
} from "../../lib/commands";
import { friendlyFsError } from "../../lib/transferErrors";
import { resolveUploadOverwrites } from "../../lib/overwrite";
import type { SftpEntry } from "../../types";

interface SftpBrowserProps {
  sessionId: string | null;
  // When set, SFTP reuses this interactive SSH session (shared connection)
  // instead of opening its own. Null for standalone SFTP connections.
  sshSessionId?: string | null;
  connectionId: string;
  username?: string;
  onConnect: (sessionId: string) => void;
}

interface CtxMenu { x: number; y: number; entry?: SftpEntry }
interface SftpProgress { transferred: number; total: number }

type FlatRow = {
  entry: SftpEntry;
  depth: number;
  isExpanded: boolean;
  isLoading: boolean;
  isLast: boolean;
  continuations: boolean[];
};

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

export function SftpBrowser({ sessionId, sshSessionId, connectionId, username, onConnect }: SftpBrowserProps) {
  const [currentPath, setCurrentPath] = useState("/");
  const [pathInput, setPathInput] = useState("/");
  const [editingPath, setEditingPath] = useState(false);
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Tree expansion
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirChildren, setDirChildren] = useState<Map<string, SftpEntry[]>>(new Map());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());

  // Transfer progress
  const [transferFile, setTransferFile] = useState<string | null>(null);
  const [progress, setProgress] = useState<SftpProgress>({ transferred: 0, total: 0 });

  // Multi-select
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClickedRef = useRef<string | null>(null);

  // Path autocomplete
  const [pathSuggestions, setPathSuggestions] = useState<string[]>([]);
  const [suggestionIdx, setSuggestionIdx] = useState(-1);
  const suggestionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Inline creation / rename
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFileMode, setNewFileMode] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [renamingEntry, setRenamingEntry] = useState<SftpEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const newFolderRef = useRef<HTMLInputElement>(null);
  const newFileRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  // ── helpers ────────────────────────────────────────────────────────────────

  const formatBytes = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1048576).toFixed(1)} MB`;
  };
  const formatDate = (ts: number) => ts ? new Date(ts * 1000).toLocaleDateString() : "—";

  const isSftpGone = (err: unknown) => {
    const s = String(err);
    return s.includes("session not found") || s.includes("SFTP session not found") || s.includes("closed") || s.includes("EOF");
  };

  // Turn raw russh/SFTP errors into a short, friendly message.
  const friendlySftp = (err: unknown): string => {
    const s = String(err).toLowerCase();
    if (s.includes("subsystem") || s.includes("channel open") || s.includes("sftp session init") || s.includes("init failed"))
      return "SFTP no disponible en este servidor (el subsistema SFTP podría estar deshabilitado). El SSH sigue funcionando.";
    return friendlyFsError(err);
  };

  const handleError = (err: unknown) => {
    if (isSftpGone(err)) {
      setDisconnected(true);
    } else {
      setError(friendlySftp(err));
    }
  };

  // ── data loading ───────────────────────────────────────────────────────────

  const loadDir = useCallback(async (sid: string, path: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await sftpListDir(sid, path);
      setEntries(result);
      setCurrentPath(path);
      setPathInput(path);
      setSelected(new Set());
      setExpandedDirs(new Set());
      setDirChildren(new Map());
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── tree expansion ─────────────────────────────────────────────────────────

  const toggleExpand = useCallback(async (entry: SftpEntry) => {
    if (!sessionId || !entry.is_dir) return;
    const path = entry.path;

    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) { next.delete(path); return next; }
      next.add(path);
      return next;
    });

    if (!dirChildren.has(path)) {
      setLoadingDirs((prev) => new Set(prev).add(path));
      try {
        const kids = await sftpListDir(sessionId, path);
        setDirChildren((prev) => new Map(prev).set(path, kids));
      } catch (err) {
        handleError(err);
        setExpandedDirs((prev) => { const next = new Set(prev); next.delete(path); return next; });
      } finally {
        setLoadingDirs((prev) => { const next = new Set(prev); next.delete(path); return next; });
      }
    }
  }, [sessionId, dirChildren]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── flatten tree ───────────────────────────────────────────────────────────

  const flattenTree = useCallback((items: SftpEntry[], depth: number, continuations: boolean[]): FlatRow[] => {
    const sorted = [...items].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const result: FlatRow[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i];
      const isLast = i === sorted.length - 1;
      const isExp = entry.is_dir && expandedDirs.has(entry.path);
      const isLoad = entry.is_dir && loadingDirs.has(entry.path);
      result.push({ entry, depth, isExpanded: isExp, isLoading: isLoad, isLast, continuations });
      if (isExp) {
        const kids = dirChildren.get(entry.path) ?? [];
        result.push(...flattenTree(kids, depth + 1, [...continuations, !isLast]));
      }
    }
    return result;
  }, [expandedDirs, loadingDirs, dirChildren]);

  const flatRows = useMemo(() => flattenTree(entries, 0, []), [entries, flattenTree]);

  // ── transfer helpers ───────────────────────────────────────────────────────

  const doUpload = useCallback(async (localPaths: string[]) => {
    if (!sessionId) return;
    const toUpload = resolveUploadOverwrites(localPaths, new Set(entries.map((e) => e.name)));
    if (toUpload.length === 0) return;
    for (const localPath of toUpload) {
      const fileName = localPath.split(/[\\/]/).pop() ?? "file";
      flushSync(() => { setTransferFile(`↑ ${fileName}`); setProgress({ transferred: 0, total: 0 }); });
      const remotePath = currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;
      try {
        await sftpUpload(sessionId, localPath, remotePath);
      } catch (err) {
        handleError(err);
        break;
      }
    }
    setTransferFile(null);
    loadDir(sessionId, currentPath);
  }, [sessionId, currentPath, loadDir, entries]); // eslint-disable-line react-hooks/exhaustive-deps

  const doDownload = useCallback(async (remoteEntries: SftpEntry[], destDir: string) => {
    if (!sessionId) return;
    for (const entry of remoteEntries) {
      const localPath = destDir.endsWith("/") ? `${destDir}${entry.name}` : `${destDir}/${entry.name}`;
      flushSync(() => { setTransferFile(`↓ ${entry.name}`); setProgress({ transferred: 0, total: 0 }); });
      try {
        await sftpDownload(sessionId, entry.path, localPath);
      } catch (err) {
        handleError(err);
        break;
      }
    }
    setTransferFile(null);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── progress listeners ─────────────────────────────────────────────────────

  useEffect(() => {
    const unlistens: (() => void)[] = [];
    listen<SftpProgress>("sftp-upload-progress", (e) => setProgress(e.payload))
      .then((fn) => unlistens.push(fn));
    listen<SftpProgress>("sftp-download-progress", (e) => setProgress(e.payload))
      .then((fn) => unlistens.push(fn));
    return () => unlistens.forEach((fn) => fn());
  }, []);

  // ── Tauri native drag-drop ─────────────────────────────────────────────────

  useEffect(() => {
    if (!sessionId) return;
    let unlisten: (() => void) | null = null;
    getCurrentWebviewWindow().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "leave") { setDragging(false); return; }

      const rect = containerRef.current?.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const inside = rect
        ? p.position.x / dpr >= rect.left && p.position.x / dpr <= rect.right
          && p.position.y / dpr >= rect.top && p.position.y / dpr <= rect.bottom
        : false;

      if (p.type === "enter" || p.type === "over") {
        setDragging(inside);
      } else if (p.type === "drop") {
        setDragging(false);
        if (inside && p.paths?.length) doUpload(p.paths);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [sessionId, doUpload]);

  // ── initial load ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!sessionId) return;
    setDisconnected(false);
    const home = username ? `/home/${username}` : "/";
    sftpListDir(sessionId, home)
      .then((r) => { setEntries(r); setCurrentPath(home); setPathInput(home); })
      .catch(() => loadDir(sessionId, "/"));
  }, [sessionId, username, loadDir]);

  // ── focus effects ──────────────────────────────────────────────────────────

  useEffect(() => { if (newFolderMode) newFolderRef.current?.focus(); }, [newFolderMode]);
  useEffect(() => { if (newFileMode) newFileRef.current?.focus(); }, [newFileMode]);
  useEffect(() => { if (renamingEntry) { renameRef.current?.focus(); renameRef.current?.select(); } }, [renamingEntry]);
  useEffect(() => { if (editingPath) { pathInputRef.current?.focus(); pathInputRef.current?.select(); } }, [editingPath]);

  // ── path autocomplete ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!editingPath || !sessionId) { setPathSuggestions([]); return; }
    if (suggestionTimer.current) clearTimeout(suggestionTimer.current);
    suggestionTimer.current = setTimeout(async () => {
      const lastSlash = pathInput.lastIndexOf("/");
      const dir = pathInput.substring(0, lastSlash) || "/";
      const fragment = pathInput.substring(lastSlash + 1).toLowerCase();
      try {
        const result = await sftpListDir(sessionId, dir);
        const matches = result
          .filter((e) => e.is_dir && e.name.toLowerCase().startsWith(fragment))
          .map((e) => e.path)
          .slice(0, 8);
        setPathSuggestions(matches);
        setSuggestionIdx(-1);
      } catch { setPathSuggestions([]); }
    }, 250);
    return () => { if (suggestionTimer.current) clearTimeout(suggestionTimer.current); };
  }, [pathInput, editingPath, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── navigation ─────────────────────────────────────────────────────────────

  const navigateTo = (path: string) => { if (sessionId) loadDir(sessionId, path); };
  const navigateUp = () => {
    if (currentPath === "/") return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    navigateTo("/" + (parts.join("/") || ""));
  };
  const commitPathInput = () => {
    setEditingPath(false);
    const p = pathInput.trim() || "/";
    if (p !== currentPath) navigateTo(p);
  };

  // ── connect ────────────────────────────────────────────────────────────────

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    setDisconnected(false);
    try {
      // Reuse the interactive SSH session when available (shared connection);
      // otherwise open a standalone SFTP connection.
      const sid = sshSessionId
        ? await sftpConnectFromSsh(sshSessionId)
        : await sftpConnect(connectionId);
      onConnect(sid);
    }
    catch (err) { setError(friendlySftp(err)); }
    finally { setConnecting(false); }
  };

  // Auto-connect once when reusing an interactive SSH session (the terminal
  // sets sshSessionId after login). If SFTP isn't available the panel shows a
  // friendly message and the SSH terminal keeps working — no retry loop.
  const autoConnectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (sshSessionId && !sessionId && !disconnected && autoConnectedRef.current !== sshSessionId) {
      autoConnectedRef.current = sshSessionId;
      handleConnect();
    }
  }, [sshSessionId, sessionId, disconnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── upload ─────────────────────────────────────────────────────────────────

  const handleUpload = async () => {
    const selected2 = await openDialog({ multiple: true }).catch(() => null);
    if (!selected2) return;
    await doUpload(Array.isArray(selected2) ? selected2 : [selected2]);
  };

  // ── download ───────────────────────────────────────────────────────────────

  const handleDownloadEntry = async (entry: SftpEntry) => {
    if (!sessionId || entry.is_dir) return;
    const localPath = await saveDialog({ defaultPath: entry.name }).catch(() => null);
    if (!localPath) return;
    flushSync(() => { setTransferFile(`↓ ${entry.name}`); setProgress({ transferred: 0, total: 0 }); });
    try { await sftpDownload(sessionId, entry.path, localPath); }
    catch (err) { handleError(err); }
    finally { setTransferFile(null); }
  };

  const handleDownloadSelected = async () => {
    if (!sessionId) return;
    const toDownload = flatRows.map((r) => r.entry).filter((e) => selected.has(e.path) && !e.is_dir);
    if (toDownload.length === 0) return;
    if (toDownload.length === 1) {
      await handleDownloadEntry(toDownload[0]);
      return;
    }
    const destDir = await openDialog({ directory: true, multiple: false }).catch(() => null) as string | null;
    if (!destDir) return;
    await doDownload(toDownload, destDir);
  };

  // ── mkdir / create file ────────────────────────────────────────────────────

  const handleMkdir = async () => {
    const name = newFolderName.trim();
    setNewFolderMode(false); setNewFolderName("");
    if (!name || !sessionId) return;
    try { await sftpMkdir(sessionId, currentPath === "/" ? `/${name}` : `${currentPath}/${name}`); loadDir(sessionId, currentPath); }
    catch (err) { handleError(err); }
  };

  const handleCreateFile = async () => {
    const name = newFileName.trim();
    setNewFileMode(false); setNewFileName("");
    if (!name || !sessionId) return;
    try { await sftpCreateFile(sessionId, currentPath === "/" ? `/${name}` : `${currentPath}/${name}`); loadDir(sessionId, currentPath); }
    catch (err) { handleError(err); }
  };

  // ── rename ─────────────────────────────────────────────────────────────────

  const commitRename = async () => {
    const entry = renamingEntry; const newName = renameValue.trim();
    setRenamingEntry(null); setRenameValue("");
    if (!entry || !newName || newName === entry.name || !sessionId) return;
    const dir = entry.path.substring(0, entry.path.lastIndexOf("/")) || "/";
    const newPath = dir === "/" ? `/${newName}` : `${dir}/${newName}`;
    try { await sftpRename(sessionId, entry.path, newPath); loadDir(sessionId, currentPath); }
    catch (err) { handleError(err); }
  };

  // ── delete ─────────────────────────────────────────────────────────────────

  const handleDelete = async (entry: SftpEntry) => {
    if (!sessionId || !confirm(`¿Eliminar ${entry.name}?`)) return;
    try { await sftpDelete(sessionId, entry.path, entry.is_dir); loadDir(sessionId, currentPath); }
    catch (err) { handleError(err); }
  };

  const handleChmod = (entry: SftpEntry) => {
    if (!sessionId) return;
    const current = (entry.mode & 0o777).toString(8).padStart(3, "0");
    const input = window.prompt(`Permisos de "${entry.name}" (octal, ej. 755):`, current);
    if (input == null) return;
    const mode = parseInt(input.trim(), 8);
    if (Number.isNaN(mode)) { setError("Permisos inválidos (usa octal, ej. 644)."); return; }
    sftpChmod(sessionId, entry.path, mode)
      .then(() => loadDir(sessionId, currentPath))
      .catch((err) => handleError(err));
  };

  // ── selection ──────────────────────────────────────────────────────────────

  const toggleSelect = (e: React.MouseEvent, entry: SftpEntry) => {
    if (e.shiftKey && lastClickedRef.current) {
      const lastIdx = flatRows.findIndex((r) => r.entry.path === lastClickedRef.current);
      const currIdx = flatRows.findIndex((r) => r.entry.path === entry.path);
      const start = Math.min(lastIdx, currIdx);
      const end = Math.max(lastIdx, currIdx);
      setSelected(new Set(flatRows.slice(start, end + 1).map((r) => r.entry.path)));
      return;
    }
    lastClickedRef.current = entry.path;
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

  const openCtxMenu = (e: React.MouseEvent, entry?: SftpEntry) => {
    e.preventDefault();
    if (entry && !entry.is_dir && !selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  };

  // ── derived values ─────────────────────────────────────────────────────────

  const selectedFiles = flatRows.map((r) => r.entry).filter((e) => selected.has(e.path) && !e.is_dir);
  const pct = progress.total > 0 ? Math.round(progress.transferred * 100 / progress.total) : 0;

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); };
  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); };

  // ── disconnected state ─────────────────────────────────────────────────────

  if (!sessionId || disconnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 bg-[var(--color-bg-surface)] text-[var(--color-text-muted)]">
        {disconnected ? <WifiOff size={28} className="opacity-40" /> : <HardDrive size={32} className="opacity-40" />}
        <span className="text-xs">{disconnected ? "Sesión SFTP perdida" : "SFTP no conectado"}</span>
        {error && <p className="text-[var(--color-danger)] text-xs px-4 text-center">{error}</p>}
        <button onClick={handleConnect} disabled={connecting}
          className="px-3 py-1.5 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-xs rounded transition-colors disabled:opacity-50">
          {connecting ? "Conectando…" : disconnected ? "Reconectar SFTP" : "Conectar SFTP"}
        </button>
      </div>
    );
  }

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className={`flex flex-col h-full bg-[var(--color-bg-surface)] border-l border-[var(--color-border)] select-none ${
        dragging ? "ring-2 ring-inset ring-[var(--color-accent)]" : ""
      }`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={() => setCtxMenu(null)}
      onContextMenu={(e) => { e.preventDefault(); openCtxMenu(e); }}
    >
      {/* Path bar */}
      <div className="relative flex items-center gap-1 px-1.5 py-1 border-b border-[var(--color-border)] shrink-0">
        <button onClick={navigateUp} disabled={currentPath === "/"} title="Subir un nivel"
          className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-30 transition-colors">
          <ChevronLeft size={12} />
        </button>
        {editingPath ? (
          <div className="flex-1 relative">
            <input
              ref={pathInputRef}
              value={pathInput}
              onChange={(e) => { setPathInput(e.target.value); setSuggestionIdx(-1); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setSuggestionIdx((i) => Math.min(i + 1, pathSuggestions.length - 1)); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setSuggestionIdx((i) => Math.max(i - 1, -1)); return; }
                if (e.key === "Tab") {
                  e.preventDefault();
                  const pick = suggestionIdx >= 0 ? pathSuggestions[suggestionIdx] : pathSuggestions[0];
                  if (pick) { setPathInput(pick + "/"); setPathSuggestions([]); }
                  return;
                }
                if (e.key === "Enter") {
                  if (suggestionIdx >= 0 && pathSuggestions[suggestionIdx]) {
                    navigateTo(pathSuggestions[suggestionIdx]);
                    setEditingPath(false);
                    setPathSuggestions([]);
                  } else {
                    commitPathInput();
                    setPathSuggestions([]);
                  }
                  return;
                }
                if (e.key === "Escape") { setEditingPath(false); setPathInput(currentPath); setPathSuggestions([]); }
              }}
              onBlur={() => { commitPathInput(); setPathSuggestions([]); }}
              className="w-full bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-primary)] outline-none"
            />
            {pathSuggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 z-50 mt-0.5 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded shadow-lg max-h-40 overflow-y-auto">
                {pathSuggestions.map((s, i) => (
                  <button
                    key={s}
                    onMouseDown={(e) => { e.preventDefault(); setPathInput(s + "/"); setPathSuggestions([]); pathInputRef.current?.focus(); }}
                    className={`w-full text-left px-2 py-0.5 text-[10px] font-mono truncate transition-colors ${
                      i === suggestionIdx
                        ? "bg-[var(--color-accent)]/20 text-[var(--color-text-primary)]"
                        : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"
                    }`}
                  >{s}</button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button className="flex-1 text-left text-[10px] font-mono text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] truncate"
            title="Click para editar ruta" onClick={(e) => { e.stopPropagation(); setEditingPath(true); }}>
            {currentPath}
          </button>
        )}
        <button onClick={() => sessionId && loadDir(sessionId, currentPath)} title="Refrescar"
          className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors">
          <RefreshCw size={11} />
        </button>
      </div>

      {/* Action toolbar */}
      <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-[var(--color-border)] shrink-0">
        <TBtn icon={<Upload size={11} />} label="Upload" onClick={handleUpload} />
        {selectedFiles.length > 0 && (
          <TBtn
            icon={<Download size={11} />}
            label={selectedFiles.length === 1 ? "Download" : `Download (${selectedFiles.length})`}
            onClick={handleDownloadSelected}
          />
        )}
        <TBtn icon={<FolderPlus size={11} />} label="Carpeta" onClick={() => setNewFolderMode(true)} />
        <TBtn icon={<FilePlus size={11} />} label="Archivo" onClick={() => setNewFileMode(true)} />
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-2 py-1 text-[10px] text-[var(--color-danger)] bg-[var(--color-danger)]/10 shrink-0 cursor-pointer" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[var(--color-text-muted)]">
            <RefreshCw size={16} className="animate-spin" />
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)] text-[10px]">
                <th className="text-left px-2 py-1 font-medium">Nombre</th>
                <th className="text-right px-2 py-1 font-medium w-16">Tamaño</th>
                <th className="text-right px-2 py-1 font-medium w-20">Modificado</th>
              </tr>
            </thead>
            <tbody>
              {currentPath !== "/" && (
                <tr className="hover:bg-[var(--color-bg-hover)] cursor-pointer" onClick={navigateUp}>
                  <td className="px-2 py-1 flex items-center gap-2">
                    <Folder size={12} className="text-[var(--color-text-muted)] shrink-0" />
                    <span className="text-[var(--color-text-muted)]">..</span>
                  </td>
                  <td /><td />
                </tr>
              )}

              {newFolderMode && (
                <tr><td className="px-2 py-1" colSpan={3}>
                  <div className="flex items-center gap-2">
                    <Folder size={12} className="text-[var(--color-accent)] shrink-0" />
                    <input ref={newFolderRef} value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleMkdir(); if (e.key === "Escape") { setNewFolderMode(false); setNewFolderName(""); } }}
                      onBlur={handleMkdir} placeholder="Nombre de carpeta…"
                      className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-2 py-0.5 text-xs text-[var(--color-text-primary)] outline-none" />
                  </div>
                </td></tr>
              )}

              {newFileMode && (
                <tr><td className="px-2 py-1" colSpan={3}>
                  <div className="flex items-center gap-2">
                    <File size={12} className="text-[var(--color-text-muted)] shrink-0" />
                    <input ref={newFileRef} value={newFileName} onChange={(e) => setNewFileName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleCreateFile(); if (e.key === "Escape") { setNewFileMode(false); setNewFileName(""); } }}
                      onBlur={handleCreateFile} placeholder="Nombre de archivo…"
                      className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-2 py-0.5 text-xs text-[var(--color-text-primary)] outline-none" />
                  </div>
                </td></tr>
              )}

              {flatRows.map(({ entry, isExpanded, isLoading, isLast, continuations, depth }) => {
                const isSelected = selected.has(entry.path);
                return (
                  <tr key={entry.path}
                    className={`cursor-pointer ${isSelected ? "bg-[var(--color-accent)]/15" : "hover:bg-[var(--color-bg-hover)]"}`}
                    onClick={(e) => toggleSelect(e, entry)}
                    onContextMenu={(e) => { e.stopPropagation(); openCtxMenu(e, entry); }}
                    onDoubleClick={() => { entry.is_dir ? navigateTo(entry.path) : handleDownloadEntry(entry); }}
                  >
                    <td className="py-0.5 pl-1 pr-1">
                      <div className="flex items-center gap-0.5 min-w-0">
                        {depth > 0 && <TreePrefix continuations={continuations} isLast={isLast} />}
                        {entry.is_dir ? (
                          <button
                            className="p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] shrink-0 transition-colors"
                            onClick={(e) => { e.stopPropagation(); toggleExpand(entry); }}
                            title={isExpanded ? "Contraer" : "Expandir"}
                          >
                            {isLoading
                              ? <RefreshCw size={10} className="animate-spin" />
                              : isExpanded
                                ? <ChevronRight size={10} className="rotate-90 transition-transform" />
                                : <ChevronRight size={10} className="transition-transform" />
                            }
                          </button>
                        ) : (
                          <span className="w-[18px] shrink-0" />
                        )}
                        {entry.is_dir
                          ? isExpanded
                            ? <FolderOpen size={12} className="text-amber-400 shrink-0" />
                            : <Folder size={12} className="text-amber-400 shrink-0" />
                          : <File size={12} className={isSelected ? "text-[var(--color-accent)] shrink-0" : "text-[var(--color-text-muted)] shrink-0"} />
                        }
                        <span className="w-1 shrink-0" />
                        {renamingEntry?.path === entry.path ? (
                          <input ref={renameRef} value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenamingEntry(null); }}
                            onBlur={commitRename} onClick={(e) => e.stopPropagation()}
                            className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-1 py-0 text-xs text-[var(--color-text-primary)] outline-none" />
                        ) : (
                          <span className="truncate text-[var(--color-text-primary)]" title={entry.name}>{entry.name}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-0.5 text-right text-[var(--color-text-muted)] text-[10px]">
                      {entry.is_dir ? "—" : formatBytes(entry.size)}
                    </td>
                    <td className="px-2 py-0.5 text-right text-[var(--color-text-muted)] text-[10px]">
                      {formatDate(entry.modified)}
                    </td>
                  </tr>
                );
              })}

              {entries.length === 0 && !loading && !newFolderMode && !newFileMode && (
                <tr><td colSpan={3} className="px-2 py-4 text-center text-[var(--color-text-muted)] text-xs">Carpeta vacía</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Progress bar */}
      <div className="shrink-0 border-t border-[var(--color-border)]"
        style={{ height: transferFile ? "32px" : "0", overflow: "hidden", transition: "height 0.15s" }}>
        {transferFile && (
          <div className="flex flex-col justify-center px-2 h-full gap-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[var(--color-text-muted)] truncate">{transferFile}</span>
              <span className="text-[10px] text-[var(--color-text-muted)] shrink-0 ml-2 font-mono">
                {formatBytes(progress.transferred)} / {formatBytes(progress.total)} · {pct}%
              </span>
            </div>
            <div className="w-full bg-[var(--color-bg-elevated)] rounded-full h-1">
              <div className="bg-[var(--color-accent)] h-1 rounded-full transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div className="fixed z-50 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded shadow-lg py-0.5 min-w-[160px]"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={(e) => e.stopPropagation()}>
          {ctxMenu.entry ? (
            <>
              {!ctxMenu.entry.is_dir && (
                <CtxItem icon={<Download size={12} />}
                  label={selectedFiles.length > 1 ? `Descargar ${selectedFiles.length} archivos` : "Descargar"}
                  onClick={() => { selectedFiles.length > 1 ? handleDownloadSelected() : handleDownloadEntry(ctxMenu.entry!); setCtxMenu(null); }} />
              )}
              {ctxMenu.entry.is_dir && (
                <>
                  <CtxItem icon={<FolderOpen size={12} />} label="Abrir (navegar)"
                    onClick={() => { navigateTo(ctxMenu.entry!.path); setCtxMenu(null); }} />
                  <CtxItem icon={ctxMenu.entry && expandedDirs.has(ctxMenu.entry.path) ? <ChevronRight size={12} className="rotate-90" /> : <ChevronRight size={12} />}
                    label={ctxMenu.entry && expandedDirs.has(ctxMenu.entry.path) ? "Contraer" : "Expandir"}
                    onClick={() => { toggleExpand(ctxMenu.entry!); setCtxMenu(null); }} />
                </>
              )}
              <CtxItem icon={<Pencil size={12} />} label="Renombrar"
                onClick={() => { setRenamingEntry(ctxMenu.entry!); setRenameValue(ctxMenu.entry!.name); setCtxMenu(null); }} />
              <CtxItem icon={<Lock size={12} />} label="Permisos…"
                onClick={() => { handleChmod(ctxMenu.entry!); setCtxMenu(null); }} />
              <div className="my-0.5 border-t border-[var(--color-border)]" />
              <CtxItem icon={<Trash2 size={12} />} label="Eliminar" danger
                onClick={() => { handleDelete(ctxMenu.entry!); setCtxMenu(null); }} />
            </>
          ) : (
            <>
              <CtxItem icon={<Upload size={12} />} label="Subir archivo" onClick={() => { handleUpload(); setCtxMenu(null); }} />
              <CtxItem icon={<FolderPlus size={12} />} label="Nueva carpeta" onClick={() => { setNewFolderMode(true); setCtxMenu(null); }} />
              <CtxItem icon={<FilePlus size={12} />} label="Nuevo archivo" onClick={() => { setNewFileMode(true); setCtxMenu(null); }} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors">
      {icon}{label}
    </button>
  );
}

function CtxItem({ icon, label, onClick, danger = false }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-2 w-full px-3 py-1 text-[11px] text-left transition-colors ${
        danger ? "text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
               : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]"
      }`}>
      {icon}{label}
    </button>
  );
}
