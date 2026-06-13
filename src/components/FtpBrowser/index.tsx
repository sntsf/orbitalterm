import { useEffect, useState, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import {
  Folder, File, Upload, Download, FolderPlus, RefreshCw,
  ChevronLeft, Pencil, Trash2, WifiOff, Loader,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ftpConnect, ftpListDir, ftpUpload, ftpDownload, ftpMkdir,
  ftpRename, ftpDelete,
} from "../../lib/commands";
import type { FtpEntry } from "../../lib/commands";
import { friendlyFsError } from "../../lib/transferErrors";

interface FtpBrowserProps {
  sessionId: string | null;
  connectionId: string;
  onConnect: (sessionId: string) => void;
  onDisconnect?: () => void;
}

interface CtxMenu { x: number; y: number; entry?: FtpEntry }
interface FtpProgress { transferred: number; total: number }

export function FtpBrowser({ sessionId, connectionId, onConnect, onDisconnect }: FtpBrowserProps) {
  const [currentPath, setCurrentPath] = useState("/");
  const [pathInput, setPathInput] = useState("/");
  const [editingPath, setEditingPath] = useState(false);
  const [entries, setEntries] = useState<FtpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const [transferFile, setTransferFile] = useState<string | null>(null);
  const [progress, setProgress] = useState<FtpProgress>({ transferred: 0, total: 0 });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClickedRef = useRef<string | null>(null);

  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingEntry, setRenamingEntry] = useState<FtpEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  const newFolderRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  // ── helpers ────────────────────────────────────────────────────────────────

  const formatBytes = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1048576).toFixed(1)} MB`;
  };

  const isFtpGone = (err: unknown) => {
    const s = String(err);
    return s.includes("session not found") || s.includes("FTP session") || s.includes("closed") || s.includes("broken pipe");
  };

  const handleError = (err: unknown) => {
    if (isFtpGone(err)) {
      setDisconnected(true);
      setTimeout(() => onDisconnect?.(), 1500);
    } else {
      setError(friendlyFsError(err));
    }
  };

  // ── data loading ───────────────────────────────────────────────────────────

  const loadDir = useCallback(async (sid: string, path: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await ftpListDir(sid, path);
      setEntries(result);
      setCurrentPath(path);
      setPathInput(path);
      setSelected(new Set());
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── transfer helpers ───────────────────────────────────────────────────────

  const doUpload = useCallback(async (localPaths: string[]) => {
    if (!sessionId) return;
    for (const localPath of localPaths) {
      const fileName = localPath.split(/[\\/]/).pop() ?? "file";
      flushSync(() => { setTransferFile(`↑ ${fileName}`); setProgress({ transferred: 0, total: 0 }); });
      const remotePath = currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;
      try {
        await ftpUpload(sessionId, localPath, remotePath);
      } catch (err) {
        handleError(err);
        break;
      }
    }
    setTransferFile(null);
    loadDir(sessionId, currentPath);
  }, [sessionId, currentPath, loadDir]); // eslint-disable-line react-hooks/exhaustive-deps

  const doDownload = useCallback(async (remoteEntries: FtpEntry[], localPath: string) => {
    if (!sessionId) return;
    for (const entry of remoteEntries) {
      const dest = localPath.endsWith("/") ? `${localPath}${entry.name}` : `${localPath}/${entry.name}`;
      flushSync(() => { setTransferFile(`↓ ${entry.name}`); setProgress({ transferred: 0, total: 0 }); });
      try {
        await ftpDownload(sessionId, entry.path, dest);
      } catch (err) {
        handleError(err);
        break;
      }
    }
    setTransferFile(null);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── progress listeners ─────────────────────────────────────────────────────

  useEffect(() => {
    const cleanups: (() => void)[] = [];
    listen<FtpProgress>("ftp-upload-progress", (e) => setProgress(e.payload)).then((fn) => cleanups.push(fn));
    listen<FtpProgress>("ftp-download-progress", (e) => setProgress(e.payload)).then((fn) => cleanups.push(fn));
    return () => cleanups.forEach((fn) => fn());
  }, []);

  // ── initial load ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!sessionId) return;
    setDisconnected(false);
    loadDir(sessionId, "/");
  }, [sessionId, loadDir]);

  // ── focus ──────────────────────────────────────────────────────────────────

  useEffect(() => { if (newFolderMode) newFolderRef.current?.focus(); }, [newFolderMode]);
  useEffect(() => { if (renamingEntry) { renameRef.current?.focus(); renameRef.current?.select(); } }, [renamingEntry]);
  useEffect(() => { if (editingPath) { pathInputRef.current?.focus(); pathInputRef.current?.select(); } }, [editingPath]);

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
    try { onConnect(await ftpConnect(connectionId)); }
    catch (err) { setError(friendlyFsError(err)); }
    finally { setConnecting(false); }
  };

  // ── upload ─────────────────────────────────────────────────────────────────

  const handleUpload = async () => {
    const picked = await openDialog({ multiple: true }).catch(() => null);
    if (!picked) return;
    await doUpload(Array.isArray(picked) ? picked : [picked]);
  };

  // ── download ───────────────────────────────────────────────────────────────

  const handleDownloadEntry = async (entry: FtpEntry) => {
    if (!sessionId || entry.is_dir) return;
    const localPath = await saveDialog({ defaultPath: entry.name }).catch(() => null);
    if (!localPath) return;
    flushSync(() => { setTransferFile(`↓ ${entry.name}`); setProgress({ transferred: 0, total: 0 }); });
    try { await ftpDownload(sessionId, entry.path, localPath); }
    catch (err) { handleError(err); }
    finally { setTransferFile(null); }
  };

  const handleDownloadSelected = async () => {
    if (!sessionId) return;
    const toDownload = entries.filter((e) => selected.has(e.path) && !e.is_dir);
    if (toDownload.length === 0) return;
    if (toDownload.length === 1) { await handleDownloadEntry(toDownload[0]); return; }
    const destDir = await openDialog({ directory: true, multiple: false }).catch(() => null) as string | null;
    if (!destDir) return;
    await doDownload(toDownload, destDir);
  };

  // ── mkdir ──────────────────────────────────────────────────────────────────

  const handleMkdir = async () => {
    const name = newFolderName.trim();
    setNewFolderMode(false); setNewFolderName("");
    if (!name || !sessionId) return;
    const path = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
    try { await ftpMkdir(sessionId, path); loadDir(sessionId, currentPath); }
    catch (err) { handleError(err); }
  };

  // ── rename ─────────────────────────────────────────────────────────────────

  const commitRename = async () => {
    const entry = renamingEntry; const newName = renameValue.trim();
    setRenamingEntry(null); setRenameValue("");
    if (!entry || !newName || newName === entry.name || !sessionId) return;
    const dir = entry.path.substring(0, entry.path.lastIndexOf("/")) || "/";
    const newPath = dir === "/" ? `/${newName}` : `${dir}/${newName}`;
    try { await ftpRename(sessionId, entry.path, newPath); loadDir(sessionId, currentPath); }
    catch (err) { handleError(err); }
  };

  // ── delete ─────────────────────────────────────────────────────────────────

  const handleDelete = async (entry: FtpEntry) => {
    if (!sessionId || !confirm(`¿Eliminar ${entry.name}?`)) return;
    try { await ftpDelete(sessionId, entry.path, entry.is_dir); loadDir(sessionId, currentPath); }
    catch (err) { handleError(err); }
  };

  // ── selection ──────────────────────────────────────────────────────────────

  const toggleSelect = (e: React.MouseEvent, entry: FtpEntry) => {
    if (e.shiftKey && lastClickedRef.current) {
      const lastIdx = entries.findIndex((en) => en.path === lastClickedRef.current);
      const currIdx = entries.findIndex((en) => en.path === entry.path);
      const start = Math.min(lastIdx, currIdx);
      const end = Math.max(lastIdx, currIdx);
      setSelected(new Set(entries.slice(start, end + 1).map((en) => en.path)));
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

  const openCtxMenu = (e: React.MouseEvent, entry?: FtpEntry) => {
    e.preventDefault();
    if (entry && !entry.is_dir && !selected.has(entry.path)) setSelected(new Set([entry.path]));
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  };

  // ── derived ────────────────────────────────────────────────────────────────

  const selectedFiles = entries.filter((e) => selected.has(e.path) && !e.is_dir);
  const pct = progress.total > 0 ? Math.round(progress.transferred * 100 / progress.total) : 0;

  // ── auto-connecting (parent handles initial connect) ──────────────────────

  if (!sessionId && !disconnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 bg-[var(--color-bg-surface)] text-[var(--color-text-muted)]">
        <Loader size={28} className="animate-spin opacity-60" />
        <span className="text-xs">Conectando a FTP…</span>
      </div>
    );
  }

  // ── session lost — show reconnect ─────────────────────────────────────────

  if (disconnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 bg-[var(--color-bg-surface)] text-[var(--color-text-muted)]">
        <WifiOff size={28} className="opacity-40" />
        <span className="text-xs font-medium text-[var(--color-text-primary)]">Sesión FTP perdida</span>
        {error && <p className="text-[var(--color-danger)] text-xs px-4 text-center">{error}</p>}
        <button onClick={handleConnect} disabled={connecting}
          className="px-3 py-1.5 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-xs rounded transition-colors disabled:opacity-50">
          {connecting ? "Reconectando…" : "Reconectar FTP"}
        </button>
      </div>
    );
  }

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col h-full bg-[var(--color-bg-surface)] select-none"
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
          <input ref={pathInputRef} value={pathInput} onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitPathInput();
              if (e.key === "Escape") { setEditingPath(false); setPathInput(currentPath); }
            }}
            onBlur={commitPathInput}
            className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-primary)] outline-none"
          />
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

      {/* Toolbar */}
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
      </div>

      {/* Error */}
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
                <th className="text-right px-2 py-1 font-medium w-24">Modificado</th>
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

              {entries.map((entry) => {
                const isSelected = selected.has(entry.path);
                return (
                  <tr key={entry.path}
                    className={`cursor-pointer ${isSelected ? "bg-[var(--color-accent)]/15" : "hover:bg-[var(--color-bg-hover)]"}`}
                    onClick={(e) => toggleSelect(e, entry)}
                    onContextMenu={(e) => { e.stopPropagation(); openCtxMenu(e, entry); }}
                    onDoubleClick={() => { entry.is_dir ? navigateTo(entry.path) : handleDownloadEntry(entry); }}
                  >
                    <td className="px-2 py-1">
                      <div className="flex items-center gap-2">
                        {entry.is_dir
                          ? <Folder size={12} className="text-yellow-400 shrink-0" />
                          : <File size={12} className={isSelected ? "text-[var(--color-accent)] shrink-0" : "text-[var(--color-text-muted)] shrink-0"} />}
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
                    <td className="px-2 py-1 text-right text-[var(--color-text-muted)] text-[10px]">
                      {entry.is_dir ? "—" : formatBytes(entry.size)}
                    </td>
                    <td className="px-2 py-1 text-right text-[var(--color-text-muted)] text-[10px]">
                      {entry.modified}
                    </td>
                  </tr>
                );
              })}

              {entries.length === 0 && !loading && !newFolderMode && (
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
              <div className="bg-yellow-400 h-1 rounded-full transition-all" style={{ width: `${pct}%` }} />
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
                <CtxItem icon={<Folder size={12} />} label="Abrir"
                  onClick={() => { navigateTo(ctxMenu.entry!.path); setCtxMenu(null); }} />
              )}
              <CtxItem icon={<Pencil size={12} />} label="Renombrar"
                onClick={() => { setRenamingEntry(ctxMenu.entry!); setRenameValue(ctxMenu.entry!.name); setCtxMenu(null); }} />
              <div className="my-0.5 border-t border-[var(--color-border)]" />
              <CtxItem icon={<Trash2 size={12} />} label="Eliminar" danger
                onClick={() => { handleDelete(ctxMenu.entry!); setCtxMenu(null); }} />
            </>
          ) : (
            <>
              <CtxItem icon={<Upload size={12} />} label="Subir archivo" onClick={() => { handleUpload(); setCtxMenu(null); }} />
              <CtxItem icon={<FolderPlus size={12} />} label="Nueva carpeta" onClick={() => { setNewFolderMode(true); setCtxMenu(null); }} />
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
