import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

export interface TransferJob {
  id: string;
  label: string;            // file name
  dir: "up" | "down";
  status: "queued" | "active" | "done" | "error";
  error?: string;
  transferred: number;
  total: number;
  run: () => Promise<void>; // performs the actual transfer
  onComplete?: () => void;  // e.g. refresh the listing
}

type NewJob = Omit<TransferJob, "id" | "status" | "transferred" | "total">;

interface TransferStore {
  jobs: TransferJob[];
  running: boolean;
  enqueue: (jobs: NewJob[]) => void;
  clearDone: () => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
}

// Progress events are global per protocol; since the queue runs ONE job at a
// time the active job is unambiguous. Registered once, lazily.
let progressWired = false;

export const useTransferStore = create<TransferStore>((set, get) => {
  const patch = (id: string, p: Partial<TransferJob>) =>
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) }));

  const wireProgress = async () => {
    if (progressWired) return;
    progressWired = true;
    const onProgress = (e: { payload: unknown }) => {
      const p = e.payload as { transferred?: number; total?: number };
      set((s) => ({
        jobs: s.jobs.map((j) =>
          j.status === "active"
            ? { ...j, transferred: p.transferred ?? j.transferred, total: p.total ?? j.total }
            : j,
        ),
      }));
    };
    for (const ev of [
      "sftp-upload-progress", "sftp-download-progress",
      "ftp-upload-progress", "ftp-download-progress",
    ]) {
      await listen(ev, onProgress);
    }
  };

  const drain = async () => {
    if (get().running) return;
    const next = get().jobs.find((j) => j.status === "queued");
    if (!next) return;
    set({ running: true });
    patch(next.id, { status: "active", transferred: 0, total: 0 });
    try {
      await next.run();
      patch(next.id, { status: "done" });
      next.onComplete?.();
    } catch (err) {
      patch(next.id, { status: "error", error: String(err) });
    } finally {
      set({ running: false });
      drain();
    }
  };

  return {
    jobs: [],
    running: false,
    enqueue: (newJobs) => {
      wireProgress();
      const jobs: TransferJob[] = newJobs.map((j) => ({
        ...j, id: crypto.randomUUID(), status: "queued", transferred: 0, total: 0,
      }));
      set((s) => ({ jobs: [...s.jobs, ...jobs] }));
      drain();
    },
    clearDone: () => set((s) => ({ jobs: s.jobs.filter((j) => j.status !== "done" && j.status !== "error") })),
    remove: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
    retry: (id) => {
      patch(id, { status: "queued", error: undefined, transferred: 0, total: 0 });
      drain();
    },
  };
});
