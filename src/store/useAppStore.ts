import { create } from "zustand";
import type { Connection, ConnectionStatus, Folder, Tab } from "../types";

interface AppStore {
  connections: Connection[];
  folders: Folder[];
  searchQuery: string;
  selectedConnectionId: string | null;

  tabs: Tab[];
  activeTabId: string | null;

  showConnectionForm: boolean;
  editingConnection: Connection | null;

  setConnections: (connections: Connection[]) => void;
  setFolders: (folders: Folder[]) => void;
  setSearchQuery: (q: string) => void;
  selectConnection: (id: string | null) => void;

  openTab: (connection: Connection) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setTabStatus: (tabId: string, status: ConnectionStatus) => void;
  setTabSessionId: (tabId: string, sessionId: string) => void;

  openConnectionForm: (connection?: Connection) => void;
  closeConnectionForm: () => void;

  toggleFolder: (folderId: string) => void;

  getConnectionById: (id: string) => Connection | undefined;
}

export const useAppStore = create<AppStore>((set, get) => ({
  connections: [],
  folders: [],
  searchQuery: "",
  selectedConnectionId: null,
  tabs: [],
  activeTabId: null,
  showConnectionForm: false,
  editingConnection: null,

  setConnections: (connections) => set({ connections }),
  setFolders: (folders) => set({ folders }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  selectConnection: (selectedConnectionId) => set({ selectedConnectionId }),

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

  setActiveTab: (activeTabId) => set({ activeTabId }),

  setTabStatus: (tabId, status) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, status } : t)),
    })),

  setTabSessionId: (tabId, sessionId) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, session_id: sessionId } : t)),
    })),

  openConnectionForm: (connection) =>
    set({ showConnectionForm: true, editingConnection: connection ?? null }),

  closeConnectionForm: () =>
    set({ showConnectionForm: false, editingConnection: null }),

  toggleFolder: (folderId) =>
    set((state) => ({
      folders: state.folders.map((f) =>
        f.id === folderId ? { ...f, expanded: !f.expanded } : f
      ),
    })),

  getConnectionById: (id) => get().connections.find((c) => c.id === id),
}));
