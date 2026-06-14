import { useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  Plus, Minus, Search, FolderOpen, Folder, Terminal,
  Copy, Trash2, Plug, FolderPlus, Edit2, FolderInput as FolderInputIcon,
  ChevronRight, ChevronDown, Database, X, Bell, Globe,
} from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useI18nStore, useT } from "../../store/useI18nStore";
import { useNotifStore } from "../../store/useNotifStore";
import {
  getConnections, getFolders, deleteConnection, saveConnection,
  saveFolder, deleteFolder, getFolders as refetchFolders, reorderConnections, reorderFolders,
  moveFolderToGroup, getGroups, saveGroup, renameGroup, deleteGroup, copyPassword,
} from "../../lib/commands";
import { ContextMenu, useContextMenu } from "../ContextMenu";
import { PropertiesPanel } from "../PropertiesPanel";
import { ConnIconDisplay, DEFAULT_CONN_ICON } from "../../lib/connIcons";
import { iconColorClass } from "../../lib/folderColors";
import { TuxIcon, WindowsIcon, VncIcon, SftpIcon } from "../ConnectionIcons";
import type { Connection, Folder as FolderType, Group } from "../../types";

// Shared empty set so we don't allocate a new one each render.
const EMPTY_ID_SET = new Set<string>();

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
  // Individual selectors — the sidebar tree is large, so we must NOT re-render
  // it on unrelated store changes (hover hints, tab status, notifications…).
  const connections = useAppStore((s) => s.connections);
  const folders = useAppStore((s) => s.folders);
  const groups = useAppStore((s) => s.groups);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const selectedConnectionId = useAppStore((s) => s.selectedConnectionId);
  const setConnections = useAppStore((s) => s.setConnections);
  const setFolders = useAppStore((s) => s.setFolders);
  const setGroups = useAppStore((s) => s.setGroups);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const selectConnection = useAppStore((s) => s.selectConnection);
  const selectFolder = useAppStore((s) => s.selectFolder);
  const selectGroup = useAppStore((s) => s.selectGroup);
  const openTab = useAppStore((s) => s.openTab);
  const startNewConnection = useAppStore((s) => s.startNewConnection);
  const setSidebarHint = useAppStore((s) => s.setSidebarHint);
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
  const pDragRef = useRef<{ kind: "conn" | "folder"; connId: string; connName: string; startX: number; startY: number; active: boolean } | null>(null);
  const pDropRef = useRef<string | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);

  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderName, setRenameFolderName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Group expand state: default all expanded
  const [groupExpanded, setGroupExpanded] = useState<Record<string, boolean>>({});

  // Folder expand state — default COLLAPSED and persisted. This is what keeps
  // huge imported trees fluid: only the folders the user opens are mounted,
  // instead of rendering thousands of connections at once.
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("orbitalterm:expandedFolders");
      return new Set<string>(raw ? JSON.parse(raw) : []);
    } catch { return new Set<string>(); }
  });
  useEffect(() => {
    localStorage.setItem("orbitalterm:expandedFolders", JSON.stringify([...expandedFolders]));
  }, [expandedFolders]);
  const toggleFolderExpand = (id: string) =>
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const expandAllFolders = () => setExpandedFolders(new Set(folders.map((f) => f.id)));
  const collapseAllFolders = () => setExpandedFolders(new Set());

  // Group renaming
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameGroupName, setRenameGroupName] = useState("");
  const renameGroupInputRef = useRef<HTMLInputElement>(null);

  // New group creation
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const newGroupInputRef = useRef<HTMLInputElement>(null);

  // Quick-create context: tracks which folder/group the user last clicked,
  // so the toolbar buttons create inside the right place.
  const [quickCtxFolderId, setQuickCtxFolderId] = useState<string | null>(null);
  const [quickCtxGroupId, setQuickCtxGroupId] = useState<string>("");
  // Initialise groupId from the first group once groups load, and clear any
  // stale reference if the tracked group was deleted (e.g. last DB removed).
  useEffect(() => {
    const exists = groups.some((g) => g.id === quickCtxGroupId);
    if (!exists) setQuickCtxGroupId(groups[0]?.id ?? "");
  }, [groups, quickCtxGroupId]);

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

  // Fast folder lookup for walking ancestor chains.
  const folderById = useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders],
  );
  const connById = useMemo(
    () => new Map(connections.map((c) => [c.id, c])),
    [connections],
  );

  // Child indexes: folders-by-parent and connections-by-folder. Built ONCE per
  // data change so each FolderItem does an O(1) Map lookup instead of an O(n)
  // .filter() over every folder/connection. With a large imported tree (a
  // folder can have hundreds of direct children) the old per-node filters were
  // O(n²) on every render — the real cause of the laggy search box.
  const foldersByParent = useMemo(() => {
    const m = new Map<string | null, FolderType[]>();
    for (const f of folders) {
      const k = f.parent_id ?? null;
      const arr = m.get(k); if (arr) arr.push(f); else m.set(k, [f]);
    }
    return m;
  }, [folders]);
  const connsByFolder = useMemo(() => {
    const m = new Map<string | null, Connection[]>();
    for (const c of connections) {
      const k = c.folder_id ?? null;
      const arr = m.get(k); if (arr) arr.push(c); else m.set(k, [c]);
    }
    return m;
  }, [connections]);
  // Per-group connection count for the header badge (avoids an O(n) filter per
  // group on every render).
  const connsByGroupCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of connections) m.set(c.group_id, (m.get(c.group_id) ?? 0) + 1);
    return m;
  }, [connections]);

  // Search matches (empty when no query). Prefix match (starts-with), like
  // mRemoteNG: typing "ser" finds names/IPs that BEGIN with "ser", not
  // "pruebaser60". Connections match by name or host/IP; folders by name.
  // Connections come first, then matching folders.
  const searchMatches = useMemo<{ kind: "conn" | "folder"; id: string }[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const hits: { kind: "conn" | "folder"; id: string }[] = [];
    for (const c of connections) {
      if (
        c.name.toLowerCase().startsWith(q) ||
        c.host.toLowerCase().startsWith(q)
      ) hits.push({ kind: "conn", id: c.id });
    }
    for (const f of folders) {
      if (f.name.toLowerCase().startsWith(q)) hits.push({ kind: "folder", id: f.id });
    }
    return hits;
  }, [searchQuery, connections, folders]);

  // Auto-expand only the ancestor chain of the CURRENTLY focused match so the
  // tree stays light and reveals it in place. ↑/↓ moves the focus.
  const searchExpanded = useMemo(() => {
    const ids = new Set<string>();
    if (!searchQuery) return ids;
    const hit = searchMatches[searchFocusIdx];
    if (!hit) return ids;
    // Connections reveal via their folder; folders reveal via their parent.
    let fid = hit.kind === "conn"
      ? (connById.get(hit.id)?.folder_id ?? null)
      : (folderById.get(hit.id)?.parent_id ?? null);
    while (fid) {
      ids.add(fid);
      fid = folderById.get(fid)?.parent_id ?? null;
    }
    return ids;
  }, [searchQuery, searchMatches, searchFocusIdx, folderById, connById]);

  // Scroll the focused match into view. Runs in an EFFECT (after the ancestor
  // chain has expanded and committed to the DOM), so ↑/↓ visibly jumps to each
  // match. It deliberately does NOT change the global selection — that would
  // reload the heavy properties panel (and a password IPC) on every keystroke,
  // which is what made the box feel slow. Only the lightweight focus highlight
  // moves; Enter opens the match, a click selects it. Fires only when the query
  // or focus changes (the index is reset to 0 in the search box onChange), so a
  // manual click in the tree is never yanked back (mRemoteNG behaviour).
  useEffect(() => {
    if (!searchQuery) return;
    const hit = searchMatches[searchFocusIdx];
    if (!hit) return;
    const sel = hit.kind === "conn"
      ? `[data-conn-id="${hit.id}"]`
      : `[data-folder-id="${hit.id}"]`;
    document.querySelector(sel)?.scrollIntoView({ block: "nearest" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchFocusIdx, searchQuery]);

  const toggleGroupExpanded = (groupId: string) => {
    setGroupExpanded((prev) => ({ ...prev, [groupId]: !(prev[groupId] ?? true) }));
  };

  // During a search every group is treated as open so matches in any database
  // are reachable; otherwise honour the user's per-group toggle (default open).
  const isGroupExpanded = (groupId: string) =>
    searchQuery ? true : (groupExpanded[groupId] ?? true);

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
    const ok = await ask(t("deleteFolderConfirm").replace("{name}", folder.name), {
      title: t("delete"),
      kind: "warning",
    });
    if (!ok) return;
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
    const ok = await ask(t("deleteGroupConfirm").replace("{name}", group.name), {
      title: t("delete"),
      kind: "warning",
    });
    if (!ok) return;
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
  const dndState = useRef({ connections, folders, setConnections, setFolders });
  dndState.current = { connections, folders, setConnections, setFolders };

  // Arms a connection drag.
  const startPointerDrag = (conn: Connection, startX: number, startY: number) => {
    pDragRef.current = { kind: "conn", connId: conn.id, connName: conn.name, startX, startY, active: false };
    pDropRef.current = null;
  };

  // Arms a folder drag.
  const startFolderDrag = (folder: FolderType, startX: number, startY: number) => {
    pDragRef.current = { kind: "folder", connId: folder.id, connName: folder.name, startX, startY, active: false };
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
        // Skip the item being dragged as a drop target
        if (d.kind === "folder" && h.dataset.folderId === d.connId) continue;
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
      const { connections: conns, folders: folderList, setConnections: setConns, setFolders: setFols } = dndState.current;

      const finish = () => { setDragId(null); setDropTarget(null); setGhostPos(null); };

      if (!dt) { finish(); return; }

      // ── Folder drag ───────────────────────────────────────────────────────────
      if (d.kind === "folder") {
        const draggedFolder = folderList.find((f) => f.id === d.connId);
        if (!draggedFolder) { finish(); return; }

        // Cross-BD or "move to group root": drop on a group header
        if (dt.startsWith("group:")) {
          const targetGroupId = dt.slice(6);
          // moveFolderToGroup works for both cross-BD and same-BD (moves to root of that group)
          if (targetGroupId !== draggedFolder.group_id || draggedFolder.parent_id !== null) {
            await moveFolderToGroup(d.connId, targetGroupId).catch(console.error);
            setConns(await getConnections());
            setFols(await getFolders());
          }
          finish(); return;
        }

        const parentId = draggedFolder.parent_id;
        const groupId  = draggedFolder.group_id;

        // Build the unified sorted list of all sibling items (same parent scope)
        type ScopeItem = { kind: "conn" | "folder"; id: string; sort_order: number; name: string };
        const siblings: ScopeItem[] = [
          ...conns.filter((c) => c.folder_id === parentId && c.group_id === groupId)
            .map((c) => ({ kind: "conn" as const, id: c.id, sort_order: c.sort_order, name: c.name })),
          ...folderList.filter((f) => f.parent_id === parentId && f.group_id === groupId)
            .map((f) => ({ kind: "folder" as const, id: f.id, sort_order: f.sort_order, name: f.name })),
        ].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

        const withoutDragged = siblings.filter((i) => i.id !== d.connId);

        // Find insertion index based on the drop target
        let insertIdx = withoutDragged.length; // default: end
        if (dt.startsWith("folder:")) {
          const targetId = dt.slice(7);
          const idx = withoutDragged.findIndex((i) => i.id === targetId);
          if (idx >= 0) insertIdx = idx;
        } else if (!dt.startsWith("group:")) {
          const idx = withoutDragged.findIndex((i) => i.id === dt);
          if (idx >= 0) insertIdx = idx;
        }

        withoutDragged.splice(insertIdx, 0, { kind: "folder", id: d.connId, sort_order: 0, name: d.connName });

        const connUpdates = withoutDragged
          .filter((i) => i.kind === "conn")
          .map((i) => ({ id: i.id, sort_order: withoutDragged.indexOf(i) * 10, folder_id: parentId, group_id: groupId }));
        const folderUpdates = withoutDragged
          .filter((i) => i.kind === "folder")
          .map((i) => ({ id: i.id, sort_order: withoutDragged.indexOf(i) * 10, parent_id: parentId, group_id: groupId }));

        if (connUpdates.length > 0) await reorderConnections(connUpdates).catch(console.error);
        if (folderUpdates.length > 0) await reorderFolders(folderUpdates).catch(console.error);
        setConns(await getConnections());
        setFols(await getFolders());
        finish(); return;
      }

      // ── Connection drag ───────────────────────────────────────────────────────
      const dragged = conns.find((c) => c.id === d.connId);
      if (!dragged) { finish(); return; }

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
        // Drop onto another connection — reorder within the same unified scope
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
      { label: t("newConnectionMenu"), icon: <Plus size={12} />, action: () => startNewConnection(folder.id, folder.group_id, t("newConnectionMenu")) },
      { label: t("newSubfolder"), icon: <FolderPlus size={12} />, action: () => startCreateFolder(folder.id, folder.group_id) },
      { label: t("rename"), icon: <Edit2 size={12} />, action: () => startRenameFolder(folder) },
      { separator: true },
      { label: t("delete"), icon: <Trash2 size={12} />, action: () => removeFolder(folder), danger: true },
    ]);

  const groupMenu = (e: React.MouseEvent, group: Group) =>
    openMenu(e, [
      { label: t("newConnectionMenu"), icon: <Plus size={12} />, action: () => startNewConnection(null, group.id, t("newConnectionMenu")) },
      { label: t("newFolder"), icon: <FolderPlus size={12} />, action: () => startCreateFolder(null, group.id) },
      { label: t("rename"), icon: <Edit2 size={12} />, action: () => startRenameGroup(group) },
      { separator: true },
      { label: t("delete"), icon: <Trash2 size={12} />, action: () => removeGroup(group), danger: true },
    ]);

  const duplicate = async (conn: Connection) => {
    const created = await saveConnection({
      name: conn.name, type: conn.type, host: conn.host, port: conn.port,
      username: conn.username, auth_type: conn.auth_type, key_path: conn.key_path,
      folder_id: conn.folder_id, notes: conn.notes, description: conn.description,
      domain: conn.domain, group_id: conn.group_id,
      icon: conn.icon, url: conn.url ?? "", custom_hosts: conn.custom_hosts ?? "",
      tunnels: conn.tunnels ?? "",
    });
    await copyPassword(conn.id, created.id).catch(() => {});

    // Place the duplicate directly after the original in the same scope
    const freshConns = await getConnections();
    const siblings = freshConns
      .filter((c) => c.folder_id === conn.folder_id && c.group_id === conn.group_id)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    const origIdx = siblings.findIndex((c) => c.id === conn.id);
    const withoutNew = siblings.filter((c) => c.id !== created.id);
    const insertAt = origIdx >= 0 ? origIdx + 1 : withoutNew.length;
    withoutNew.splice(insertAt, 0, created);
    await reorderConnections(
      withoutNew.map((c, i) => ({ id: c.id, sort_order: i * 10, folder_id: conn.folder_id, group_id: conn.group_id })),
    ).catch(console.error);
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
      setSearchFocusIdx((i) => (i + 1) % searchMatches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSearchFocusIdx((i) => (i - 1 + searchMatches.length) % searchMatches.length);
    } else if (e.key === "Enter") {
      const hit = searchMatches[searchFocusIdx];
      if (hit?.kind === "conn") {
        const conn = connById.get(hit.id);
        if (conn) openTab(conn);
      } else if (hit?.kind === "folder") {
        selectFolder(hit.id);
      }
    }
  };

  // Only the FOCUSED match is highlighted — the user doesn't want every match
  // shaded. searchMatchIds is therefore empty (no "all matches" highlight); the
  // focused connection lights up via ConnItem and the focused folder via
  // FolderItem.
  const searchMatchIds = EMPTY_ID_SET;
  const focusedHit = searchQuery ? searchMatches[searchFocusIdx] : undefined;
  const searchFocusId = focusedHit?.kind === "conn" ? focusedHit.id : null;
  const searchFocusFolderId = focusedHit?.kind === "folder" ? focusedHit.id : null;

  // Folders the tree should render as open: the ones the user opened, plus the
  // ancestor chain of the focused search match (so it's revealed in place).
  const effectiveExpanded = searchQuery
    ? new Set<string>([...expandedFolders, ...searchExpanded])
    : expandedFolders;

  // Shared props passed down to every FolderItem / ConnItem
  const sharedProps = {
    foldersByParent,
    connsByFolder,
    openTab,
    expandedFolders: effectiveExpanded,
    onToggleFolder: toggleFolderExpand,
    onConnContextMenu: connMenu,
    onFolderContextMenu: folderMenu,
    selectedId: selectedConnectionId,
    onSelect: (id: string) => {
      selectConnection(id);
      const conn = connections.find((c) => c.id === id);
      if (conn) { setQuickCtxFolderId(conn.folder_id); setQuickCtxGroupId(conn.group_id); }
    },
    onFolderClick: (folder: FolderType) => {
      setQuickCtxFolderId(folder.id);
      setQuickCtxGroupId(folder.group_id);
      selectFolder(folder.id);
    },
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
    onFolderPointerDown: (folder: FolderType, x: number, y: number) => startFolderDrag(folder, x, y),
    searchMatchIds,
    searchFocusId,
    searchFocusFolderId,
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
      <div className="border-b border-[var(--color-border)] shrink-0">
        {/* Logo row — logo on left, utility icons on right */}
        <div className="flex items-center px-3 py-2 gap-1">
          <img
            src="/logo_icon.png"
            alt="OrbitalTerm"
            className="h-6 w-auto object-contain select-none"
            draggable={false}
          />
          <div className="ml-auto flex items-center gap-0.5">
            <button
              onClick={expandAllFolders}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
              title={t("expandAll")}
            >
              <Plus size={14} />
            </button>
            <button
              onClick={collapseAllFolders}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
              title={t("collapseAll")}
            >
              <Minus size={14} />
            </button>
            <span className="w-px h-4 bg-[var(--color-border)] mx-0.5" />
            <button
              onClick={() => startNewConnection(quickCtxFolderId, quickCtxGroupId || groups[0]?.id, t("newConnectionMenu"))}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
              title={t("newConnection")}
            >
              <Plug size={14} />
            </button>
            <button
              onClick={() => startCreateFolder(quickCtxFolderId, quickCtxGroupId || groups[0]?.id)}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
              title={t("newFolder")}
            >
              <FolderPlus size={14} />
            </button>
            <button
              onClick={() => setCreatingGroup(true)}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
              title={t("newGroup")}
            >
              <Database size={14} />
            </button>
          </div>
        </div>
        {/* Quick-create toolbar for specific connection types */}
        <div className="flex divide-x divide-[var(--color-border)] border-t border-[var(--color-border)]">
          {(
            [
              { type: "rdp",     Icon: WindowsIcon, label: t("welcomeNewRdp") },
              { type: "ssh",     Icon: TuxIcon,     label: t("welcomeNewSsh") },
              { type: "vnc",     Icon: VncIcon,     label: "VNC"              },
              { type: "sftp",    Icon: SftpIcon,    label: "SFTP"             },
              { type: "browser", Icon: Globe,        label: t("quickBrowser")  },
            ] as const
          ).map(({ type, Icon, label }) => (
            <button
              key={type}
              onClick={() => startNewConnection(quickCtxFolderId, quickCtxGroupId || groups[0]?.id, label, type)}
              className="flex-1 flex flex-col items-center justify-center py-1.5 gap-[3px] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors"
              title={label}
            >
              <span className="relative inline-flex items-center justify-center">
                <Icon size={13} />
                <span className="absolute -bottom-1 -right-1 w-[9px] h-[9px] rounded-full bg-[var(--color-accent)] text-white text-[6px] font-bold flex items-center justify-center leading-none">+</span>
              </span>
              <span className="text-[7.5px] leading-tight text-center font-medium">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Connection list — tree view; search reveals & jumps to the focused match */}
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
          const groupFolders = (foldersByParent.get(null) ?? []).filter((f) => f.group_id === group.id);
          const groupRootConns = (connsByFolder.get(null) ?? []).filter((c) => c.group_id === group.id);
          const groupConnCount = connsByGroupCount.get(group.id) ?? 0;
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
                  onClick={() => { toggleGroupExpanded(group.id); selectGroup(group.id); setSidebarHint(buildGroupHint(group, lang, connections)); setQuickCtxFolderId(null); setQuickCtxGroupId(group.id); }}
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
                  <Database size={13} className={`shrink-0 ${iconColorClass(group.color, "text-[var(--color-accent)]")}`} />
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
                      { kind: "folder"; item: FolderType; sortKey: number } | { kind: "conn"; item: Connection; sortKey: number }
                    > = [
                      ...groupRootConns.map((c) => ({ kind: "conn" as const, item: c, sortKey: c.sort_order })),
                      ...groupFolders.map((f) => ({ kind: "folder" as const, item: f, sortKey: f.sort_order })),
                    ].sort((a, b) => (a.sortKey - b.sortKey) || (a.item.name.localeCompare(b.item.name)));
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
                            onSelect={() => sharedProps.onSelect(conn.id)}
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
                      <button onClick={() => startNewConnection(null, group.id, t("newConnectionMenu"))}
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
            <Database size={20} className="mx-auto mb-2 opacity-30" />
            <p>{t("noDatabasesYet")}</p>
            <button onClick={() => setCreatingGroup(true)}
              className="mt-1 text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">
              {t("createFirstDatabase")}
            </button>
          </div>
        )}
      </div>

      {/* Search — sits between connection list and properties panel */}
      <div className="px-2 py-1.5 border-t border-[var(--color-border)] shrink-0">
        <div className="flex items-center gap-2 bg-[var(--color-bg-elevated)] rounded px-2 py-1">
          <Search size={12} className="text-[var(--color-text-muted)] shrink-0" />
          <input
            type="text"
            placeholder={t("searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setSearchFocusIdx(0); }}
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
  foldersByParent: Map<string | null, FolderType[]>;
  connsByFolder: Map<string | null, Connection[]>;
  openTab: (c: Connection) => void;
  expandedFolders: Set<string>;
  onToggleFolder: (id: string) => void;
  onConnContextMenu: (e: React.MouseEvent, c: Connection) => void;
  onFolderContextMenu: (e: React.MouseEvent, f: FolderType) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onFolderClick: (folder: FolderType) => void;
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
  onFolderPointerDown: (folder: FolderType, x: number, y: number) => void;
  searchMatchIds: Set<string>;
  searchFocusId: string | null;
  searchFocusFolderId: string | null;
}

// ── FolderItem (recursive) ────────────────────────────────────────────────────

function FolderItem({
  folder, continuations, isLast, ...shared
}: { folder: FolderType; continuations: boolean[]; isLast: boolean } & SharedProps) {
  const t = useT();
  const {
    foldersByParent, connsByFolder, openTab, expandedFolders, onToggleFolder,
    onConnContextMenu, onFolderContextMenu, selectedId, onSelect, onFolderClick,
    onConnHint, onFolderHint,
    renamingFolderId, renameFolderName, onRenameChange, onRenameConfirm, onRenameCancel, renameInputRef,
    creatingFolder, newFolderParentId, newFolderName,
    onSubfolderNameChange, onSubfolderConfirm, onSubfolderCancel, folderInputRef,
    dragId, dropTarget, onConnPointerDown, onFolderPointerDown,
    searchMatchIds, searchFocusId, searchFocusFolderId,
  } = shared;

  const expanded = expandedFolders.has(folder.id);
  const subfolders = foldersByParent.get(folder.id) ?? [];
  const myConns = connsByFolder.get(folder.id) ?? [];

  const isFolderDropTarget = dropTarget === `folder:${folder.id}`;
  const isSearchFocus = searchFocusFolderId === folder.id;
  const Icon = expanded ? FolderOpen : Folder;
  const folderColor = iconColorClass(folder.color);
  const isRenaming = renamingFolderId === folder.id;
  const creatingSubfolder = creatingFolder && newFolderParentId === folder.id;
  const childContinuations = [...continuations, !isLast];

  const childItems: Array<{ kind: "folder"; item: FolderType; sortKey: number } | { kind: "conn"; item: Connection; sortKey: number }> = [
    ...myConns.map((c) => ({ kind: "conn" as const, item: c, sortKey: c.sort_order })),
    ...subfolders.map((f) => ({ kind: "folder" as const, item: f, sortKey: f.sort_order })),
  ].sort((a, b) => (a.sortKey - b.sortKey) || a.item.name.localeCompare(b.item.name));

  return (
    <div>
      {isRenaming ? (
        <div className="flex items-center gap-1 py-0.5 pr-3">
          <TreePrefix continuations={continuations} isLast={isLast} />
          <Icon size={12} className={`${folderColor} shrink-0`} />
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
          onClick={() => { onToggleFolder(folder.id); onFolderHint(folder); onFolderClick(folder); }}
          onPointerDown={(e) => onFolderPointerDown(folder, e.clientX, e.clientY)}
          onContextMenu={(e) => onFolderContextMenu(e, folder)}
          className={[
            "flex items-center w-full py-0.5 pr-2 transition-colors text-left",
            isFolderDropTarget
              ? "bg-[var(--color-accent)]/20 text-amber-400"
              : isSearchFocus
                ? "bg-[var(--color-accent)]/25 text-[var(--color-text-primary)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]",
          ].join(" ")}
        >
          <TreePrefix continuations={continuations} isLast={isLast} />
          <Icon size={12} className={`${folderColor} shrink-0`} />
          <span className="text-[13px] truncate flex-1 ml-1 text-left font-medium">{folder.name}</span>
          {expanded
            ? <ChevronDown size={9} className="shrink-0 opacity-40 mr-0.5" />
            : <ChevronRight size={9} className="shrink-0 opacity-30 mr-0.5" />}
        </button>
      )}

      {expanded && (
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
