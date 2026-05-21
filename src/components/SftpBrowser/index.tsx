import { useEffect, useState, useCallback, useRef } from "react";
import {
  Folder, File, Upload, Download, FolderPlus, FilePlus, RefreshCw,
  HardDrive, ChevronLeft, Pencil, Trash2,
} from "lucide-react";
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

interface CtxMenu {
  x: number;
  y: number;
  entry?: SftpEntry;
}

export function SftpBrowser({ sessionId, connectionId, username, onConnect }: SftpBrowserProps) {
  const [currentPath, setCurrentPath] = useState("/");
  const [pathInput, setPathInput] = useState("/");
  const [editingPath, setEditingPath] = useState(false);
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  // Inline creation / rename
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFileMode, setNewFileMode] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [renamingEntry, setRenamingEntry] = useState<SftpEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

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

  useEffect(() => {
    if (!sessionId) return;
    const home = username ? `/home/${username}` : "/";
    sftpListDir(sessionId, home)
      .then((result) => { setEntries(result); setCurrentPath(home); setPathInput(home); })
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
    try {
      const sid = await sftpConnect(connectionId);
      onConnect(sid);
    } catch (err) {
      setError(String(err));
    } finally {
      setConnecting(false);
    }
  };

  // Upload via dialog
  const handleUpload = async () => {
    if (!sessionId) return;
    try {
      const selected = await openDialog({ multiple: true });
      if (!selected) return;
      const files = Array.isArray(selected) ? selected : [selected];
      for (const localPath of files) {
        const fileName = localPath.split(/[\\/]/).pop() ?? "file";
        setUploadStatus(`Subiendo ${fileName}…`);
        const remotePath = currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;
        await sftpUpload(sessionId, localPath, remotePath);
      }
      loadDir(sessionId, currentPath);
    } catch (err) {
      setError(String(err));
    } finally {
      setUploadStatus(null);
    }
  };

  // Download a file
  const handleDownload = async (entry: SftpEntry) => {
    if (!sessionId || entry.is_dir) return;
    try {
      const localPath = await saveDialog({ defaultPath: entry.name });
      if (!localPath) return;
      setUploadStatus(`Descargando ${entry.name}…`);
      await sftpDownload(sessionId, entry.path, localPath);
    } catch (err) {
      setError(String(err));
    } finally {
      setUploadStatus(null);
    }
  };

  // Drag-and-drop upload
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = () => setDragging(false);
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!sessionId) return;
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      const localPath = (file as File & { path?: string }).path;
      if (!localPath) { setError("No se pudo obtener la ruta. Usá el botón Upload."); continue; }
      try {
        setUploadStatus(`Subiendo ${file.name}…`);
        const remotePath = currentPath === "/" ? `/${file.name}` : `${currentPath}/${file.name}`;
        await sftpUpload(sessionId, localPath, remotePath);
      } catch (err) {
        setError(String(err));
      }
    }
    setUploadStatus(null);
    loadDir(sessionId, currentPath);
  };

  // Mkdir
  const handleMkdir = async () => {
    const name = newFolderName.trim();
    setNewFolderMode(false);
    setNewFolderName("");
    if (!name || !sessionId) return;
    try {
      await sftpMkdir(sessionId, currentPath === "/" ? `/${name}` : `${currentPath}/${name}`);
      loadDir(sessionId, currentPath);
    } catch (err) { setError(String(err)); }
  };

  // Create file
  const handleCreateFile = async () => {
    const name = newFileName.trim();
    setNewFileMode(false);
    setNewFileName("");
    if (!name || !sessionId) return;
    try {
      await sftpCreateFile(sessionId, currentPath === "/" ? `/${name}` : `${currentPath}/${name}`);
      loadDir(sessionId, currentPath);
    } catch (err) { setError(String(err)); }
  };

  // Rename
  const commitRename = async () => {
    const entry = renamingEntry;
    const newName = renameValue.trim();
    setRenamingEntry(null);
    setRenameValue("");
    if (!entry || !newName || newName === entry.name || !sessionId) return;
    const dir = entry.path.substring(0, entry.path.lastIndexOf("/")) || "/";
    const newPath = dir === "/" ? `/${newName}` : `${dir}/${newName}`;
    try {
      await sftpRename(sessionId, entry.path, newPath);
      loadDir(sessionId, currentPath);
    } catch (err) { setError(String(err)); }
  };

  // Delete
  const handleDelete = async (entry: SftpEntry) => {
    if (!sessionId || !confirm(`¿Eliminar ${entry.name}?`)) return;
    try {
      await sftpDelete(sessionId, entry.path, entry.is_dir);
      loadDir(sessionId, currentPath);
    } catch (err) { setError(String(err)); }
  };

  const openCtxMenu = (e: React.MouseEvent, entry?: SftpEntry) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  const formatDate = (ts: number) => ts ? new Date(ts * 1000).toLocaleDateString() : "—";

  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 bg-[var(--color-bg-surface)] text-[var(--color-text-muted)]">
        <HardDrive size={32} className="opacity-40" />
        <span className="text-xs">SFTP no conectado</span>
        {error && <p className="text-[var(--color-danger)] text-xs px-4 text-center">{error}</p>}
        <button
          onClick={handleConnect}
          disabled={connecting}
          className="px-3 py-1.5 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-xs rounded transition-colors disabled:opacity-50"
        >
          {connecting ? "Conectando…" : "Conectar SFTP"}
        </button>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col h-full bg-[var(--color-bg-surface)] border-l border-[var(--color-border)] select-none ${
        dragging ? "ring-2 ring-inset ring-[var(--color-accent)]" : ""
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => setCtxMenu(null)}
      onContextMenu={(e) => { e.preventDefault(); openCtxMenu(e); }}
    >
      {/* Path bar */}
      <div className="flex items-center gap-1 px-1.5 py-1 border-b border-[var(--color-border)] shrink-0">
        <button
          onClick={navigateUp}
          disabled={currentPath === "/"}
          title="Subir un nivel"
          className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-30 transition-colors"
        >
          <ChevronLeft size={12} />
        </button>
        {editingPath ? (
          <input
            ref={pathInputRef}
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitPathInput();
              if (e.key === "Escape") { setEditingPath(false); setPathInput(currentPath); }
            }}
            onBlur={commitPathInput}
            className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-primary)] outline-none"
          />
        ) : (
          <button
            className="flex-1 text-left text-[10px] font-mono text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] truncate"
            title="Click para editar ruta"
            onClick={(e) => { e.stopPropagation(); setEditingPath(true); }}
          >
            {currentPath}
          </button>
        )}
        <button onClick={() => sessionId && loadDir(sessionId, currentPath)} title="Refrescar" className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors">
          <RefreshCw size={11} />
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="px-2 py-1 text-[10px] text-[var(--color-danger)] bg-[var(--color-danger)]/10 shrink-0 cursor-pointer"
          onClick={() => setError(null)}
        >
          {error} (click para cerrar)
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
                <tr>
                  <td className="px-2 py-1" colSpan={3}>
                    <div className="flex items-center gap-2">
                      <Folder size={12} className="text-[var(--color-accent)] shrink-0" />
                      <input ref={newFolderRef} type="text" value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleMkdir(); if (e.key === "Escape") { setNewFolderMode(false); setNewFolderName(""); } }}
                        onBlur={handleMkdir}
                        placeholder="Nombre de carpeta…"
                        className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-2 py-0.5 text-xs text-[var(--color-text-primary)] outline-none"
                      />
                    </div>
                  </td>
                </tr>
              )}

              {newFileMode && (
                <tr>
                  <td className="px-2 py-1" colSpan={3}>
                    <div className="flex items-center gap-2">
                      <File size={12} className="text-[var(--color-text-muted)] shrink-0" />
                      <input ref={newFileRef} type="text" value={newFileName}
                        onChange={(e) => setNewFileName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleCreateFile(); if (e.key === "Escape") { setNewFileMode(false); setNewFileName(""); } }}
                        onBlur={handleCreateFile}
                        placeholder="Nombre de archivo…"
                        className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-2 py-0.5 text-xs text-[var(--color-text-primary)] outline-none"
                      />
                    </div>
                  </td>
                </tr>
              )}

              {entries.map((entry) => (
                <tr
                  key={entry.path}
                  className="hover:bg-[var(--color-bg-hover)] cursor-pointer group"
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
                        <input
                          ref={renameRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setRenamingEntry(null); } }}
                          onBlur={commitRename}
                          onClick={(e) => e.stopPropagation()}
                          className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-1 py-0 text-xs text-[var(--color-text-primary)] outline-none"
                        />
                      ) : (
                        <span className="truncate text-[var(--color-text-primary)]" title={entry.name}>
                          {entry.name}
                        </span>
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
                <tr>
                  <td colSpan={3} className="px-2 py-4 text-center text-[var(--color-text-muted)] text-xs">
                    Carpeta vacía
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Bottom toolbar / status */}
      <div className="flex items-center gap-1 px-2 py-1 border-t border-[var(--color-border)] shrink-0 min-h-[28px]">
        {uploadStatus ? (
          <span className="text-[10px] text-[var(--color-text-muted)] animate-pulse flex-1 truncate">
            {uploadStatus}
          </span>
        ) : (
          <>
            <button onClick={handleUpload} title="Subir archivo" className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors">
              <Upload size={11} /> Upload
            </button>
            <button onClick={() => setNewFolderMode(true)} title="Nueva carpeta" className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors">
              <FolderPlus size={11} />
            </button>
            <button onClick={() => setNewFileMode(true)} title="Nuevo archivo" className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors">
              <FilePlus size={11} />
            </button>
            <span className="text-[9px] text-[var(--color-text-muted)] ml-1 opacity-50">
              {dragging ? "Soltar para subir" : "Arrastrá archivos aquí"}
            </span>
          </>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="fixed z-50 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded shadow-lg py-0.5 min-w-[140px]"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.entry ? (
            <>
              {!ctxMenu.entry.is_dir && (
                <CtxItem icon={<Download size={12} />} label="Descargar" onClick={() => { handleDownload(ctxMenu.entry!); setCtxMenu(null); }} />
              )}
              {ctxMenu.entry.is_dir && (
                <CtxItem icon={<Folder size={12} />} label="Abrir" onClick={() => { navigateTo(ctxMenu.entry!.path); setCtxMenu(null); }} />
              )}
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

function CtxItem({ icon, label, onClick, danger = false }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 w-full px-3 py-1 text-[11px] text-left transition-colors ${
        danger
          ? "text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
          : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
