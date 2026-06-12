import { create } from "zustand";

export interface ImportProgress {
  name: string;
  done: number;
  total: number;
}

interface ImportStore {
  // Progress of an in-flight mRemoteNG import, or null when none is running.
  progress: ImportProgress | null;
  setProgress: (p: ImportProgress | null) => void;
}

export const useImportStore = create<ImportStore>((set) => ({
  progress: null,
  setProgress: (progress) => set({ progress }),
}));
