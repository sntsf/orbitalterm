import { create } from "zustand";
import type { Connection, ConnectionStatus, Folder, Group, Tab } from "../types";

interface AppStore {
  connections: Connection[];
  folders: Folder[];
  groups: Group[];
  searchQuery: string;
  selectedConnectionId: string | null;
  isCreatingNew: boolean;
  newConnectionFolderId: string | null;
  newConnectionGroupId: string | null;
  sidebarVisible: boolean;

  tabs: Tab[];
  activeTabId: string | null;

  /** True while any React menu/dropdown is open — RDP overlays hide themselves. */
  menusOpen: boolean;
  setMenusOpen: (v: boolean) => void;

  setConnections: (connections: Connection[]) => void;
  setFolders: (folders: Folder[]) => void;
  setGroups: (groups: Group[]) => void;
  setSearchQuery: (q: string) => void;
  selectConnection: (id: string | null) => void;
  setIsCreatingNew: (v: boolean) => void;
  startNewConnection: (folderId?: string | null, groupId?: string | null) => void;
  toggleSidebar: () => void;

  openTab: (connection: Connection) => void;
  openTabConnected: (connection: Connection, sessionId: string) => void;
  closeTab: (tabId: string) => void;
  reconnectTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setTabStatus: (tabId: string, status: ConnectionStatus) => void;
  setTabSessionId: (tabId: string, sessionId: string) => void;
  reorderTabs: (fromId: string, insertBeforeId: string | null) => void;

  sidebarHint: { title: string; body: string } | null;
  setSidebarHint: (h: { title: string; body: string } | null) => void;

  toggleFolder: (folderId: string) => void;
  expandFolder: (folderId: string) => void;
  getConnectionById: (id: string) => Connection | undefined;
}

export const useAppStore = create<AppStore>((set, get) => ({
  connections: [],
  folders: [],
  groups: [],
  searchQuery: "",
  selectedConnectionId: null,
  isCreatingNew: false,
  newConnectionFolderId: null,
  newConnectionGroupId: null,
  sidebarVisible: true,
  tabs: [],
  activeTabId: null,
  menusOpen: false,
  setMenusOpen: (menusOpen) => set({ menusOpen }),
  sidebarHint: null,
  setSidebarHint: (sidebarHint) => set({ sidebarHint }),

  setConnections: (connections) => set({ connections }),
  setFolders: (folders) => set({ folders }),
  setGroups: (groups) => set({ groups }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),

  selectConnection: (selectedConnectionId) =>
    set({ selectedConnectionId, isCreatingNew: false }),

  setIsCreatingNew: (isCreatingNew) => set({ isCreatingNew }),

  startNewConnection: (folderId = null, groupId = null) =>
    set({ isCreatingNew: true, selectedConnectionId: null, newConnectionFolderId: folderId, newConnectionGroupId: groupId }),

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),

  openTab: (connection) => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.connection_id === connection.id);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      connection_id: connection.id,
      connection_name: connection.name,
      connection_type: connection.type,
      status: "connecting",
      icon: connection.icon || undefined,
    };
    set({ tabs: [...tabs, tab], activeTabId: tab.id });
  },

  openTabConnected: (connection, sessionId) => {
    const { tabs } = get();
    const tab: Tab = {
      id: crypto.randomUUID(),
      connection_id: connection.id,
      connection_name: connection.name,
      connection_type: connection.type,
      status: "connected",
      icon: connection.icon || undefined,
      session_id: sessionId,
    };
    set({ tabs: [...tabs, tab], activeTabId: tab.id });
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get();
    const filtered = tabs.filter((t) => t.id !== tabId);
    let nextActive = activeTabId;
    if (activeTabId === tabId) {
      const idx = tabs.findIndex((t) => t.id === tabId);
      nextActive = filtered[Math.min(idx, filtered.length - 1)]?.id ?? null;
    }
    set({ tabs: filtered, activeTabId: nextActive });
  },

  reconnectTab: (tabId) => {
    const { tabs } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    // Replace with a new UUID — the key={tab.id} on the pane wrapper causes
    // React to unmount the old pane (cleanup/disconnect) and mount a fresh one.
    const newTab: Tab = { ...tab, id: crypto.randomUUID(), status: "connecting", session_id: undefined };
    set({ tabs: tabs.map((t) => (t.id === tabId ? newTab : t)), activeTabId: newTab.id });
  },

  setActiveTab: (activeTabId) => set({ activeTabId }),

  setTabStatus: (tabId, status) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, status } : t)),
    })),

  setTabSessionId: (tabId, sessionId) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, session_id: sessionId } : t)),
    })),

  toggleFolder: (folderId) =>
    set((state) => ({
      folders: state.folders.map((f) =>
        f.id === folderId ? { ...f, expanded: !f.expanded } : f
      ),
    })),

  expandFolder: (folderId) =>
    set((state) => ({
      folders: state.folders.map((f) =>
        f.id === folderId ? { ...f, expanded: true } : f
      ),
    })),

  reorderTabs: (fromId, insertBeforeId) =>
    set((state) => {
      const arr = [...state.tabs];
      const from = arr.findIndex((t) => t.id === fromId);
      if (from < 0) return {};
      const [tab] = arr.splice(from, 1);
      if (insertBeforeId === null) {
        arr.push(tab);
      } else {
        const to = arr.findIndex((t) => t.id === insertBeforeId);
        if (to < 0) { arr.push(tab); } else { arr.splice(to, 0, tab); }
      }
      return { tabs: arr };
    }),

  getConnectionById: (id) => get().connections.find((c) => c.id === id),
}));
