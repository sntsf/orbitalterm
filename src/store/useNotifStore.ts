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
  expanded: boolean;
  add: (n: Omit<Notif, "id" | "ts">) => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
  show: () => void;
  hide: () => void;
}

export const useNotifStore = create<NotifStore>((set) => ({
  notifs: [],
  expanded: false,
  add: (n) =>
    set((s) => ({
      notifs: [
        { ...n, id: crypto.randomUUID(), ts: Date.now() },
        ...s.notifs,
      ].slice(0, 50),
      expanded: true,
    })),
  dismiss: (id) => set((s) => ({ notifs: s.notifs.filter((n) => n.id !== id) })),
  clearAll: () => set({ notifs: [], expanded: false }),
  show: () => set({ expanded: true }),
  hide: () => set({ expanded: false }),
}));

// Heights reserved at the bottom of the session area for the notification bar.
// WindowsEmbeddedViewer reads these to shrink the native RDP window and leave
// visible HTML space for the notification overlay.
export const NOTIF_H_COLLAPSED = 30; // minimized bell tab
export const NOTIF_H_EXPANDED  = 90; // full notification bar
