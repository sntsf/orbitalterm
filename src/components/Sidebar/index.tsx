import { useEffect, useRef, useState } from "react";
import {
  Plus, Search, FolderOpen, Folder, Terminal,
  Copy, Trash2, Plug, FolderPlus, Edit2, FolderInput as FolderInputIcon,
  ChevronRight, ChevronDown, Database, X, Bell,
} from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useI18nStore, useT } from "../../store/useI18nStore";
import { useNotifStore } from "../../store/useNotifStore";
import {
  getConnections, getFolders, deleteConnection, saveConnection,
  saveFolder, deleteFolder, getFolders as refetchFolders, reorderConnections,
  getGroups, saveGroup, renameGroup, deleteGroup, copyPassword,
} from "../../lib/commands";
import { ContextMenu, useContextMenu } from "../ContextMenu";
import { PropertiesPanel } from "../PropertiesPanel";
import { ConnIconDisplay, DEFAULT_CONN_ICON } from "../../lib/connIcons";
import type { Connection, Folder as FolderType, Group } from "../../types";

// ── Sidebar hint builders ──────────────────────────────────────────────────────

function buildConnHint(conn: Connection, lang: string) {
  const type = conn.type.toUpperCase();
  const L: Record<string, { title: string; user: string }> = {
    es: { title: "Conexión",     user: "Usuario" },
    fr: { title: "Connexion",    user: "Utilisateur" },
    ru: { title: "Подключение",  user: "Пользователь" },
    ja: { title: "接続",          user: "ユーザー" },
  };
  const l = L[lang] ?? { title: "Connection", user: "User" };
  return {
    title: `${l.title}: ${conn.name}`,
    body: `Type ${type} · ${conn.host}:${conn.port} · ${l.user}: ${conn.username}`,
  };
}

function buildFolderHint(folder: FolderType, lang: string, allConnections: Connection[]) {
  const count = allConnections.filter((c) => c.folder_id === folder.id).length;
  const makeBody: Record<string, () => string> = {
    es: () => `Contiene ${count} conexión${count !== 1 ? "es" : ""}. Haz doble clic para abrir.`,
    fr: () => `Contient ${count} connexion${count !== 1 ? "s" : ""}. Double-cliquez pour ouvrir.`,
    ru: () => `Содержит ${count} подключен${count === 1 ? "ие" : "ий"}. Дважды щёлкните для открытия.`,
    ja: () => `${count}件の接続。ダブルクリックして開く。`,
  };
  const titles: Record<string, string> = { es: "Carpeta", fr: "Dossier", ru: "Папка", ja: "フォルダ" };
  const body = (makeBody[lang] ?? (() => `Contains ${count} connection${count !== 1 ? "s" : ""}. Double-click to open.`))();
  return { title: `${titles[lang] ?? "Folder"}: ${folder.name}`, body };
}

function buildGroupHint(group: Group, lang: string, allConnections: Connection[]) {
  const count = allConnections.filter((c) => c.group_id === group.id).length;
  const makeBody: Record<string, () => string> = {
    es: () => `${count} conexión${count !== 1 ? "es" : ""} en esta fuente. Clic derecho para opciones.`,
    fr: () => `${count} connexion${count !== 1 ? "s" : ""} dans cette source. Clic droit pour les options.`,
    ru: () => `${count} подключен${count === 1 ? "ие" : "ий"} в этом источнике. ПКМ для параметров.`,
    ja: () => `このソースに${count}件の接続。右クリックでオプション。`,
  };
  const titles: Record<string, string> = { es: "Fuente de datos", fr: "Source de données", ru: "Источник данных", ja: "データソース" };
  const body = (makeBody[lang] ?? (() => `${count} connection${count !== 1 ? "s" : ""} in this source. Right-click for options.`))();
  return { title: `${titles[lang] ?? "Data source"}: ${group.name}`, body };
}

function buildSearchHint(lang: string) {
  const L: Record<string, { title: string; body: string }> = {
    es: { title: "Buscador de conexiones", body: "Escribe para filtrar por nombre o IP. Usa ↑↓ para navegar y Enter para abrir." },
    fr: { title: "Recherche de connexions", body: "Tapez pour filtrer par nom ou IP. Utilisez ↑↓ pour naviguer et Entrée pour ouvrir." },
    ru: { title: "Поиск подключений", body: "Введите для фильтрации по имени или IP. ↑↓ для навигации, Enter для открытия." },
    ja: { title: "接続の検索", body: "名前またはIPで絞り込む。↑↓で移動、Enterで開く。" },
  };
  return L[lang] ?? { title: "Connection search", body: "Type to filter by name or IP. Use ↑↓ to navigate and Enter to open." };
}

// ── Sidebar ────────────────────────────────────────────────────────────────────

export function Sidebar() {
  const {
    connections, folders, groups,
    setConnections, setFolders, setGroups, setSearchQuery, searchQuery,
    selectConnection, selectedConnectionId,
    openTab, toggleFolder, expandFolder, startNewConnection,
    setSidebarHint,
  } = useAppStore();
  const { lang } = useI18nStore();
  const t = useT();
  const { notifs, expanded, show, clearAll: clearAllNotifs } = useNotifStore();

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

  const sidebarDragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);
  const [newFolderGroupId, setNewFolderGroupId] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Pointer-based DnD refs (avoid stale closures in global listeners)
  const pDragRef = useRef<{ connId: string; connName: string; startX: number; startY: number; active: boolean } | null>(null);
  const pDropRef = useRef<string | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);

  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderName, setRenameFolderName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Group expand state: default all expanded
  const [groupExpanded, setGroupExpanded] = useState<Record<string, boolean>>({});

  // Group renaming
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameGroupName, setRenameGroupName] = useState("");
  const renameGroupInputRef = useRef<HTMLInputElement>(null);

  // New group creation
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const newGroupInputRef = useRef<HTMLInputElement>(null);

  // Search keyboard navigation
  const [searchFocusIdx, setSearchFocusIdx] = useState(0);

  useEffect(() => {
    getConnections().then(setConnections).catch(console.error);
    getFolders().then(setFolders).catch(console.error);
    getGroups().then(setGroups).catch(console.error);
  }, []);

  // Listen for layout reset event from Herramientas menu
  useEffect(() => {
    const handler = () => {
      setSidebarWidth(256);
      setPanelHeight(320);
    };
    window.addEventListener("orbitalterm:resetLayout", handler);
    return () => window.removeEventListener("orbitalterm:resetLayout", handler);
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

  useEffect(() => {
    if (renamingGroupId && renameGroupInputRef.current) {
      renameGroupInputRef.current.focus();
      renameGroupInputRef.current.select();
    }
  }, [renamingGroupId]);

  useEffect(() => {
    if (creatingGroup && newGroupInputRef.current) {
      newGroupInputRef.current.focus();
    }
  }, [creatingGroup]);

  // Search matches (empty when no query)
  const searchMatches = searchQuery
    ? connections.filter(
        (c) =>
          c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.host.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : [];

  // When query changes: expand ancestor folders of all matches + jump to first
  useEffect(() => {
    if (!searchQuery) return;
    setSearchFocusIdx(0);
    const toExpand = new Set<string>();
    for (const conn of searchMatches) {
      let fid = conn.folder_id;
      while (fid) {
        toExpand.add(fid);
        const f = folders.find((fo) => fo.id === fid);
        fid = f?.parent_id ?? null;
      }
    }
    toExpand.forEach((id) => expandFolder(id));
    if (searchMatches[0]) selectConnection(searchMatches[0].id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  // Scroll focused match into view whenever focus index changes
  useEffect(() => {
    if (!searchQuery || !searchMatches[searchFocusIdx]) return;
    const id = searchMatches[searchFocusIdx].id;
    document.querySelector(`[data-conn-id="${id}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [searchFocusIdx, searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleGroupExpanded = (groupId: string) => {
    setGroupExpanded((prev) => ({ ...prev, [groupId]: !(prev[groupId] ?? true) }));
  };

  const isGroupExpanded = (groupId: string) => groupExpanded[groupId] ?? true;

  const startCreateFolder = (parentId: string | null = null, groupId: string | null = null) => {
    setNewFolderName("");
    setNewFolderParentId(parentId);
    setNewFolderGroupId(groupId);
    setCreatingFolder(true);
  };

  const confirmCreateFolder = async () => {
    const name = newFolderName.trim();
    if (name) {
      try {
        await saveFolder(name, newFolderParentId, newFolderGroupId);
        setFolders(await refetchFolders());
      } catch (err) { console.error(err); }
    }
    setCreatingFolder(false);
    setNewFolderName("");
    setNewFolderParentId(null);
    setNewFolderGroupId(null);
  };

  const cancelCreateFolder = () => {
    setCreatingFolder(false);
    setNewFolderName("");
    setNewFolderParentId(null);
    setNewFolderGroupId(null);
  };

  const startRenameFolder = (folder: FolderType) => {
    setRenamingFolderId(folder.id);
    setRenameFolderName(folder.name);
  };

  const confirmRenameFolder = async () => { setRenamingFolderId(null); setRenameFolderName(""); };
  const cancelRenameFolder = () => { setRenamingFolderId(null); setRenameFolderName(""); };

  const removeFolder = async (folder: FolderType) => {
    try {
      await deleteFolder(folder.id);
      setFolders(await refetchFolders());
      setConnections(await getConnections());
    } catch (err) { console.error(err); }
  };

  // Group CRUD
  const startRenameGroup = (group: Group) => {
    setRenamingGroupId(group.id);
    setRenameGroupName(group.name);
  };

  const confirmRenameGroup = async () => {
    const name = renameGroupName.trim();
    if (name && renamingGroupId) {
      try {
        await renameGroup(renamingGroupId, name);
        setGroups(await getGroups());
      } catch (err) { console.error(err); }
    }
    setRenamingGroupId(null);
    setRenameGroupName("");
  };

  const cancelRenameGroup = () => {
    setRenamingGroupId(null);
    setRenameGroupName("");
  };

  const removeGroup = async (group: Group) => {
    if (groups.length <= 1) return; // cannot delete last group
    if (!confirm(t("deleteGroupConfirm"))) return;
    try {
      await deleteGroup(group.id);
      setGroups(await getGroups());
      setFolders(await refetchFolders());
      setConnections(await getConnections());
    } catch (err) { console.error(err); }
  };

  const confirmCreateGroup = async () => {
    const name = newGroupName.trim();
    if (name) {
      try {
        const newGroup = await saveGroup(name);
        setGroups(await getGroups());
        // Auto-expand new group
        setGroupExpanded((prev) => ({ ...prev, [newGroup.id]: true }));
      } catch (err) { console.error(err); }
    }
    setCreatingGroup(false);
    setNewGroupName("");
  };

  const cancelCreateGroup = () => {
    setCreatingGroup(false);
    setNewGroupName("");
  };


  const DRAG_THRESHOLD = 6;

  // Always-current snapshot of state needed inside the global pointer listeners.
  // useEffect with [] captures stale closures; reading from this ref is safe.
  const dndState = useRef({ connections, folders, setConnections });
  dndState.current = { connections, folders, setConnections };

  // Called when a ConnItem receives pointerdown — arms the pointer-based drag.
  const startPointerDrag = (conn: Connection, startX: number, startY: number) => {
    pDragRef.current = { connId: conn.id, connName: conn.name, startX, startY, active: false };
    pDropRef.current = null;
  };

  // Global listeners registered once — use refs so they always see current state.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = pDragRef.current;
      if (!d) return;

      if (!d.active) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
        d.active = true;
        setDragId(d.connId);
      }

      setGhostPos({ x: e.clientX, y: e.clientY });

      const hits = document.elementsFromPoint(e.clientX, e.clientY);
      let target: string | null = null;
      for (const el of hits) {
        const h = el as HTMLElement;
        if (h.dataset.folderId) { target = `folder:${h.dataset.folderId}`; break; }
        if (h.dataset.groupId)  { target = `group:${h.dataset.groupId}`;   break; }
        if (h.dataset.connId && h.dataset.connId !== d.connId) { target = h.dataset.connId; break; }
      }
      pDropRef.current = target;
      setDropTarget(target);
    };

    const onUp = async () => {
      const d  = pDragRef.current;
      const dt = pDropRef.current;
      pDragRef.current = null;
      pDropRef.current = null;

      if (!d?.active) return; // never moved past threshold — normal click, nothing to do

      // Read CURRENT state from ref (avoids stale-closure bugs with [] dependency).
      const { connections: conns, folders: folderList, setConnections: setConns } = dndState.current;

      const dragged = conns.find((c) => c.id === d.connId);

      const finish = () => { setDragId(null); setDropTarget(null); setGhostPos(null); };

      if (!dragged || !dt) { finish(); return; }

      if (dt.startsWith("folder:") || dt.startsWith("group:")) {
        const folderId = dt.startsWith("folder:") ? dt.slice(7) : null;
        const groupId  = dt.startsWith("group:")  ? dt.slice(6)  : undefined;

        let targetGroupId: string;
        if (folderId) {
          const folder = folderList.find((f) => f.id === folderId);
          targetGroupId = folder?.group_id ?? dragged.group_id;
        } else {
          targetGroupId = groupId ?? dragged.group_id;
        }

        if (dragged.folder_id === folderId && dragged.group_id === targetGroupId) {
          finish(); return;
        }

        const maxSort = conns
          .filter((c) => c.folder_id === folderId && c.group_id === targetGroupId)
          .reduce((m, c) => Math.max(m, c.sort_order), -10) + 10;

        await reorderConnections([{ id: d.connId, sort_order: maxSort, folder_id: folderId, group_id: targetGroupId }]).catch(console.error);
        setConns(await getConnections());
      } else {
        // Drop onto another connection — reorder within the same folder
        const target = conns.find((c) => c.id === dt);
        if (!target) { finish(); return; }

        const targetGroupId = target.group_id;
        const level = conns
          .filter((c) => c.folder_id === target.folder_id && c.group_id === targetGroupId)
          .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
        const without = level.filter((c) => c.id !== d.connId);
        const idx = without.findIndex((c) => c.id === target.id);
        without.splice(idx, 0, { ...dragged, folder_id: target.folder_id, group_id: targetGroupId });
        const updates = without.map((c, i) => ({ id: c.id, sort_order: i * 10, folder_id: target.folder_id, group_id: targetGroupId }));
        await reorderConnections(updates).catch(console.error);
        setConns(await getConnections());
      }

      finish();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup",   onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup",   onUp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const folderMenu = (e: React.MouseEvent, folder: FolderType) =>
    openMenu(e, [
      { label: t("newConnectionMenu"), icon: <Plus size={12} />, action: () => startNewConnection(folder.id, folder.group_id) },
      { label: t("newSubfolder"), icon: <FolderPlus size={12} />, action: () => startCreateFolder(folder.id, folder.group_id) },
      { label: t("rename"), icon: <Edit2 size={12} />, action: () => startRenameFolder(folder) },
      { separator: true },
      { label: t("delete"), icon: <Trash2 size={12} />, action: () => removeFolder(folder), danger: true },
    ]);

  const groupMenu = (e: React.MouseEvent, group: Group) =>
    openMenu(e, [
      { label: t("newConnectionMenu"), icon: <Plus size={12} />, action: () => startNewConnection(null, group.id) },
      { label: t("newFolder"), icon: <FolderPlus size={12} />, action: () => startCreateFolder(null, group.id) },
      { label: t("rename"), icon: <Edit2 size={12} />, action: () => startRenameGroup(group) },
      { separator: true },
      { label: t("delete"), icon: <Trash2 size={12} />, action: () => removeGroup(group), danger: true, disabled: groups.length <= 1 },
    ]);

  const duplicate = async (conn: Connection) => {
    const created = await saveConnection({
      name: `${conn.name}(duplicado)`, type: conn.type, host: conn.host, port: conn.port,
      username: conn.username, auth_type: conn.auth_type, key_path: conn.key_path,
      folder_id: conn.folder_id, notes: conn.notes, description: conn.description,
      domain: conn.domain, group_id: conn.group_id,
      icon: conn.icon, url: conn.url ?? "", custom_hosts: conn.custom_hosts ?? "",
    });
    await copyPassword(conn.id, created.id).catch(() => {});
    setConnections(await getConnections());
  };

  const remove = async (conn: Connection) => {
    await deleteConnection(conn.id);
    setConnections(await getConnections());
    selectConnection(null);
  };

  const connMenu = (e: React.MouseEvent, conn: Connection) =>
    openMenu(e, [
      { label: t("connect"), icon: <Plug size={12} />, action: () => openTab(conn) },
      { label: t("duplicate"), icon: <Copy size={12} />, action: () => duplicate(conn) },
      { separator: true },
      { label: t("delete"), icon: <Trash2 size={12} />, action: () => remove(conn), danger: true },
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

  // ── Search keyboard navigation ────────────────────────────────────────────────

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { setSearchQuery(""); return; }
    if (!searchQuery || searchMatches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = (searchFocusIdx + 1) % searchMatches.length;
      setSearchFocusIdx(next);
      selectConnection(searchMatches[next].id);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = (searchFocusIdx - 1 + searchMatches.length) % searchMatches.length;
      setSearchFocusIdx(prev);
      selectConnection(searchMatches[prev].id);
    } else if (e.key === "Enter") {
      const conn = searchMatches[searchFocusIdx];
      if (conn) openTab(conn);
    }
  };

  const searchMatchIds = new Set(searchMatches.map((c) => c.id));
  const searchFocusId = searchQuery && searchMatches[searchFocusIdx]
    ? searchMatches[searchFocusIdx].id
    : null;

  // Shared props passed down to every FolderItem / ConnItem
  const sharedProps = {
    allFolders: folders,
    allConnections: connections,
    openTab,
    toggleFolder,
    onConnContextMenu: connMenu,
    onFolderContextMenu: folderMenu,
    selectedId: selectedConnectionId,
    onSelect: selectConnection,
    onConnHint: (conn: Connection) => setSidebarHint(buildConnHint(conn, lang)),
    onFolderHint: (folder: FolderType) => setSidebarHint(buildFolderHint(folder, lang, connections)),
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
    onConnPointerDown: (conn: Connection, x: number, y: number) => startPointerDrag(conn, x, y),
    searchMatchIds,
    searchFocusId,
  };

  return (
    <>
    {/* Drag ghost — follows the pointer while dragging a connection */}
    {ghostPos && pDragRef.current && (
      <div
        className="fixed z-[9999] pointer-events-none px-2 py-0.5 rounded text-[12px] text-[var(--color-text-primary)] bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] shadow-xl opacity-90 max-w-[180px] truncate"
        style={{ left: ghostPos.x + 14, top: ghostPos.y - 10 }}
      >
        {pDragRef.current.connName}
      </div>
    )}
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
          <button onClick={() => startNewConnection()}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
            title={t("newConnection")}>
            <Plus size={14} />
          </button>
          <button onClick={() => startCreateFolder(null, groups[0]?.id ?? null)}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
            title={t("newFolder")}>
            <FolderPlus size={14} />
          </button>
          <button onClick={() => setCreatingGroup(true)}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
            title={t("newGroup")}>
            <Database size={14} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-2 py-1.5 border-b border-[var(--color-border)] shrink-0">
        <div className="flex items-center gap-2 bg-[var(--color-bg-elevated)] rounded px-2 py-1">
          <Search size={12} className="text-[var(--color-text-muted)] shrink-0" />
          <input
            type="text"
            placeholder={t("searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => setSidebarHint(buildSearchHint(lang))}
            onBlur={() => setSidebarHint(null)}
            className="bg-transparent outline-none text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] w-full text-xs"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery("")} className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
              <X size={11} />
            </button>
          )}
        </div>
        {searchQuery && (
          <div className="mt-1 text-[11px] text-[var(--color-text-muted)] flex items-center gap-1 px-0.5">
            {searchMatches.length === 0 ? (
              <span className="text-[var(--color-danger)]">{t("noResults")}</span>
            ) : (
              <>
                <span className="text-[var(--color-accent)]">{searchFocusIdx + 1}</span>
                <span className="opacity-50">/{searchMatches.length} · {t("navHint")}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Connection list — always tree view; search highlights matches in-place */}
      <div className="flex-1 overflow-y-auto min-h-0 py-0.5">
        {/* New group input */}
        {creatingGroup && (
          <div className="flex items-center gap-1 px-2 py-1">
            <Database size={12} className="text-[var(--color-accent)] shrink-0" />
            <input
              ref={newGroupInputRef}
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmCreateGroup();
                if (e.key === "Escape") cancelCreateGroup();
              }}
              onBlur={cancelCreateGroup}
              placeholder={t("groupNamePlaceholder")}
              className="flex-1 ml-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-1 py-0 text-[13px] text-[var(--color-text-primary)] outline-none"
            />
          </div>
        )}

        {/* Render each group */}
        {groups.map((group) => {
          const expanded = isGroupExpanded(group.id);
          const groupFolders = folders.filter((f) => f.parent_id === null && f.group_id === group.id);
          const groupRootConns = connections.filter((c) => !c.folder_id && c.group_id === group.id);
          const groupConnCount = connections.filter((c) => c.group_id === group.id).length;
          const isGroupDropTarget = dropTarget === `group:${group.id}`;
          const isRenaming = renamingGroupId === group.id;

          return (
            <div key={group.id}>
              {/* Group header */}
              {isRenaming ? (
                <div className="flex items-center gap-1 px-2 py-1">
                  <Database size={12} className="text-[var(--color-accent)] shrink-0" />
                  <input
                    ref={renameGroupInputRef}
                    type="text"
                    value={renameGroupName}
                    onChange={(e) => setRenameGroupName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmRenameGroup();
                      if (e.key === "Escape") cancelRenameGroup();
                    }}
                    onBlur={cancelRenameGroup}
                    className="flex-1 ml-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-1 py-0 text-[13px] text-[var(--color-text-primary)] outline-none"
                  />
                </div>
              ) : (
                <button
                  data-group-id={group.id}
                  onClick={() => { toggleGroupExpanded(group.id); setSidebarHint(buildGroupHint(group, lang, connections)); }}
                  onContextMenu={(e) => groupMenu(e, group)}
                  className={[
                    "flex items-center gap-1.5 w-full px-2 py-1 transition-colors",
                    isGroupDropTarget
                      ? "bg-[var(--color-accent)]/20 text-[var(--color-accent-hover)]"
                      : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]",
                  ].join(" ")}
                >
                  {expanded
                    ? <ChevronDown size={11} className="shrink-0" />
                    : <ChevronRight size={11} className="shrink-0" />}
                  <Database size={13} className="shrink-0 text-[var(--color-accent)]" />
                  <span className="text-[13px] font-medium flex-1 text-left text-[var(--color-text-primary)]">{group.name}</span>
                  <span className="text-[11px] text-[var(--color-text-muted)] opacity-60">{groupConnCount}</span>
                </button>
              )}

              {/* Group contents */}
              {expanded && (
                <div>
                  {/* Inline root folder creation for this group */}
                  {creatingFolder && newFolderParentId === null && newFolderGroupId === group.id && (
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
                        placeholder={t("folderNamePlaceholder")}
                        className="flex-1 ml-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-1 py-0 text-[13px] text-[var(--color-text-primary)] outline-none"
                      />
                    </div>
                  )}

                  {(() => {
                    const groupChildren: Array<
                      { kind: "folder"; item: FolderType } | { kind: "conn"; item: Connection }
                    > = [
                      ...groupFolders.map((f) => ({ kind: "folder" as const, item: f })),
                      ...groupRootConns.map((c) => ({ kind: "conn" as const, item: c })),
                    ];
                    return groupChildren.map((child, idx) => {
                      const childIsLast = idx === groupChildren.length - 1;
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
                            onHint={() => setSidebarHint(buildConnHint(conn, lang))}
                            dragging={dragId === conn.id}
                            isDropTarget={dropTarget === conn.id}
                            onPointerDragStart={(x, y) => startPointerDrag(conn, x, y)}
                            isSearchMatch={searchMatchIds.has(conn.id)}
                            isSearchFocus={searchFocusId === conn.id}
                          />
                        );
                      }
                    });
                  })()}

                  {groupConnCount === 0 && (
                    <div className="px-4 py-3 text-center text-[var(--color-text-muted)] text-xs">
                      <Terminal size={16} className="mx-auto mb-1 opacity-30" />
                      <button onClick={() => startNewConnection(null, group.id)}
                        className="text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] text-[12px]">
                        {t("addFirst")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {groups.length === 0 && (
          <div className="px-4 py-6 text-center text-[var(--color-text-muted)] text-xs">
            <Terminal size={20} className="mx-auto mb-2 opacity-30" />
            <p>{t("noConnectionsYet")}</p>
            <button onClick={() => setCreatingGroup(true)}
              className="mt-1 text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">
              {t("addFirst")}
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
      <div className="border-t border-[var(--color-border)] shrink-0 overflow-y-auto" style={{ height: panelHeight }}>
        <PropertiesPanel />
      </div>

      {/* Notification badge — bottom of sidebar, always in HTML zone */}
      {notifs.length > 0 && !expanded && (
        <div className="flex items-center gap-1 px-2 py-1 border-t border-[var(--color-warning)]/30 shrink-0 bg-[var(--color-warning)]/8">
          <button
            onClick={show}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-[11px] font-medium text-[var(--color-warning)] hover:bg-[var(--color-warning)]/10 rounded px-1 py-0.5 transition-colors"
            title={t("notifLabel")}
          >
            <Bell size={11} className="shrink-0" />
            <span className="truncate">{t("notifLabel")}</span>
            <span className="ml-auto shrink-0 bg-[var(--color-warning)] text-black text-[9px] font-bold px-1.5 py-px rounded-full leading-none">
              {notifs.length}
            </span>
          </button>
          <button
            onClick={clearAllNotifs}
            className="shrink-0 p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 transition-colors"
            title={t("notifClearAll")}
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}

      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </aside>
    </>
  );
}

// ── Tree prefix ───────────────────────────────────────────────────────────────

function TreePrefix({ continuations, isLast }: { continuations: boolean[]; isLast: boolean }) {
  return (
    <span
      className="font-mono shrink-0 select-none text-[var(--color-border)]"
      style={{ fontSize: "12px", whiteSpace: "pre", lineHeight: 1 }}
    >
      {continuations.map((c) => (c ? "│   " : "    ")).join("")}{isLast ? "└──" : "├──"}{" "}
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
  onConnHint: (conn: Connection) => void;
  onFolderHint: (folder: FolderType) => void;
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
  onConnPointerDown: (conn: Connection, x: number, y: number) => void;
  searchMatchIds: Set<string>;
  searchFocusId: string | null;
}

// ── FolderItem (recursive) ────────────────────────────────────────────────────

function FolderItem({
  folder, continuations, isLast, ...shared
}: { folder: FolderType; continuations: boolean[]; isLast: boolean } & SharedProps) {
  const t = useT();
  const {
    allFolders, allConnections, openTab, toggleFolder,
    onConnContextMenu, onFolderContextMenu, selectedId, onSelect,
    onConnHint, onFolderHint,
    renamingFolderId, renameFolderName, onRenameChange, onRenameConfirm, onRenameCancel, renameInputRef,
    creatingFolder, newFolderParentId, newFolderName,
    onSubfolderNameChange, onSubfolderConfirm, onSubfolderCancel, folderInputRef,
    dragId, dropTarget, onConnPointerDown,
    searchMatchIds, searchFocusId,
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
            className="flex-1 ml-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-1 py-0 text-[13px] text-[var(--color-text-primary)] outline-none"
          />
        </div>
      ) : (
        <button
          data-folder-id={folder.id}
          onClick={() => { toggleFolder(folder.id); onFolderHint(folder); }}
          onContextMenu={(e) => onFolderContextMenu(e, folder)}
          className={[
            "flex items-center w-full py-0.5 pr-2 transition-colors text-left",
            isFolderDropTarget
              ? "bg-[var(--color-accent)]/20 text-amber-400"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]",
          ].join(" ")}
        >
          <TreePrefix continuations={continuations} isLast={isLast} />
          <Icon size={12} className="text-amber-400 shrink-0" />
          <span className="text-[13px] truncate flex-1 ml-1 text-left font-medium">{folder.name}</span>
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
                placeholder={t("folderNamePlaceholder")}
                className="flex-1 ml-1 bg-[var(--color-bg-elevated)] border border-[var(--color-accent)] rounded px-1 py-0 text-[13px] text-[var(--color-text-primary)] outline-none"
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
                  onHint={() => onConnHint(conn)}
                  dragging={dragId === conn.id}
                  isDropTarget={dropTarget === conn.id}
                  onPointerDragStart={(x, y) => onConnPointerDown(conn, x, y)}
                  isSearchMatch={searchMatchIds.has(conn.id)}
                  isSearchFocus={searchFocusId === conn.id}
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
  onHint,
  dragging = false, isDropTarget = false,
  onPointerDragStart,
  isSearchMatch = false, isSearchFocus = false,
}: {
  conn: Connection;
  continuations: boolean[];
  isLast: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onHint?: () => void;
  dragging?: boolean;
  isDropTarget?: boolean;
  onPointerDragStart?: (x: number, y: number) => void;
  isSearchMatch?: boolean;
  isSearchFocus?: boolean;
}) {
  const iconKey = conn.icon || DEFAULT_CONN_ICON[conn.type as keyof typeof DEFAULT_CONN_ICON] || "server";

  return (
    <div
      role="button"
      tabIndex={0}
      data-conn-id={conn.id}
      onClick={() => { onSelect(); onHint?.(); }}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { onSelect(); onHint?.(); } }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        onPointerDragStart?.(e.clientX, e.clientY);
      }}
      className={[
        "flex items-center w-full py-0.5 pr-2 transition-colors text-left cursor-pointer select-none",
        dragging ? "opacity-40" : "",
        isDropTarget ? "border-t-2 border-[var(--color-accent)]" : "",
        isSearchFocus || selected
          ? "bg-[var(--color-accent)]/20 text-[var(--color-accent-hover)]"
          : isSearchMatch
          ? "border-l-2 border-amber-400/70 bg-amber-400/5 text-[var(--color-text-primary)]"
          : "hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
      ].join(" ")}
    >
      <TreePrefix continuations={continuations} isLast={isLast} />
      <ConnIconDisplay iconKey={iconKey} size={16} />
      <span className="text-[13px] truncate flex-1 ml-1">{conn.name}</span>
      <span className={`text-[10px] uppercase font-semibold px-1 rounded shrink-0 ml-1 ${connTypeColors[conn.type] ?? "text-[var(--color-text-muted)] bg-[var(--color-bg-elevated)]"}`}>
        {conn.type}
      </span>
    </div>
  );
}
