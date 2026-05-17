import { useEffect, useState, useCallback, useRef } from "react";
import {
  Folder, File, Upload, FolderPlus, RefreshCw, ChevronRight, HardDrive,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  sftpConnect, sftpListDir, sftpUpload, sftpMkdir, sftpDelete,
} from "../../lib/commands";
import type { SftpEntry } from "../../types";

interface SftpBrowserProps {
  sessionId: string | null;
  connectionId: string;
  onConnect: (sessionId: string) => void;
}

export function SftpBrowser({ sessionId, connectionId, onConnect }: SftpBrowserProps) {
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  const loadDir = useCallback(
    async (sid: string, path: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await sftpListDir(sid, path);
        setEntries(result);
        setCurrentPath(path);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (sessionId) {
      loadDir(sessionId, "/");
    }
  }, [sessionId, loadDir]);

  useEffect(() => {
    if (newFolderMode && newFolderInputRef.current) {
      newFolderInputRef.current.focus();
    }
  }, [newFolderMode]);

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

  const navigateTo = (path: string) => {
    if (!sessionId) return;
    loadDir(sessionId, path);
  };

  const navigateUp = () => {
    if (currentPath === "/") return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const parent = "/" + parts.join("/");
    navigateTo(parent || "/");
  };

  const handleEntryClick = (entry: SftpEntry) => {
    if (entry.is_dir) {
      navigateTo(entry.path);
    }
  };

  const handleUpload = async () => {
    if (!sessionId) return;
    try {
      const selected = await openDialog({ multiple: true });
      if (!selected) return;
      const files = Array.isArray(selected) ? selected : [selected];
      for (const localPath of files) {
        const fileName = localPath.split("/").pop() ?? localPath.split("\\").pop() ?? "file";
        const remotePath = currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;
        await sftpUpload(sessionId, localPath, remotePath);
      }
      loadDir(sessionId, currentPath);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleMkdir = async () => {
    const name = newFolderName.trim();
    if (!name || !sessionId) {
      setNewFolderMode(false);
      setNewFolderName("");
      return;
    }
    try {
      const path = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
      await sftpMkdir(sessionId, path);
      setNewFolderMode(false);
      setNewFolderName("");
      loadDir(sessionId, currentPath);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDelete = async (entry: SftpEntry) => {
    if (!sessionId) return;
    if (!confirm(`Delete ${entry.name}?`)) return;
    try {
      await sftpDelete(sessionId, entry.path, entry.is_dir);
      loadDir(sessionId, currentPath);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleRefresh = () => {
    if (sessionId) loadDir(sessionId, currentPath);
  };

  // Drag-and-drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = () => setDragging(false);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!sessionId) return;
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      // In Tauri, dropped files have a path
      const localPath = (file as File & { path?: string }).path;
      if (!localPath) continue;
      const remotePath = currentPath === "/" ? `/${file.name}` : `${currentPath}/${file.name}`;
      try {
        await sftpUpload(sessionId, localPath, remotePath);
      } catch (err) {
        setError(String(err));
      }
    }
    loadDir(sessionId, currentPath);
  };

  // Breadcrumb segments
  const pathSegments = currentPath.split("/").filter(Boolean);

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (ts: number): string => {
    if (!ts) return "—";
    return new Date(ts * 1000).toLocaleDateString();
  };

  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 bg-[var(--color-bg-surface)] text-[var(--color-text-muted)]">
        <HardDrive size={32} className="opacity-40" />
        <span className="text-xs">SFTP not connected</span>
        {error && <p className="text-[var(--color-danger)] text-xs px-4 text-center">{error}</p>}
        <button
          onClick={handleConnect}
          disabled={connecting}
          className="px-3 py-1.5 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-xs rounded transition-colors disabled:opacity-50"
        >
          {connecting ? "Connecting…" : "Connect SFTP"}
        </button>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col h-full bg-[var(--color-bg-surface)] border-l border-[var(--color-border)] ${
        dragging ? "ring-2 ring-inset ring-[var(--color-accent)]" : ""
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--color-border)] shrink-0 overflow-x-auto">
        <button
          onClick={() => navigateTo("/")}
          className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] shrink-0"
        >
          /
        </button>
        {pathSegments.map((seg, i) => {
          const segPath = "/" + pathSegments.slice(0, i + 1).join("/");
          return (
            <span key={segPath} className="flex items-center gap-1 shrink-0">
              <ChevronRight size={10} className="text-[var(--color-text-muted)]" />
              <button
                onClick={() => navigateTo(segPath)}
                className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] max-w-[80px] truncate"
                title={seg}
              >
                {seg}
              </button>
            </span>
          );
        })}
      </div>

      {/* Error */}
      {error && (
        <div className="px-2 py-1 text-[10px] text-[var(--color-danger)] bg-[var(--color-danger)]/10 shrink-0">
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
                <th className="text-left px-2 py-1 font-medium">Name</th>
                <th className="text-right px-2 py-1 font-medium w-16">Size</th>
                <th className="text-right px-2 py-1 font-medium w-20">Modified</th>
              </tr>
            </thead>
            <tbody>
              {currentPath !== "/" && (
                <tr
                  className="hover:bg-[var(--color-bg-hover)] cursor-pointer"
                  onClick={navigateUp}
                >
                  <td className="px-2 py-1 flex items-center gap-2">
                    <Folder size={12} className="text-[var(--color-text-muted)] shrink-0" />
                    <span className="text-[var(--color-text-muted)]">..</span>
                  </td>
                  <td />
                  <td />
                </tr>
              )}
              {newFolderMode && (
                <tr>
                  <td className="px-2 py-1" colSpan={3}>
                    <div className="flex items-center gap-2">
                      <Folder size={12} className="text-[var(--color-text-muted)] shrink-0" />
                      <input
                        ref={newFolderInputRef}
                        type="text"
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleMkdir();
                          if (e.key === "Escape") {
                            setNewFolderMode(false);
                            setNewFolderName("");
                          }
                        }}
                        onBlur={() => {
                          setNewFolderMode(false);
                          setNewFolderName("");
                        }}
                        placeholder="New folder name…"
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
                  onClick={() => handleEntryClick(entry)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    handleDelete(entry);
                  }}
                >
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-2">
                      {entry.is_dir ? (
                        <Folder size={12} className="text-[var(--color-accent)] shrink-0" />
                      ) : (
                        <File size={12} className="text-[var(--color-text-muted)] shrink-0" />
                      )}
                      <span className="truncate text-[var(--color-text-primary)]" title={entry.name}>
                        {entry.name}
                      </span>
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
              {entries.length === 0 && !loading && (
                <tr>
                  <td colSpan={3} className="px-2 py-4 text-center text-[var(--color-text-muted)] text-xs">
                    Empty directory
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Bottom toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-t border-[var(--color-border)] shrink-0">
        <button
          onClick={handleUpload}
          title="Upload files"
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          <Upload size={12} />
          Upload
        </button>
        <button
          onClick={() => setNewFolderMode(true)}
          title="New folder"
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          <FolderPlus size={12} />
          Folder
        </button>
        <button
          onClick={handleRefresh}
          title="Refresh"
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors ml-auto"
        >
          <RefreshCw size={12} />
          Refresh
        </button>
      </div>
    </div>
  );
}
