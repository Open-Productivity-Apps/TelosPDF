// In-app update flow. The Tauri updater plugin downloads the signed update
// artifact from the latest GitHub release and installs it in place — no
// manual reinstall, ever. If the plugin can't service this install (dev
// builds, Linux deb/rpm) or the check fails, no update UI is shown at all.
import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// The Update instance is not serialisable — kept outside the store.
let pending: Update | null = null;

interface UpdateState {
  /** Version string of the newer release, or null when up to date. */
  available: string | null;
  /** "ready" = downloaded + installed, waiting for a restart to apply. */
  phase: "idle" | "downloading" | "ready" | "restarting";
  /** Download progress 0–1 (0 until the size is known). */
  progress: number;
  checkForUpdate: () => Promise<void>;
  /** Download + install without restarting; the boot flow retries this. */
  stageUpdate: (onProgress?: (frac: number) => void) => Promise<boolean>;
  installUpdate: () => Promise<void>;
}

export const useUpdate = create<UpdateState>()((set, get) => ({
  available: null,
  phase: "idle",
  progress: 0,
  checkForUpdate: async () => {
    try {
      const u = await check();
      if (u) {
        pending = u;
        set({ available: u.version });
      }
    } catch {
      // No in-place update possible right now — stay quiet.
    }
  },
  stageUpdate: async (onProgress) => {
    if (get().phase !== "idle" || !pending) return get().phase === "ready";
    set({ phase: "downloading", progress: 0 });
    try {
      let total = 0;
      let got = 0;
      await pending.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          if (total > 0) {
            const frac = got / total;
            set({ progress: frac });
            onProgress?.(frac);
          }
        }
      });
      set({ phase: "ready", progress: 1 });
      return true;
    } catch {
      set({ phase: "idle", progress: 0 });
      return false;
    }
  },
  installUpdate: async () => {
    const { phase, stageUpdate } = get();
    if (phase === "ready") {
      set({ phase: "restarting" });
      await relaunch();
      return;
    }
    if (phase !== "idle" || !pending) return;
    if (await stageUpdate()) {
      set({ phase: "restarting" });
      await relaunch();
    }
  },
}));
