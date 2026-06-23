import { create } from "zustand";

export type MasterDialogMode = "create" | "change" | "unlock" | null;

interface MasterState {
  // Whether the master password has been entered during this app session.
  // While true, the eye button can reveal connection passwords without asking
  // again. Resets on app restart (in-memory only).
  unlocked: boolean;
  setUnlocked: (b: boolean) => void;

  dialogMode: MasterDialogMode;
  // Optional action to run once the unlock dialog succeeds (e.g. reveal a field).
  pendingAfterUnlock: (() => void) | null;

  openDialog: (mode: Exclude<MasterDialogMode, null>, afterUnlock?: () => void) => void;
  closeDialog: () => void;
}

export const useMasterStore = create<MasterState>((set) => ({
  unlocked: false,
  setUnlocked: (b) => set({ unlocked: b }),
  dialogMode: null,
  pendingAfterUnlock: null,
  openDialog: (mode, afterUnlock) =>
    set({ dialogMode: mode, pendingAfterUnlock: afterUnlock ?? null }),
  closeDialog: () => set({ dialogMode: null, pendingAfterUnlock: null }),
}));
