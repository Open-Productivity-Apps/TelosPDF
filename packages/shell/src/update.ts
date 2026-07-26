// In-app update flow. The Tauri updater plugin downloads the signed update
// artifact from the latest GitHub release and installs it in place — no
// manual reinstall, ever. If the plugin can't service this install (dev
// builds, Linux deb/rpm) or the check fails, no update UI is shown at all.
import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// The Update instance is not serialisable — kept outside the store.
let pending: Update | null = null;

/**
 * How long a "you're on the latest version" answer suppresses another manual
 * check. Deliberately in memory only: relaunching the app clears it, which is
 * also the moment the boot flow checks again anyway.
 */
export const UP_TO_DATE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

interface UpdateState {
  /** Version string of the newer release, or null when up to date. */
  available: string | null;
  /** "ready" = downloaded + installed, waiting for a restart to apply. */
  phase: "idle" | "downloading" | "ready" | "restarting";
  /** Download progress 0–1 (0 until the size is known). */
  progress: number;
  /** A manual check is in flight (drives the About button's label). */
  checking: boolean;
  /** When a check last answered "up to date" (epoch ms) — starts the cooldown. */
  upToDateAt: number | null;
  /** Last manual check couldn't reach the updater (offline, dev build, deb/rpm). */
  checkFailed: boolean;
  /** User-initiated check from Settings → About. Honours the cooldown. */
  checkNow: () => Promise<void>;
  checkForUpdate: () => Promise<void>;
  /** Download + install without restarting; the boot flow retries this. */
  stageUpdate: (onProgress?: (frac: number) => void) => Promise<boolean>;
  installUpdate: () => Promise<void>;
}

export const useUpdate = create<UpdateState>()((set, get) => ({
  available: null,
  phase: "idle",
  progress: 0,
  checking: false,
  upToDateAt: null,
  checkFailed: false,
  checkNow: async () => {
    const { checking, upToDateAt } = get();
    if (checking) return;
    if (upToDateAt !== null && Date.now() - upToDateAt < UP_TO_DATE_COOLDOWN_MS) return;
    set({ checking: true, checkFailed: false });
    try {
      const u = await check();
      if (u) {
        pending = u;
        // A real update clears the cooldown — the user must be able to act.
        set({ available: u.version, upToDateAt: null });
      } else {
        set({ available: null, upToDateAt: Date.now() });
      }
    } catch {
      // Unlike the silent boot check, a click deserves an answer — but the
      // cooldown stays clear so retrying is immediate.
      set({ checkFailed: true });
    } finally {
      set({ checking: false });
    }
  },
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
