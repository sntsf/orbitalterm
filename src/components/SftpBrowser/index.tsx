import { useEffect, useState, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import {
  Folder, File, Upload, Download, FolderPlus, FilePlus, RefreshCw,
  HardDrive, ChevronLeft, Pencil, Trash2,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  sftpConnect, sftpListDir, sftpUpload, sftpDownload, sftpMkdir,
  sftpCreateFile, sftpRename, sftpDelete,
} from "../../lib/commands";
import type { SftpEntry } from "../../types";

interface SftpBrowserProps {
  sessionId: string | null;
  connectionId: string;
  username?: string;
  onConnect: (sessionId: string) => void;
}

interface CtxMenu { x: number; y: number; entry?: SftpEntry }

export function SftpBrowser({ sessionId, connectionId, username, onConnect }: SftpBrowserProps) {
  const [currentPath, setCurrentPath] = useState("/");
  const [pathInput, setPathInput] = useState("/");
  const [editingPath, setEditingPath] = useState(false);
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Transfer progress (0-100 | null = idle)
  const [uploadFile, setUploadFile] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number>(0);

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

  const loadDir = useCallback(async (sid: string, path: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await sftpListDir(sid, path);
      setEntries(result);
      setCurrentPath(path);
      setPathInput(path);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const doUpload = useCallback(async (localPaths: string[]) => {
    if (!sessionId) return;
    for (const localPath of localPaths) {
      const fileName = localPath.split(/[\\/]/).pop() ?? "file";
      // flushSync forces React to paint the progress bar before the upload starts
      flushSync(() => { setUploadFile(fileName); setUploadPct(0); });
      const remotePath = currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;
      try { await sftpUpload(sessionId, localPath, remotePath); }
      catch (err) { setError(String(err)); }
    }
    setUploadFile(null);
    loadDir(sessionId, currentPath);
  }, [sessionId, currentPath, loadDir]);

  // Upload progress events from Rust
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<number>("sftp-upload-progress", (e) => {
      setUploadPct(e.payload);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Tauri native drag-drop (gives real OS file paths on Linux)
  useEffect(() => {
    if (!sessionId) return;
    let unlisten: (() => void) | null = null;
    getCurrentWebviewWindow().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const dpr = window.devicePixelRatio || 1;
          const cx = p.position.x / dpr;
          const cy = p.position.y / dpr;
          setDragging(cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom);
        }
      } else if (p.type === "drop") {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect && p.paths?.length) {
          const dpr = window.devicePixelRatio || 1;
          const cx = p.position.x / dpr;
          const cy = p.position.y / dpr;
          if (cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) {
            doUpload(p.paths);
          }
        }
        setDragging(false);
      } else if (p.type === "leave") {
        setDragging(false);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [sessionId, doUpload]);

  useEffect(() => {
    if (!sessionId) return;
    const home = username ? `/home/${username}` : "/";
    sftpListDir(sessionId, home)
      .then((r) => { setEntries(r); setCurrentPath(home); setPathInput(home); })
      .catch(() => loadDir(sessionId, "/"));
  }, [sessionId, username, loadDir]);

  useEffect(() => { if (newFolderMode) newFolderRef.current?.focus(); }, [newFolderMode]);
  useEffect(() => { if (newFileMode) newFileRef.current?.focus(); }, [newFileMode]);
  useEffect(() => { if (renamingEntry) { renameRef.current?.focus(); renameRef.current?.select(); } }, [renamingEntry]);
  useEffect(() => { if (editingPath) { pathInputRef.current?.focus(); pathInputRef.current?.select(); } }, [editingPath]);

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

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try { onConnect(await sftpConnect(connectionId)); }
    catch (err) { setError(String(err)); }
    finally { setConnecting(false); }
  };

  const handleUpload = async () => {
    const selected = await openDialog({ multiple: true }).catch(() => null);
    if (!selected) return;
    await doUpload(Array.isArray(selected) ? selected : [selected]);
  };

  const handleDownload = async (entry: SftpEntry) => {
    if (!sessionId || entry.is_dir) return;
    const localPath = await saveDialog({ defaultPath: entry.name }).catch(() => null);
    if (!localPath) return;
    setUploadFile(`↓ ${entry.name}`);
    setUploadPct(0);
    try { await sftpDownload(sessionId, entry.path, localPath); setUploadPct(100); }
    catch (err) { setError(String(err)); }
    finally { setTimeout(() => setUploadFile(null), 800); }
  };

  // HTML5 drag handlers kept only to prevent browser default (open file).
  // Actual file paths come from Tauri's onDragDropEvent above.
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); };
  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); };

  const handleMkdir = async () => {
    const name = newFolderName.trim();
    setNewFolderMode(false); setNewFolderName("");
    if (!name || !sessionId) return;
    try { await sftpMkdir(sessionId, currentPath === "/" ? `/${name}` : `${currentPath}/${name}`); loadDir(sessionId, currentPath); }
    catch (err) { setError(String(err)); }
  };

  const handleCreateFile = async () => {
    const name = newFileName.trim();
    setNewFileMode(false); setNewFileName("");
    if (!name || !sessionId) return;
    try { await sftpCreateFile(sessionId, currentPath === "/" ? `/${name}` : `${currentPath}/${name}`); loadDir(sessionId, currentPath); }
    catch (err) { setError(String(err)); }
  };

  const commitRename = async () => {
    const entry = renamingEntry; const newName = renameValue.trim();
    setRenamingEntry(null); setRenameValue("");
    if (!entry || !newName || newName === entry.name || !sessionId) return;
    const dir = entry.path.substring(0, entry.path.lastIndexOf("/")) || "/";
    const newPath = dir === "/" ? `/${newName}` : `${dir}/${newName}`;
    try { await sftpRename(sessionId, entry.path, newPath); loadDir(sessionId, currentPath); }
    catch (err) { setError(String(err)); }
  };

  const handleDelete = async (entry: SftpEntry) => {
    if (!sessionId || !confirm(`¿Eliminar ${entry.name}?`)) return;
    try { await sftpDelete(sessionId, entry.path, entry.is_dir); loadDir(sessionId, currentPath); }
    catch (err) { setError(String(err)); }
  };

  const openCtxMenu = (e: React.MouseEvent, entry?: SftpEntry) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const formatSize = (b: number) => {
    if (b === 0) return "—";
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1048576).toFixed(1)} MB`;
  };
  const formatDate = (ts: number) => ts ? new Date(ts * 1000).toLocaleDateString() : "—";

  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 bg-[var(--color-bg-surface)] text-[var(--color-text-muted)]">
        <HardDrive size={32} className="opacity-40" />
        <span className="text-xs">SFTP no conectado</span>
        {error && <p className="text-[var(--color-danger)] text-xs px-4 text-center">{error}</p>}
        <button onClick={handleConnect} disabled={connecting}
          className="px-3 py-1.5 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-xs rounded transition-colors disabled:opacity-50">
          {connecting ? "Conectando…" : "Conectar SFTP"}
        </button>
      </div>
    );
  }

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
      <div className="flex items-center gap-1 px-1.5 py-1 border-b border-[var(--color-border)] shrink-0">
        <button onClick={navigateUp} disabled={currentPath === "/"} title="Subir un nivel"
          className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-30 transition-colors">
          <ChevronLeft size={12} />
        </button>
        {editingPath ? (
          <input ref={pathInputRef} value={pathInput} onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commitPathInput(); if (e.key === "Escape") { setEditingPath(false); setPathInput(currentPath); } }}
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

      {/* Action toolbar */}
      <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-[var(--color-border)] shrink-0">
        <TBtn icon={<Upload size={11} />} label="Upload" onClick={handleUpload} />
        <TBtn icon={<FolderPlus size={11} />} label="Carpeta" onClick={() => setNewFolderMode(true)} />
        <TBtn icon={<FilePlus size={11} />} label="Archivo" onClick={() => setNewFileMode(true)} />
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-2 py-1 text-[10px] text-[var(--color-danger)] bg-[var(--color-danger)]/10 shrink-0 cursor-pointer" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {/* File list — drag-and-drop works over the whole area */}
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

              {entries.map((entry) => (
                <tr key={entry.path}
                  className="hover:bg-[var(--color-bg-hover)] cursor-pointer"
                  onClick={() => { if (entry.is_dir) navigateTo(entry.path); }}
                  onContextMenu={(e) => { e.stopPropagation(); openCtxMenu(e, entry); }}
                  onDoubleClick={() => { if (!entry.is_dir) handleDownload(entry); }}
                >
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-2">
                      {entry.is_dir
                        ? <Folder size={12} className="text-[var(--color-accent)] shrink-0" />
                        : <File size={12} className="text-[var(--color-text-muted)] shrink-0" />}
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
                    {entry.is_dir ? "—" : formatSize(entry.size)}
                  </td>
                  <td className="px-2 py-1 text-right text-[var(--color-text-muted)] text-[10px]">
                    {formatDate(entry.modified)}
                  </td>
                </tr>
              ))}

              {entries.length === 0 && !loading && !newFolderMode && !newFileMode && (
                <tr><td colSpan={3} className="px-2 py-4 text-center text-[var(--color-text-muted)] text-xs">Carpeta vacía</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Progress bar — visible only during transfer */}
      <div className="shrink-0 border-t border-[var(--color-border)]" style={{ height: uploadFile ? "28px" : "0", overflow: "hidden", transition: "height 0.15s" }}>
        {uploadFile && (
          <div className="flex flex-col justify-center px-2 h-full gap-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[var(--color-text-muted)] truncate">{uploadFile}</span>
              <span className="text-[10px] text-[var(--color-text-muted)] shrink-0 ml-2">{uploadPct}%</span>
            </div>
            <div className="w-full bg-[var(--color-bg-elevated)] rounded-full h-1">
              <div
                className="bg-[var(--color-accent)] h-1 rounded-full transition-all"
                style={{ width: `${uploadPct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div className="fixed z-50 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded shadow-lg py-0.5 min-w-[150px]"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={(e) => e.stopPropagation()}>
          {ctxMenu.entry ? (
            <>
              {!ctxMenu.entry.is_dir && <CtxItem icon={<Download size={12} />} label="Descargar" onClick={() => { handleDownload(ctxMenu.entry!); setCtxMenu(null); }} />}
              {ctxMenu.entry.is_dir && <CtxItem icon={<Folder size={12} />} label="Abrir" onClick={() => { navigateTo(ctxMenu.entry!.path); setCtxMenu(null); }} />}
              <CtxItem icon={<Pencil size={12} />} label="Renombrar" onClick={() => { setRenamingEntry(ctxMenu.entry!); setRenameValue(ctxMenu.entry!.name); setCtxMenu(null); }} />
              <div className="my-0.5 border-t border-[var(--color-border)]" />
              <CtxItem icon={<Trash2 size={12} />} label="Eliminar" danger onClick={() => { handleDelete(ctxMenu.entry!); setCtxMenu(null); }} />
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
