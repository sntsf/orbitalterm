import { create } from "zustand";

export type MasterDialogMode = "create" | "change" | "unlock" | "require";

interface DialogState {
  mode: MasterDialogMode;
  groupId: string;
  groupName: string;
  afterUnlock?: () => void;
}

interface MasterState {
  // Data-source ids unlocked during this app session. While a group is here,
  // the eye can reveal its connections' passwords without asking again.
  // Resets on app restart (in-memory only).
  unlocked: Record<string, boolean>;
  isUnlocked: (groupId: string) => boolean;
  markUnlocked: (groupId: string) => void;

  dialog: DialogState | null;
  openDialog: (d: DialogState) => void;
  closeDialog: () => void;
}

export const useMasterStore = create<MasterState>((set, get) => ({
  unlocked: {},
  isUnlocked: (groupId) => !!get().unlocked[groupId],
  markUnlocked: (groupId) => set((s) => ({ unlocked: { ...s.unlocked, [groupId]: true } })),

  dialog: null,
  openDialog: (d) => set({ dialog: d }),
  closeDialog: () => set({ dialog: null }),
}));
