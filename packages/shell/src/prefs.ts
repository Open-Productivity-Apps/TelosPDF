// Persisted user preferences (localStorage). Runtime view state lives in
// store.ts; only durable choices belong here.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_REGION, type AppRegion } from "./lib/regionFormat";
import type { FitMode } from "./store";

export interface RecentFile {
  title: string;
  path: string;
}

export type ThemePref = "system" | "light" | "dark";

const MAX_RECENTS = 8;

interface PrefsState {
  defaultFit: FitMode;
  sidebarStart: "expanded" | "collapsed";
  reduceMotion: boolean;
  /** First-run "make TelosPDF the default PDF app?" prompt shown already. */
  defaultHandlerPrompted: boolean;
  /** Reopen last session's files on launch (crash recovery / pick up). */
  restoreSession: boolean;
  /** Paths open at the end of the previous session. */
  lastSession: string[];
  /** Drawn signature (PNG data URL), stored on this device only. */
  savedSignature: string | null;
  /** Google Cloud Translation API key (cloud translate opt-in, local only). */
  googleTranslateKey: string;
  /** Translate engine: offline model or the user's Google Cloud key. */
  translateEngine: "local" | "google";
  /** OCR engine: bundled Tesseract, or the downloadable Unlimited-OCR 3B. */
  ocrEngine: "tesseract" | "unlimited";
  /** Region & formats (ported from MyBI): code "" = follow the device. */
  appRegion: AppRegion;
  /** Last auto-detected region — formats re-seed only when it changes. */
  regionAutoFrom: string;
  /** Colour theme: follow the OS, or force light/dark. */
  theme: ThemePref;
  /** Pure-black dark surfaces (OLED); applies whenever dark is active. */
  oledDark: boolean;
  /** Remembered left-rail collapsed state (persists across restarts). */
  sidebarCollapsed: boolean;
  /** Remembered right-panel width in px. */
  rightPanelWidth: number;
  /** Your edit code, attached to comments you post so others can edit them. */
  myEditCode: string;
  /** Edit codes others gave you, tried when editing their comments. */
  knownEditCodes: string[];
  recents: RecentFile[];
  setDefaultFit: (fit: FitMode) => void;
  setSidebarStart: (mode: "expanded" | "collapsed") => void;
  setReduceMotion: (on: boolean) => void;
  setDefaultHandlerPrompted: () => void;
  setRestoreSession: (on: boolean) => void;
  setLastSession: (paths: string[]) => void;
  setSavedSignature: (dataUrl: string | null) => void;
  setGoogleTranslateKey: (key: string) => void;
  setTranslateEngine: (engine: "local" | "google") => void;
  setOcrEngine: (engine: "tesseract" | "unlimited") => void;
  setAppRegion: (p: Partial<AppRegion>) => void;
  setRegionAutoFrom: (code: string) => void;
  setTheme: (theme: ThemePref) => void;
  setOledDark: (on: boolean) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setRightPanelWidth: (w: number) => void;
  setMyEditCode: (c: string) => void;
  addKnownCode: (c: string) => void;
  removeKnownCode: (c: string) => void;
  addRecent: (file: RecentFile) => void;
  removeRecent: (path: string) => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      defaultFit: "fit-width",
      sidebarStart: "collapsed",
      reduceMotion: false,
      defaultHandlerPrompted: false,
      restoreSession: true,
      lastSession: [],
      savedSignature: null,
      googleTranslateKey: "",
      translateEngine: "local",
      ocrEngine: "tesseract",
      appRegion: DEFAULT_REGION,
      regionAutoFrom: "",
      theme: "system",
      oledDark: false,
      sidebarCollapsed: false,
      rightPanelWidth: 300,
      myEditCode: "",
      knownEditCodes: [],
      recents: [],
      setDefaultFit: (defaultFit) => set({ defaultFit }),
      setSidebarStart: (sidebarStart) => set({ sidebarStart }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
      setDefaultHandlerPrompted: () => set({ defaultHandlerPrompted: true }),
      setRestoreSession: (restoreSession) => set({ restoreSession }),
      setLastSession: (lastSession) => set({ lastSession }),
      setSavedSignature: (savedSignature) => set({ savedSignature }),
      setGoogleTranslateKey: (googleTranslateKey) => set({ googleTranslateKey }),
      setTranslateEngine: (translateEngine) => set({ translateEngine }),
      setOcrEngine: (ocrEngine) => set({ ocrEngine }),
      setAppRegion: (p) => set((s) => ({ appRegion: { ...s.appRegion, ...p } })),
      setRegionAutoFrom: (regionAutoFrom) => set({ regionAutoFrom }),
      setTheme: (theme) => set({ theme }),
      setOledDark: (oledDark) => set({ oledDark }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setRightPanelWidth: (rightPanelWidth) => set({ rightPanelWidth }),
      setMyEditCode: (myEditCode) => set({ myEditCode }),
      addKnownCode: (c) =>
        set((st) => ({
          knownEditCodes: st.knownEditCodes.includes(c)
            ? st.knownEditCodes
            : [...st.knownEditCodes, c],
        })),
      removeKnownCode: (c) =>
        set((st) => ({ knownEditCodes: st.knownEditCodes.filter((x) => x !== c) })),
      addRecent: (file) =>
        set((s) => ({
          recents: [file, ...s.recents.filter((r) => r.path !== file.path)].slice(
            0,
            MAX_RECENTS,
          ),
        })),
      removeRecent: (path) =>
        set((s) => ({ recents: s.recents.filter((r) => r.path !== path) })),
    }),
    { name: "telos-prefs" },
  ),
);
