import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  ChevronLeft, ChevronRight, ChevronDown, RefreshCw, FolderPlus, Pencil, Trash2,
  ArrowRight, ArrowLeft, Loader, WifiOff, HardDrive, Home, Eye, EyeOff,
  File, Folder, Scissors, ClipboardPaste,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useAppStore } from "../../store/useAppStore";
import { useNotifStore } from "../../store/useNotifStore";
import {
  sftpConnect, sftpDisconnect, sftpListDir, sftpUpload, sftpDownload,
  sftpMkdir, sftpRename, sftpDelete,
  localListDir, localGetHome, localGetParent, localMkdir, localDelete,
} from "../../lib/commands";
import type { LocalEntry } from "../../lib/commands";
import type { SftpEntry } from "../../types";
import { friendlyFsError } from "../../lib/transferErrors";
import { resolveUploadOverwrites } from "../../lib/overwrite";
import { useTransferStore } from "../../store/useTransferStore";
import type { Tab } from "../../types";

type AnyEntry = (SftpEntry | LocalEntry) & { is_dir: boolean; name: string; path: string; size: number };

type FlatRow = {
  entry: AnyEntry;
  depth: number;
  isExpanded: boolean;
  isLoading: boolean;
  isLast: boolean;
  continuations: boolean[];
};

interface SftpProgress { transferred: number; total: number }
interface CtxMenu { x: number; y: number; side: "local" | "remote"; entry?: AnyEntry }
type SortCol = "name" | "type" | "size" | "modified";

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

function fileExt(name: string, isDir: boolean): string {
  if (isDir) return "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

// ── File Panel ────────────────────────────────────────────────────────────────

interface PanelProps {
  title: string;
  accentClass: string;
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
  fetchDir: (path: string) => Promise<AnyEntry[]>;
  onFlatRowsChange?: (rows: AnyEntry[]) => void;
  // Drag-and-drop props
  isDragOver: boolean;
  dragOverFolderPath: string | null;
  onRowDragStart: (entry: AnyEntry, selectedFileEntries: AnyEntry[]) => void;
  onPanelDragOver: (e: React.DragEvent) => void;
  onFolderDragOver: (path: string) => void;
  onDropOnPanel: (targetFolder: string | null) => void;
  onDragLeave: () => void;
  cutPaths?: Set<string>;
}

function FilePanel({
  title, accentClass, path, entries, selected, loading, error,
  showHidden, onToggleHidden,
  onNavigate, onUp, onHome, onRefresh, onSelect, onCtxMenu,
  onMkdir,
  renamingPath, renameValue, onRenameChange, onRenameCommit, onRenameCancel,
  fetchDir, onFlatRowsChange,
  isDragOver, dragOverFolderPath,
  onRowDragStart, onPanelDragOver, onFolderDragOver, onDropOnPanel, onDragLeave,
  cutPaths,
}: PanelProps) {
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState(path);
  const pathRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  // Tree state
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirChildren, setDirChildren] = useState<Map<string, AnyEntry[]>>(new Map());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());

  // Sort state
  const [sortBy, setSortBy] = useState<SortCol>("name");
  const [sortAsc, setSortAsc] = useState(true);

  // Path autocomplete
  const [pathSuggestions, setPathSuggestions] = useState<string[]>([]);
  const [suggestionIdx, setSuggestionIdx] = useState(-1);
  const suggestionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset tree on navigation
  useEffect(() => {
    setExpandedDirs(new Set());
    setDirChildren(new Map());
    setLoadingDirs(new Set());
  }, [path]);

  useEffect(() => { setPathInput(path); }, [path]);
  useEffect(() => { if (editingPath) { pathRef.current?.focus(); pathRef.current?.select(); } }, [editingPath]);
  useEffect(() => { if (renamingPath) { renameRef.current?.focus(); renameRef.current?.select(); } }, [renamingPath]);

  // Path autocomplete effect
  useEffect(() => {
    if (!editingPath) { setPathSuggestions([]); return; }
    if (suggestionTimer.current) clearTimeout(suggestionTimer.current);
    suggestionTimer.current = setTimeout(async () => {
      try {
        const lastSlash = pathInput.lastIndexOf("/");
        const dir = pathInput.substring(0, lastSlash) || "/";
        const fragment = pathInput.substring(lastSlash + 1).toLowerCase();
        const result = await fetchDir(dir);
        const matches = result
          .filter((e) => e.is_dir && e.name.toLowerCase().startsWith(fragment))
          .map((e) => e.path)
          .slice(0, 8);
        setPathSuggestions(matches);
        setSuggestionIdx(-1);
      } catch { setPathSuggestions([]); }
    }, 250);
    return () => { if (suggestionTimer.current) clearTimeout(suggestionTimer.current); };
  }, [pathInput, editingPath, fetchDir]);

  const commitPath = () => {
    setEditingPath(false);
    setPathSuggestions([]);
    const p = pathInput.trim() || "/";
    if (p !== path) onNavigate(p);
  };

  const acceptSuggestion = (s: string) => {
    setPathInput(s + "/");
    setPathSuggestions([]);
    setSuggestionIdx(-1);
    pathRef.current?.focus();
  };

  // Sort comparator
  const sortFn = useCallback((a: AnyEntry, b: AnyEntry): number => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let cmp = 0;
    if (sortBy === "name") cmp = a.name.localeCompare(b.name);
    else if (sortBy === "type") cmp = fileExt(a.name, a.is_dir).localeCompare(fileExt(b.name, b.is_dir));
    else if (sortBy === "size") cmp = a.size - b.size;
    else if (sortBy === "modified") cmp = ((a.modified as number) ?? 0) - ((b.modified as number) ?? 0);
    return sortAsc ? cmp : -cmp;
  }, [sortBy, sortAsc]);

  // Recursive flatten
  const flattenTree = useCallback((
    items: AnyEntry[],
    depth: number,
    continuations: boolean[],
  ): FlatRow[] => {
    const visible = (showHidden ? items : items.filter((e) => !e.name.startsWith(".")))
      .slice()
      .sort(sortFn);
    const result: FlatRow[] = [];
    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i];
      const isLast = i === visible.length - 1;
      const isExp = entry.is_dir && expandedDirs.has(entry.path);
      const isLoad = entry.is_dir && loadingDirs.has(entry.path);
      result.push({ entry, depth, isExpanded: isExp, isLoading: isLoad, isLast, continuations });
      if (isExp) {
        const kids = dirChildren.get(entry.path) ?? [];
        result.push(...flattenTree(kids, depth + 1, [...continuations, !isLast]));
      }
    }
    return result;
  }, [showHidden, sortFn, expandedDirs, loadingDirs, dirChildren]);

  const flatRows = useMemo(() => flattenTree(entries, 0, []), [entries, flattenTree]);

  // Notify parent of flat row order (for shift-select)
  useEffect(() => {
    onFlatRowsChange?.(flatRows.map((r) => r.entry));
  }, [flatRows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Expand/collapse a folder inline
  const handleToggleExpand = async (e: React.MouseEvent, entry: AnyEntry) => {
    e.stopPropagation();
    if (!entry.is_dir) return;
    if (expandedDirs.has(entry.path)) {
      setExpandedDirs((prev) => { const n = new Set(prev); n.delete(entry.path); return n; });
    } else {
      if (!dirChildren.has(entry.path)) {
        setLoadingDirs((prev) => new Set(prev).add(entry.path));
        try {
          const kids = await fetchDir(entry.path);
          setDirChildren((prev) => new Map(prev).set(entry.path, kids as AnyEntry[]));
        } catch { /* ignore fetch errors for tree */ } finally {
          setLoadingDirs((prev) => { const n = new Set(prev); n.delete(entry.path); return n; });
        }
      }
      setExpandedDirs((prev) => new Set(prev).add(entry.path));
    }
  };

  const toggleSort = (col: SortCol) => {
    if (sortBy === col) setSortAsc((v) => !v);
    else { setSortBy(col); setSortAsc(true); }
  };

  const sortArrow = (col: SortCol) =>
    sortBy === col ? <span className="ml-0.5 opacity-70">{sortAsc ? "▲" : "▼"}</span> : null;

  return (
    <div
      className="flex flex-col h-full bg-[var(--color-bg-surface)] min-w-0 relative"
      onContextMenu={(e) => { e.preventDefault(); onCtxMenu(e); }}
    >
      {/* Drag-over overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-[var(--color-accent)]/10 border-2 border-[var(--color-accent)] pointer-events-none z-20" />
      )}

      {/* Header */}
      <div className={`flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] shrink-0 ${accentClass}`}>
        <span className="text-[10px] font-semibold uppercase tracking-wider">{title}</span>
        <span className="ml-auto text-[10px] opacity-60">{flatRows.length} elementos</span>
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

        {/* Path input with autocomplete */}
        <div className="flex-1 relative">
          {editingPath ? (
            <>
              <input
                ref={pathRef}
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const target = suggestionIdx >= 0 ? pathSuggestions[suggestionIdx] : pathSuggestions[0];
                    if (target) acceptSuggestion(target);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSuggestionIdx((i) => Math.min(i + 1, pathSuggestions.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSuggestionIdx((i) => Math.max(i - 1, -1));
                  } else if (e.key === "Enter") {
                    if (suggestionIdx >= 0 && pathSuggestions[suggestionIdx]) {
                      acceptSuggestion(pathSuggestions[suggestionIdx]);
                    } else {
                      commitPath();
                    }
                  } else if (e.key === "Escape") {
                    setEditingPath(false);
                    setPathInput(path);
                    setPathSuggestions([]);
                  }
                }}
                onBlur={commitPath}
                className="w-full bg-transparent border border-[var(--color-accent)] rounded px-1.5 py-0 text-[10px] font-mono text-[var(--color-text-primary)] outline-none"
              />
              {pathSuggestions.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-50 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded shadow-lg mt-0.5 max-h-48 overflow-y-auto">
                  {pathSuggestions.map((s, i) => (
                    <button
                      key={s}
                      onMouseDown={(e) => { e.preventDefault(); acceptSuggestion(s); }}
                      className={`flex items-center gap-1.5 w-full px-2 py-0.5 text-[10px] font-mono text-left transition-colors ${
                        i === suggestionIdx
                          ? "bg-[var(--color-accent)]/20 text-[var(--color-text-primary)]"
                          : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
                      }`}
                    >
                      <Folder size={9} className="shrink-0 opacity-60" />
                      {s.split("/").filter(Boolean).pop() || s}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <button
              onClick={() => setEditingPath(true)}
              className="w-full text-left text-[10px] font-mono text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] truncate px-1"
              title={path}
            >
              {path}
            </button>
          )}
        </div>

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
      <div
        className="flex-1 overflow-y-auto min-h-0 text-xs"
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; onPanelDragOver(e); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) onDragLeave(); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDropOnPanel(null); }}
      >
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader size={16} className="animate-spin text-[var(--color-text-muted)]" />
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-[var(--color-bg-surface)] z-10">
              <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)] text-[10px]">
                <th className="text-left px-2 py-0.5 font-medium">
                  <button
                    className="flex items-center gap-0.5 hover:text-[var(--color-text-primary)] transition-colors"
                    onClick={() => toggleSort("name")}
                  >
                    Nombre{sortArrow("name")}
                  </button>
                </th>
                <th className="text-right px-2 py-0.5 font-medium w-10">
                  <button
                    className="flex items-center justify-end gap-0.5 w-full hover:text-[var(--color-text-primary)] transition-colors"
                    onClick={() => toggleSort("type")}
                  >
                    {sortArrow("type")}Ext
                  </button>
                </th>
                <th className="text-right px-2 py-0.5 font-medium w-16">
                  <button
                    className="flex items-center justify-end gap-0.5 w-full hover:text-[var(--color-text-primary)] transition-colors"
                    onClick={() => toggleSort("size")}
                  >
                    {sortArrow("size")}Tamaño
                  </button>
                </th>
                <th className="text-right px-2 py-0.5 font-medium w-20">
                  <button
                    className="flex items-center justify-end gap-0.5 w-full hover:text-[var(--color-text-primary)] transition-colors"
                    onClick={() => toggleSort("modified")}
                  >
                    {sortArrow("modified")}Modificado
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {flatRows.map(({ entry, depth, isExpanded, isLoading, isLast, continuations }) => {
                const isSel = selected.has(entry.path);
                const ext = fileExt(entry.name, entry.is_dir);
                const isFolderDragTarget = entry.is_dir && dragOverFolderPath === entry.path;
                const isCut = cutPaths?.has(entry.path) ?? false;
                return (
                  <tr
                    key={entry.path}
                    draggable
                    className={`cursor-pointer border-b border-[var(--color-border)]/30 ${
                      isFolderDragTarget
                        ? "bg-[var(--color-accent)]/30"
                        : isSel
                          ? "bg-[var(--color-accent)]/20"
                          : "hover:bg-[var(--color-bg-hover)]"
                    } ${isCut ? "opacity-40" : ""}`}
                    onClick={(e) => onSelect(e, entry)}
                    onDoubleClick={() => { if (entry.is_dir) onNavigate(entry.path); }}
                    onContextMenu={(e) => { e.stopPropagation(); onCtxMenu(e, entry); }}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "copy";
                      e.dataTransfer.setData("text/plain", entry.path);
                      const selFiles = flatRows
                        .map((r) => r.entry)
                        .filter((en) => selected.has(en.path));
                      onRowDragStart(entry, selFiles.length > 0 ? selFiles : [entry]);
                    }}
                    onDragOver={entry.is_dir ? (e) => { e.stopPropagation(); e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (dragOverFolderPath !== entry.path) onFolderDragOver(entry.path); } : undefined}
                    onDrop={entry.is_dir ? (e) => { e.stopPropagation(); e.preventDefault(); onDropOnPanel(entry.path); } : undefined}
                  >
                    <td className="py-0.5 pl-1 pr-1">
                      <div className="flex items-center gap-0.5 min-w-0">
                        {/* ASCII tree prefix */}
                        {depth > 0 && (
                          <span
                            className="font-mono shrink-0 select-none text-[var(--color-border)]"
                            style={{ fontSize: "10px", whiteSpace: "pre", lineHeight: 1 }}
                          >
                            {continuations.map((c) => (c ? "│  " : "   ")).join("")}{isLast ? "└─" : "├─"}{" "}
                          </span>
                        )}
                        {/* Expand toggle for dirs, spacer for files */}
                        {entry.is_dir ? (
                          <button
                            className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors p-0.5 rounded"
                            onClick={(e) => handleToggleExpand(e, entry)}
                            title={isExpanded ? "Colapsar" : "Expandir"}
                          >
                            {isLoading
                              ? <Loader size={9} className="animate-spin" />
                              : isExpanded
                                ? <ChevronDown size={9} />
                                : <ChevronRight size={9} />}
                          </button>
                        ) : (
                          <span className="w-[14px] shrink-0" />
                        )}
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
                    <td className="px-2 py-0.5 text-right text-[var(--color-text-muted)] text-[9px] whitespace-nowrap">
                      {ext}
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
              {flatRows.length === 0 && !loading && (
                <tr>
                  <td colSpan={4} className="px-2 py-6 text-center text-[var(--color-text-muted)] text-xs">
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
          : `${flatRows.length} elemento${flatRows.length !== 1 ? "s" : ""}`}
      </div>
    </div>
  );
}

// ── Recursive transfer helpers ────────────────────────────────────────────────

async function uploadEntryRecursive(sid: string, entry: AnyEntry, remoteDir: string): Promise<void> {
  const dest = remoteDir === "/" ? `/${entry.name}` : `${remoteDir}/${entry.name}`;
  if (!entry.is_dir) {
    await sftpUpload(sid, entry.path, dest);
  } else {
    try { await sftpMkdir(sid, dest); } catch { /* may already exist */ }
    const kids = await localListDir(entry.path) as AnyEntry[];
    for (const kid of kids) await uploadEntryRecursive(sid, kid, dest);
  }
}

async function downloadEntryRecursive(sid: string, entry: AnyEntry, localDir: string): Promise<void> {
  const dest = localDir.endsWith("/") ? `${localDir}${entry.name}` : `${localDir}/${entry.name}`;
  if (!entry.is_dir) {
    await sftpDownload(sid, entry.path, dest);
  } else {
    try { await localMkdir(dest); } catch { /* may already exist */ }
    const kids = await sftpListDir(sid, entry.path) as AnyEntry[];
    for (const kid of kids) await downloadEntryRecursive(sid, kid, dest);
  }
}

// ── Main dual-pane component ──────────────────────────────────────────────────

export function SftpDualPane({ tab }: { tab: Tab }) {
  const { getConnectionById, setTabStatus, closeTab } = useAppStore();
  const connection = getConnectionById(tab.connection_id);

  // SFTP session
  const sessionIdRef = useRef<string | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [connError, setConnError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  // Auto-close the tab when the SFTP session is lost
  useEffect(() => {
    if (disconnected) {
      const t = setTimeout(() => closeTab(tab.id), 1500);
      return () => clearTimeout(t);
    }
  }, [disconnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Local panel
  const [localPath, setLocalPath] = useState("");
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([]);
  const [localSelected, setLocalSelected] = useState<Set<string>>(new Set());
  const localLastClick = useRef<string | null>(null);
  const localFlatRowsRef = useRef<AnyEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showLocalHidden, setShowLocalHidden] = useState(false);

  // Remote panel
  const [remotePath, setRemotePath] = useState("/");
  const [remoteEntries, setRemoteEntries] = useState<SftpEntry[]>([]);
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(new Set());
  const remoteLastClick = useRef<string | null>(null);
  const remoteFlatRowsRef = useRef<AnyEntry[]>([]);
  // OS file drag-drop onto the remote panel (upload from the local PC).
  const remotePanelRef = useRef<HTMLDivElement>(null);
  const [osDragOverRemote, setOsDragOverRemote] = useState(false);
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

  // Clipboard/cut state
  const [clipboard, setClipboard] = useState<{ entries: AnyEntry[]; side: "local" | "remote" } | null>(null);

  // Drag-and-drop state
  const dragSrcRef = useRef<{ side: "local" | "remote"; entries: AnyEntry[] } | null>(null);
  const [dragOverPanel, setDragOverPanel] = useState<"local" | "remote" | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);

  // ── fetchDir helpers ────────────────────────────────────────────────────────

  const localFetchDir = useCallback(
    (p: string) => localListDir(p).then((r) => r as AnyEntry[]),
    [],
  );

  const remoteFetchDir = useCallback(
    (p: string): Promise<AnyEntry[]> => {
      if (!sessionIdRef.current) return Promise.resolve([]);
      return sftpListDir(sessionIdRef.current, p) as Promise<AnyEntry[]>;
    },
    [],
  );

  // ── Local navigation ────────────────────────────────────────────────────────

  const loadLocal = useCallback(async (p: string) => {
    setLocalLoading(true);
    setLocalError(null);
    try {
      const result = await localListDir(p);
      setLocalEntries(result as LocalEntry[]);
      setLocalPath(p);
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

  const loadRemote = useCallback(async (sid: string, p: string) => {
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      const result = await sftpListDir(sid, p);
      setRemoteEntries(result);
      setRemotePath(p);
      setRemoteSelected(new Set());
      remoteLastClick.current = null;
    } catch (err) {
      const s = String(err);
      if (s.includes("session not found") || s.includes("closed")) setDisconnected(true);
      else setRemoteError(friendlyFsError(err));
    } finally {
      setRemoteLoading(false);
    }
  }, []);

  // Upload OS-dropped file paths to the current remote folder (files only,
  // matching the mini-SFTP behaviour).
  const doUploadLocalPaths = useCallback(async (paths: string[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const toUpload = resolveUploadOverwrites(paths, new Set(remoteEntries.map((e) => e.name)));
    if (toUpload.length === 0) return;
    useTransferStore.getState().enqueue(toUpload.map((localPath) => {
      const fileName = localPath.split(/[\\/]/).pop() ?? "file";
      const dest = remotePath === "/" ? `/${fileName}` : `${remotePath}/${fileName}`;
      return {
        label: fileName, dir: "up" as const,
        run: () => sftpUpload(sid, localPath, dest),
        onComplete: () => loadRemote(sid, remotePath),
      };
    }));
  }, [remotePath, loadRemote, remoteEntries]);

  // Drag files from the OS onto the REMOTE panel to upload them there.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWebviewWindow().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "leave") { setOsDragOverRemote(false); return; }
      const rect = remotePanelRef.current?.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const inside = rect
        ? p.position.x / dpr >= rect.left && p.position.x / dpr <= rect.right
          && p.position.y / dpr >= rect.top && p.position.y / dpr <= rect.bottom
        : false;
      if (p.type === "enter" || p.type === "over") {
        setOsDragOverRemote(inside);
      } else if (p.type === "drop") {
        setOsDragOverRemote(false);
        if (inside && p.paths?.length) doUploadLocalPaths(p.paths);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [doUploadLocalPaths]);

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
      try { await loadRemote(sid, home); } catch { await loadRemote(sid, "/"); }
    } catch (err) {
      const raw = String(err);
      useNotifStore.getState().add({
        connName: connection.name,
        connType: "sftp",
        host: connection.host,
        raw,
      });
      closeTab(tab.id);
    } finally {
      setConnecting(false);
    }
  }, [connection, tab.id, setTabStatus, loadRemote, closeTab]);

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
    getFlatRows: () => AnyEntry[],
    setSelected: React.Dispatch<React.SetStateAction<Set<string>>>,
    lastClick: React.MutableRefObject<string | null>,
  ) {
    return (e: React.MouseEvent, entry: T) => {
      if (e.shiftKey && lastClick.current) {
        const flatRows = getFlatRows();
        const li = flatRows.findIndex((en) => en.path === lastClick.current);
        const ci = flatRows.findIndex((en) => en.path === entry.path);
        if (li >= 0 && ci >= 0) {
          const start = Math.min(li, ci);
          const end = Math.max(li, ci);
          setSelected(new Set(flatRows.slice(start, end + 1).map((en) => en.path)));
          return;
        }
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
    () => localFlatRowsRef.current,
    setLocalSelected,
    localLastClick,
  );

  const toggleRemote = makeToggle(
    () => remoteFlatRowsRef.current,
    setRemoteSelected,
    remoteLastClick,
  );

  // ── Transfer counts (use flat rows to include tree-expanded items) ──────────

  const uploadCount = localFlatRowsRef.current.filter(
    (e) => localSelected.has(e.path),
  ).length;

  const downloadCount = remoteFlatRowsRef.current.filter(
    (e) => remoteSelected.has(e.path),
  ).length;

  // ── Transfer: local → remote (upload) ──────────────────────────────────────

  const handleUpload = async () => {
    if (!sessionIdRef.current || transferring) return;
    const toUpload = localFlatRowsRef.current.filter(
      (e) => localSelected.has(e.path),
    );
    if (toUpload.length === 0) return;

    setTransferring(true);
    for (const entry of toUpload) {
      flushSync(() => {
        setTransferLabel(`↑ ${entry.name}${entry.is_dir ? "/" : ""}`);
        setProgress({ transferred: 0, total: entry.size });
      });
      try {
        await uploadEntryRecursive(sessionIdRef.current!, entry, remotePath);
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
    const toDownload = remoteFlatRowsRef.current.filter(
      (e) => remoteSelected.has(e.path),
    );
    if (toDownload.length === 0) return;

    setTransferring(true);
    for (const entry of toDownload) {
      flushSync(() => {
        setTransferLabel(`↓ ${entry.name}${entry.is_dir ? "/" : ""}`);
        setProgress({ transferred: 0, total: entry.size });
      });
      try {
        await downloadEntryRecursive(sessionIdRef.current!, entry, localPath);
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
    const p = remotePath === "/" ? `/${name}` : `${remotePath}/${name}`;
    try {
      await sftpMkdir(sessionIdRef.current, p);
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
    const p = localPath.endsWith("/") ? `${localPath}${name}` : `${localPath}/${name}`;
    try {
      await localMkdir(p);
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

  // ── Drag-and-drop handlers ──────────────────────────────────────────────────

  const handleRowDragStart = (side: "local" | "remote", _entry: AnyEntry, files: AnyEntry[]) => {
    dragSrcRef.current = { side, entries: files };
  };

  const handlePanelDragOver = (_e: React.DragEvent, side: "local" | "remote") => {
    if (!dragSrcRef.current || dragSrcRef.current.side === side) return;
    setDragOverPanel(side);
    setDragOverFolder(null);
  };

  const handleFolderDragOver = (side: "local" | "remote", folderPath: string) => {
    if (!dragSrcRef.current || dragSrcRef.current.side === side) return;
    setDragOverPanel(side);
    setDragOverFolder(folderPath);
  };

  const handleDragLeave = (side: "local" | "remote") => {
    if (dragOverPanel === side) {
      setDragOverPanel(null);
      setDragOverFolder(null);
    }
  };

  const handleDropOnPanel = async (targetSide: "local" | "remote", targetFolder: string | null) => {
    const src = dragSrcRef.current;
    setDragOverPanel(null);
    setDragOverFolder(null);
    dragSrcRef.current = null;
    if (!src || src.side === targetSide || src.entries.length === 0) return;
    if (!sessionIdRef.current) return;

    setTransferring(true);
    if (src.side === "local" && targetSide === "remote") {
      const destDir = targetFolder ?? remotePath;
      for (const entry of src.entries) {
        flushSync(() => {
          setTransferLabel(`↑ ${entry.name}${entry.is_dir ? "/" : ""}`);
          setProgress({ transferred: 0, total: entry.size });
        });
        try { await uploadEntryRecursive(sessionIdRef.current!, entry, destDir); }
        catch (err) { setRemoteError(String(err)); break; }
      }
      setTransferLabel(null);
      setTransferring(false);
      loadRemote(sessionIdRef.current!, targetFolder ?? remotePath);
    } else {
      const destDir = targetFolder ?? localPath;
      for (const entry of src.entries) {
        flushSync(() => {
          setTransferLabel(`↓ ${entry.name}${entry.is_dir ? "/" : ""}`);
          setProgress({ transferred: 0, total: entry.size });
        });
        try { await downloadEntryRecursive(sessionIdRef.current!, entry, destDir); }
        catch (err) { setLocalError(String(err)); break; }
      }
      setTransferLabel(null);
      setTransferring(false);
      loadLocal(targetFolder ?? localPath);
    }
  };

  // ── Cut handlers ────────────────────────────────────────────────────────────

  const handleCutLocal = () => {
    const entries = localFlatRowsRef.current.filter(e => localSelected.has(e.path));
    if (entries.length > 0) setClipboard({ entries, side: "local" });
  };

  const handleCutRemote = () => {
    const entries = remoteFlatRowsRef.current.filter(e => remoteSelected.has(e.path));
    if (entries.length > 0) setClipboard({ entries, side: "remote" });
  };

  // ── Local delete ────────────────────────────────────────────────────────────

  const handleLocalDelete = async () => {
    const targets = localFlatRowsRef.current.filter(e => localSelected.has(e.path));
    if (targets.length === 0 || !confirm(`¿Eliminar ${targets.length} elemento(s)?`)) return;
    for (const entry of targets) {
      try { await localDelete(entry.path, entry.is_dir); }
      catch (err) { setLocalError(String(err)); break; }
    }
    loadLocal(localPath);
  };

  // ── Paste handler ───────────────────────────────────────────────────────────

  const handlePaste = async (targetSide: "local" | "remote", targetFolder?: string) => {
    if (!clipboard || !sessionIdRef.current) return;
    const destDir = targetFolder ?? (targetSide === "remote" ? remotePath : localPath);
    setTransferring(true);
    if (clipboard.side === "local" && targetSide === "remote") {
      for (const entry of clipboard.entries) {
        flushSync(() => { setTransferLabel(`↑ ${entry.name}`); setProgress({ transferred: 0, total: entry.size }); });
        try { await uploadEntryRecursive(sessionIdRef.current!, entry, destDir); }
        catch (err) { setRemoteError(String(err)); break; }
      }
      // delete sources
      for (const entry of clipboard.entries) {
        try { await localDelete(entry.path, entry.is_dir); } catch { /* ignore */ }
      }
      loadRemote(sessionIdRef.current!, destDir);
      loadLocal(localPath);
    } else if (clipboard.side === "remote" && targetSide === "local") {
      for (const entry of clipboard.entries) {
        flushSync(() => { setTransferLabel(`↓ ${entry.name}`); setProgress({ transferred: 0, total: entry.size }); });
        try { await downloadEntryRecursive(sessionIdRef.current!, entry, destDir); }
        catch (err) { setLocalError(String(err)); break; }
      }
      // delete sources
      for (const entry of clipboard.entries) {
        try { await sftpDelete(sessionIdRef.current!, entry.path, entry.is_dir); } catch { /* ignore */ }
      }
      loadLocal(destDir);
      loadRemote(sessionIdRef.current!, remotePath);
    }
    setTransferLabel(null);
    setTransferring(false);
    setClipboard(null);
  };

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
              fetchDir={localFetchDir}
              onFlatRowsChange={(rows) => { localFlatRowsRef.current = rows; }}
              isDragOver={dragOverPanel === "local"}
              dragOverFolderPath={dragOverPanel === "local" ? dragOverFolder : null}
              onRowDragStart={(entry, sel) => handleRowDragStart("local", entry, sel)}
              onPanelDragOver={(e) => handlePanelDragOver(e, "local")}
              onFolderDragOver={(p) => handleFolderDragOver("local", p)}
              onDropOnPanel={(f) => handleDropOnPanel("local", f)}
              onDragLeave={() => handleDragLeave("local")}
              cutPaths={clipboard?.side === "local" ? new Set(clipboard.entries.map(e => e.path)) : undefined}
            />
          </div>
        </div>

        {/* Transfer column */}
        <div className="w-14 shrink-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-bg-elevated)] border-r border-[var(--color-border)]">
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
        <div
          ref={remotePanelRef}
          className={`flex-1 min-w-0 flex flex-col ${osDragOverRemote ? "ring-2 ring-inset ring-[var(--color-accent)]" : ""}`}
        >
          {newFolderMode === "remote" && (
            <div className="px-3 pt-2 pb-1 border-b border-[var(--color-border)] flex items-center gap-2 shrink-0">
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
          )}
          <div className="flex-1 min-h-0">
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
              fetchDir={remoteFetchDir}
              onFlatRowsChange={(rows) => { remoteFlatRowsRef.current = rows; }}
              isDragOver={dragOverPanel === "remote"}
              dragOverFolderPath={dragOverPanel === "remote" ? dragOverFolder : null}
              onRowDragStart={(entry, sel) => handleRowDragStart("remote", entry, sel)}
              onPanelDragOver={(e) => handlePanelDragOver(e, "remote")}
              onFolderDragOver={(p) => handleFolderDragOver("remote", p)}
              onDropOnPanel={(f) => handleDropOnPanel("remote", f)}
              onDragLeave={() => handleDragLeave("remote")}
              cutPaths={clipboard?.side === "remote" ? new Set(clipboard.entries.map(e => e.path)) : undefined}
            />
          </div>
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
                <CtxItem icon={<Scissors size={12} />} label="Cortar"
                  onClick={() => { handleCutRemote(); setCtxMenu(null); }} />
                <div className="my-0.5 border-t border-[var(--color-border)]" />
                <CtxItem icon={<Trash2 size={12} />} label="Eliminar" danger
                  onClick={() => { handleRemoteDelete(ctxMenu.entry as SftpEntry); setCtxMenu(null); }} />
              </>
            ) : (
              <>
                <CtxItem icon={<FolderPlus size={12} />} label="Nueva carpeta"
                  onClick={() => { setNewFolderMode("remote"); setNewFolderName(""); setCtxMenu(null); }} />
                {clipboard?.side === "local" && (
                  <CtxItem icon={<ClipboardPaste size={12} />} label="Pegar aquí"
                    onClick={() => { handlePaste("remote"); setCtxMenu(null); }} />
                )}
              </>
            )
          ) : (
            ctxMenu.entry ? (
              <>
                <CtxItem icon={<ArrowRight size={12} />} label="Subir al servidor"
                  onClick={() => {
                    if (ctxMenu.entry) setLocalSelected(new Set([ctxMenu.entry.path]));
                    handleUpload();
                    setCtxMenu(null);
                  }} />
                <CtxItem icon={<Scissors size={12} />} label="Cortar"
                  onClick={() => { handleCutLocal(); setCtxMenu(null); }} />
                <div className="my-0.5 border-t border-[var(--color-border)]" />
                <CtxItem icon={<Trash2 size={12} />} label="Eliminar" danger
                  onClick={() => { handleLocalDelete(); setCtxMenu(null); }} />
              </>
            ) : (
              <>
                <CtxItem icon={<FolderPlus size={12} />} label="Nueva carpeta"
                  onClick={() => { setNewFolderMode("local"); setNewFolderName(""); setCtxMenu(null); }} />
                {clipboard?.side === "remote" && (
                  <CtxItem icon={<ClipboardPaste size={12} />} label="Pegar aquí"
                    onClick={() => { handlePaste("local"); setCtxMenu(null); }} />
                )}
              </>
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
