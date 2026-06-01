import { create } from "zustand";

export interface Notif {
  id: string;
  ts: number;
  connName: string;
  connType: string;
  host: string;
  raw: string;
}

interface NotifStore {
  notifs: Notif[];
  add: (n: Omit<Notif, "id" | "ts">) => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
}

export const useNotifStore = create<NotifStore>((set) => ({
  notifs: [],
  add: (n) =>
    set((s) => ({
      notifs: [
        { ...n, id: crypto.randomUUID(), ts: Date.now() },
        ...s.notifs,
      ].slice(0, 50),
    })),
  dismiss: (id) => set((s) => ({ notifs: s.notifs.filter((n) => n.id !== id) })),
  clearAll: () => set({ notifs: [] }),
}));
