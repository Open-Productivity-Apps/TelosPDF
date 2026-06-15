// Workbench state. Everything the shell shows derives from here; commands
// (telos.ts) are the only thing that talks to the host.
import { create } from "zustand";
import { usePrefs } from "./prefs";
import { commands, type DocumentInfo, type SearchHitEntry } from "./telos";
import type { RedactRect } from "./components/RedactLayer";

export type RightPanelId = "comments" | "bookmarks" | "pages" | "signatures" | null;

/** A signature/stamp placed in Fill & Sign but not yet baked into the PDF.
 * Anchored at (x, y) in PDF points (bottom-left origin); movable and
 * undoable until Save commits it. */
export interface PendingPlacement {
  id: number;
  docId: number;
  page: number;
  x: number;
  y: number;
  kind: "signature" | "stamp";
  dataUrl?: string;
  text?: string;
  rgb?: [number, number, number];
}

/** Session log of committed signature/stamp placements (panel tracking). */
export interface PlacedRecord {
  docId: number;
  page: number;
  kind: "signature" | "stamp";
  label: string;
  time: number;
}

export interface CompareTab {
  id: number;
  nameA: string;
  nameB: string;
  pages: number;
}
export type FitMode = "custom" | "fit-width" | "fit-page" | "actual";

export interface OpenDoc {
  info: DocumentInfo;
  viewRotation: 0 | 90 | 180 | 270;
  currentPage: number;
  /** Per-page render revision — page URLs use this so a single-page edit
   * doesn't invalidate every page's cached render. */
  pageRevs: number[];
}

interface AppState {
  docs: OpenDoc[];
  activeId: number | null;
  leftOpen: boolean;
  /** Settings is a full-page view (no tabs, no right rail) when active. */
  settingsActive: boolean;
  /** Welcome tab, shown on launch until closed. */
  welcomeOpen: boolean;
  welcomeActive: boolean;
  /** Edit-PDF mode: page-object overlays + text editing on the active doc. */
  editMode: boolean;
  /** Organize-pages mode: the center becomes a page grid. */
  organizeMode: boolean;
  /** Fill & Sign mode: form-field overlays + signature placement. */
  fillMode: boolean;
  /** Redact mode: draw regions then flatten them to black. */
  redactMode: boolean;
  redactMarks: RedactRect[];
  /** Markup mode: draw shapes/ink/text-boxes onto the page. */
  markupMode: boolean;
  rightPanel: RightPanelId;
  fitMode: FitMode;
  zoom: number;
  /** Zoom actually applied by the viewer after fit computation (display). */
  effectiveZoom: number;
  /** Bumped to ask the viewer to scroll to a page. */
  scrollRequest: { page: number; nonce: number } | null;
  toast: string | null;
  /** Toast history captured for the notification bell. */
  notifications: { id: number; text: string; at: string }[];
  clearNotifications: () => void;
  /** Comment focused from an on-page marker (key: "num-gen"). */
  focusedComment: string | null;
  /** Currently selected comment in the panel (Delete key acts on it). */
  selectedComment: string | null;
  /** Path awaiting a password (unlock modal). */
  unlockRequest: string | null;
  /** Long operation in flight (loading overlay), e.g. "Opening…". */
  busy: string | null;
  /** Print jobs sent this session (newest first). */
  printJobs: { id: number; title: string; printer: string; copies: number; at: string }[];
  addPrintJob: (job: { title: string; printer: string; copies: number }) => void;
  /** Open visual-compare tabs. */
  compareTabs: CompareTab[];
  /** Active compare tab id when a compare tab is focused, else null. */
  activeCompare: number | null;
  startCompare: () => Promise<void>;
  closeCompare: (id: number) => Promise<void>;
  setActiveCompare: (id: number) => void;
  searchOpen: boolean;
  searchHits: SearchHitEntry[];
  searchCurrent: number;

  open: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  createNew: () => Promise<void>;
  createFromImages: () => Promise<void>;
  /** Pick 2+ PDFs, merge them, open the result. */
  combine: () => Promise<void>;
  /** Save to the existing file (Cmd+S); falls back to Save As if none. */
  save: () => Promise<void>;
  /** Save the active document to a user-chosen location. */
  saveAs: () => Promise<void>;
  /** Adopt a document opened by the OS (file association). */
  addOpened: (info: DocumentInfo) => void;
  close: (id: number) => Promise<void>;
  activateWelcome: () => void;
  openWelcome: () => void;
  closeWelcome: () => void;
  setEditMode: (on: boolean) => void;
  setOrganizeMode: (on: boolean) => void;
  setFillMode: (on: boolean) => void;
  setRedactMode: (on: boolean) => void;
  setMarkupMode: (on: boolean) => void;
  addRedactMark: (r: RedactRect) => void;
  removeRedactMark: (i: number) => void;
  clearRedactMarks: () => void;
  setActive: (id: number) => void;
  /** Refresh a document after a mutation. Pass `changedPage` for
   * page-scoped edits so only that page re-renders; pass `"none"` for
   * changes that don't alter any page pixels (e.g. comment annotations,
   * which draw as DOM markers) so nothing re-renders. */
  updateInfo: (info: DocumentInfo, changedPage?: number | "none") => void;
  setZoomValue: (zoom: number) => void;
  rotateView: (id: number) => void;
  setCurrentPage: (id: number, page: number) => void;
  toggleLeft: () => void;
  setLeftOpen: (open: boolean) => void;
  openSettings: () => void;
  closeSettings: () => void;
  setRightPanel: (panel: RightPanelId) => void;
  /** Translate-model download — global so it survives tab switches and is
   * visible from Settings AND the Translate dialog. */
  translateDlActive: boolean;
  translateDlProgress: { downloaded: number; total: number } | null;
  translateDlSpeed: number;
  /** Bumps when a download finishes — consumers re-query install status. */
  translateDlBump: number;
  startTranslateDl: () => void;
  pendingPlacements: PendingPlacement[];
  placedLog: PlacedRecord[];
  addPlacement: (p: Omit<PendingPlacement, "id">) => void;
  movePlacement: (id: number, x: number, y: number) => void;
  undoPlacement: () => void;
  clearPlacements: () => void;
  logPlaced: (records: PlacedRecord[]) => void;
  setFitMode: (mode: FitMode) => void;
  zoomBy: (dir: 1 | -1) => void;
  setEffectiveZoom: (zoom: number) => void;
  goToPage: (page: number) => void;
  showToast: (message: string) => void;
  focusComment: (key: string, page: number) => void;
  clearFocusedComment: () => void;
  setSelectedComment: (key: string | null) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  cancelUnlock: () => void;
  unlock: (password: string) => Promise<void>;
  openSearch: () => void;
  closeSearch: () => void;
  runSearch: (query: string, matchCase: boolean) => Promise<void>;
  stepSearch: (dir: 1 | -1) => void;
}

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useApp = create<AppState>((set, get) => ({
  docs: [],
  activeId: null,
  // Launch state follows the "Sidebar on launch" setting (default: the
  // collapsed icon rail); the in-session toggle is still remembered.
  leftOpen: usePrefs.getState().sidebarStart === "expanded",
  settingsActive: false,
  welcomeOpen: true,
  welcomeActive: true,
  editMode: false,
  organizeMode: false,
  fillMode: false,
  redactMode: false,
  markupMode: false,
  redactMarks: [],
  rightPanel: null,
  fitMode: "fit-width",
  zoom: 1,
  effectiveZoom: 1,
  scrollRequest: null,
  toast: null,
  notifications: [],
  focusedComment: null,
  selectedComment: null,
  unlockRequest: null,
  busy: null,
  compareTabs: [],
  activeCompare: null,
  printJobs: [],
  searchOpen: false,
  searchHits: [],
  searchCurrent: 0,

  open: async () => {
    let info;
    try {
      set({ busy: "Opening…" });
      info = await commands.openDocument();
    } catch (e) {
      set({ busy: null });
      const msg = String(e);
      if (msg.includes("PASSWORD_REQUIRED:")) {
        set({ unlockRequest: msg.split("PASSWORD_REQUIRED:")[1] });
        return;
      }
      throw e;
    } finally {
      set({ busy: null });
    }
    if (info) {
      usePrefs.getState().addRecent({ title: info.title, path: info.path });
      set((s) => ({
        docs: [...s.docs, { info, viewRotation: 0, currentPage: 0, pageRevs: new Array(info.pages).fill(info.rev) }],
        activeId: info.id,
        settingsActive: false,
        welcomeActive: false,
      }));
    }
  },

  openPath: async (path) => {
    let info;
    try {
      set({ busy: "Opening…" });
      info = await commands.openDocumentPath(path);
    } catch (e) {
      if (String(e).includes("PASSWORD_REQUIRED:")) {
        set({ unlockRequest: path });
        return;
      }
      throw e;
    } finally {
      set({ busy: null });
    }
    usePrefs.getState().addRecent({ title: info.title, path: info.path });
    set((s) => ({
      docs: [...s.docs, { info, viewRotation: 0, currentPage: 0, pageRevs: new Array(info.pages).fill(info.rev) }],
      activeId: info.id,
      settingsActive: false,
      welcomeActive: false,
    }));
  },

  createNew: async () => {
    const info = await commands.createDocument();
    set((s) => ({
      docs: [...s.docs, { info, viewRotation: 0, currentPage: 0, pageRevs: new Array(info.pages).fill(info.rev) }],
      activeId: info.id,
      settingsActive: false,
      welcomeActive: false,
    }));
  },

  createFromImages: async () => {
    const info = await commands.createDocumentFromImages();
    if (info) {
      set((s) => ({
        docs: [...s.docs, { info, viewRotation: 0, currentPage: 0, pageRevs: new Array(info.pages).fill(info.rev) }],
        activeId: info.id,
        settingsActive: false,
        welcomeActive: false,
      }));
    }
  },

  addOpened: (info) => {
    // Unlocked/extracted docs live in temp work files — not recents material.
    if (!info.path.includes("telospdf-work")) {
      usePrefs.getState().addRecent({ title: info.title, path: info.path });
    }
    set((s) => {
      // Same path already open → just focus it.
      const existing = s.docs.find((d) => d.info.path === info.path);
      if (existing) {
        return { activeId: existing.info.id, settingsActive: false, welcomeActive: false };
      }
      return {
        docs: [...s.docs, { info, viewRotation: 0, currentPage: 0, pageRevs: new Array(info.pages).fill(info.rev) }],
        activeId: info.id,
        settingsActive: false,
        welcomeActive: false,
      };
    });
  },

  save: async () => {
    const s = get();
    const active = s.docs.find((d) => d.info.id === s.activeId);
    if (!active) return;
    try {
      const info = await commands.saveDocument(active.info.id, active.info.title);
      if (info) {
        s.updateInfo(info);
        s.showToast("Saved");
      } else {
        s.showToast("Already saved");
      }
    } catch (e) {
      if (String(e).includes("NEEDS_SAVE_AS")) {
        await s.saveAs();
      } else {
        s.showToast(String(e));
      }
    }
  },

  saveAs: async () => {
    const s = get();
    const active = s.docs.find((d) => d.info.id === s.activeId);
    if (!active) return;
    const next = await commands.saveDocumentAs(active.info.id, active.info.title);
    if (next) {
      usePrefs.getState().addRecent({ title: next.title, path: next.path });
      s.updateInfo(next);
      s.showToast(`Saved to ${next.path}`);
    }
  },

  combine: async () => {
    set({ busy: "Combining…" });
    let info;
    try {
      info = await commands.combineDocuments();
    } finally {
      set({ busy: null });
    }
    if (info) {
      set((s) => ({
        docs: [...s.docs, { info, viewRotation: 0, currentPage: 0, pageRevs: new Array(info.pages).fill(info.rev) }],
        activeId: info.id,
        settingsActive: false,
        welcomeActive: false,
      }));
      get().showToast(`Combined into one PDF (${info.pages} pages).`);
    }
  },

  activateWelcome: () => set({ welcomeActive: true, settingsActive: false, activeCompare: null }),

  openWelcome: () =>
    set({ welcomeOpen: true, welcomeActive: true, settingsActive: false }),

  closeWelcome: () => set({ welcomeOpen: false, welcomeActive: false }),

  setEditMode: (on) =>
    set({
      editMode: on,
      organizeMode: on ? false : get().organizeMode,
      fillMode: on ? false : get().fillMode,
      markupMode: on ? false : get().markupMode,
    }),

  setOrganizeMode: (on) =>
    set({
      organizeMode: on,
      editMode: on ? false : get().editMode,
      fillMode: on ? false : get().fillMode,
      markupMode: on ? false : get().markupMode,
    }),

  setFillMode: (on) =>
    set({
      fillMode: on,
      editMode: on ? false : get().editMode,
      organizeMode: on ? false : get().organizeMode,
      redactMode: on ? false : get().redactMode,
      markupMode: on ? false : get().markupMode,
    }),

  setRedactMode: (on) =>
    set({
      redactMode: on,
      redactMarks: on ? get().redactMarks : [],
      editMode: on ? false : get().editMode,
      organizeMode: on ? false : get().organizeMode,
      fillMode: on ? false : get().fillMode,
      markupMode: on ? false : get().markupMode,
    }),

  setMarkupMode: (on) =>
    set({
      markupMode: on,
      editMode: on ? false : get().editMode,
      organizeMode: on ? false : get().organizeMode,
      fillMode: on ? false : get().fillMode,
      redactMode: on ? false : get().redactMode,
    }),

  addRedactMark: (r) => set((s) => ({ redactMarks: [...s.redactMarks, r] })),
  removeRedactMark: (i) => set((s) => ({ redactMarks: s.redactMarks.filter((_, k) => k !== i) })),
  clearRedactMarks: () => set({ redactMarks: [] }),

  close: async (id) => {
    await commands.closeDocument(id);
    set((s) => {
      const docs = s.docs.filter((d) => d.info.id !== id);
      const activeId =
        s.activeId === id ? (docs[docs.length - 1]?.info.id ?? null) : s.activeId;
      return { docs, activeId };
    });
  },

  setActive: (id) => set({ activeId: id, settingsActive: false, welcomeActive: false, activeCompare: null }),

  updateInfo: (info, changedPage) =>
    set((s) => ({
      docs: s.docs.map((d) => {
        if (d.info.id !== info.id) return d;
        let pageRevs: number[];
        if (changedPage === "none" && info.pages === d.info.pages) {
          // No page pixels changed (comment annotations render as DOM
          // markers): keep every cached page image — nothing re-renders.
          pageRevs = d.pageRevs;
        } else if (changedPage == null || typeof changedPage !== "number" || info.pages !== d.info.pages) {
          // Structural change (or unknown scope): everything re-renders.
          pageRevs = new Array(info.pages).fill(info.rev);
        } else {
          pageRevs = [...d.pageRevs];
          pageRevs[changedPage] = info.rev;
        }
        return {
          ...d,
          info,
          pageRevs,
          currentPage: Math.min(d.currentPage, Math.max(0, info.pages - 1)),
        };
      }),
    })),

  rotateView: (id) =>
    set((s) => ({
      docs: s.docs.map((d) =>
        d.info.id === id
          ? { ...d, viewRotation: (((d.viewRotation + 90) % 360) as OpenDoc["viewRotation"]) }
          : d,
      ),
    })),

  setCurrentPage: (id, page) =>
    set((s) => {
      const doc = s.docs.find((d) => d.info.id === id);
      // Bail out unless it actually changed — scrolling fires this
      // constantly and a no-op state swap re-renders the whole app.
      if (!doc || doc.currentPage === page) return s;
      return {
        docs: s.docs.map((d) => (d.info.id === id ? { ...d, currentPage: page } : d)),
      };
    }),

  toggleLeft: () =>
    set((s) => {
      const leftOpen = !s.leftOpen;
      usePrefs.getState().setSidebarCollapsed(!leftOpen);
      return { leftOpen };
    }),

  setLeftOpen: (open) => {
    usePrefs.getState().setSidebarCollapsed(!open);
    set({ leftOpen: open });
  },

  openSettings: () => set({ settingsActive: true }),

  closeSettings: () => set({ settingsActive: false }),

  setRightPanel: (panel) =>
    set((s) => ({ rightPanel: s.rightPanel === panel ? null : panel })),
  translateDlActive: false,
  translateDlProgress: null,
  translateDlSpeed: 0,
  translateDlBump: 0,
  startTranslateDl: () => {
    if (get().translateDlActive) return;
    set({ translateDlActive: true, translateDlProgress: null, translateDlSpeed: 0 });
    void commands
      .downloadTranslateModel()
      .then(() => get().showToast("Translation model installed."))
      .catch((e) => get().showToast(String(e)))
      .finally(() =>
        set((s) => ({ translateDlActive: false, translateDlBump: s.translateDlBump + 1 })),
      );
  },
  pendingPlacements: [],
  placedLog: [],
  addPlacement: (p) =>
    set((s) => ({
      pendingPlacements: [...s.pendingPlacements, { ...p, id: Date.now() + s.pendingPlacements.length }],
    })),
  movePlacement: (id, x, y) =>
    set((s) => ({
      pendingPlacements: s.pendingPlacements.map((p) => (p.id === id ? { ...p, x, y } : p)),
    })),
  undoPlacement: () =>
    set((s) => ({ pendingPlacements: s.pendingPlacements.slice(0, -1) })),
  clearPlacements: () => set({ pendingPlacements: [] }),
  logPlaced: (records) => set((s) => ({ placedLog: [...s.placedLog, ...records] })),

  setFitMode: (mode) => set({ fitMode: mode }),

  zoomBy: (dir) => {
    const current = get().fitMode === "custom" ? get().zoom : get().effectiveZoom;
    const next =
      dir === 1
        ? (ZOOM_STEPS.find((s) => s > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
        : ([...ZOOM_STEPS].reverse().find((s) => s < current - 0.001) ?? ZOOM_STEPS[0]);
    set({ fitMode: "custom", zoom: next });
  },

  setZoomValue: (zoom) =>
    set({ fitMode: "custom", zoom: Math.min(8, Math.max(0.1, zoom)) }),

  setEffectiveZoom: (zoom) => {
    if (Math.abs(zoom - get().effectiveZoom) > 0.001) {
      set({ effectiveZoom: zoom });
    }
  },

  goToPage: (page) =>
    set((s) => ({
      scrollRequest: { page, nonce: (s.scrollRequest?.nonce ?? 0) + 1 },
    })),

  focusComment: (key, page) => {
    set({ rightPanel: "comments", focusedComment: key, selectedComment: key });
    get().goToPage(page);
  },

  setSelectedComment: (key) => set({ selectedComment: key }),

  clearFocusedComment: () => set({ focusedComment: null }),

  cancelUnlock: () => set({ unlockRequest: null }),

  unlock: async (password) => {
    const path = get().unlockRequest;
    if (!path) return;
    set({ busy: "Unlocking…" });
    let info;
    try {
      info = await commands.unlockDocument(path, password);
    } finally {
      set({ busy: null });
    }
    // Remember the ORIGINAL protected file, not the temp work copy.
    usePrefs.getState().addRecent({ title: info.title, path });
    set({ unlockRequest: null });
    get().addOpened(info);
  },

  undo: async () => {
    const s = get();
    const active = s.docs.find((d) => d.info.id === s.activeId);
    if (!active) return;
    try {
      s.updateInfo(await commands.undo(active.info.id, active.info.title));
    } catch (e) {
      s.showToast(String(e));
    }
  },

  redo: async () => {
    const s = get();
    const active = s.docs.find((d) => d.info.id === s.activeId);
    if (!active) return;
    try {
      s.updateInfo(await commands.redo(active.info.id, active.info.title));
    } catch (e) {
      s.showToast(String(e));
    }
  },

  openSearch: () => set({ searchOpen: true }),

  closeSearch: () => set({ searchOpen: false, searchHits: [], searchCurrent: 0 }),

  runSearch: async (query, matchCase) => {
    const s = get();
    const active = s.docs.find((d) => d.info.id === s.activeId);
    if (!active || !query.trim()) {
      set({ searchHits: [], searchCurrent: 0 });
      return;
    }
    const hits = await commands.searchDocument(active.info.id, query, matchCase);
    set({ searchHits: hits, searchCurrent: 0 });
    if (hits.length > 0) get().goToPage(hits[0].pageIndex);
  },

  stepSearch: (dir) => {
    const { searchHits, searchCurrent } = get();
    if (searchHits.length === 0) return;
    const next = (searchCurrent + dir + searchHits.length) % searchHits.length;
    set({ searchCurrent: next });
    get().goToPage(searchHits[next].pageIndex);
  },

  startCompare: async () => {
    set({ busy: "Preparing comparison…" });
    let session;
    try {
      session = await commands.startCompare();
    } finally {
      set({ busy: null });
    }
    if (session) {
      set((s) => ({
        compareTabs: [...s.compareTabs, session!],
        activeCompare: session!.id,
        welcomeActive: false,
        settingsActive: false,
        activeId: null,
      }));
    }
  },

  closeCompare: async (id) => {
    await commands.closeCompare(id).catch(() => {});
    set((s) => {
      const compareTabs = s.compareTabs.filter((c) => c.id !== id);
      return {
        compareTabs,
        activeCompare: s.activeCompare === id ? null : s.activeCompare,
      };
    });
  },

  setActiveCompare: (id) =>
    set({ activeCompare: id, activeId: null, welcomeActive: false, settingsActive: false }),

  addPrintJob: (job) =>
    set((s) => ({
      printJobs: [
        { ...job, id: (s.printJobs[0]?.id ?? 0) + 1, at: new Date().toLocaleTimeString() },
        ...s.printJobs,
      ].slice(0, 50),
    })),

  showToast: (message) => {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 3000);
    set((s) => ({
      toast: message,
      notifications: [
        { id: (s.notifications[0]?.id ?? 0) + 1, text: message, at: new Date().toLocaleTimeString() },
        ...s.notifications,
      ].slice(0, 100),
    }));
  },

  clearNotifications: () => set({ notifications: [] }),
}));

export function useActiveDoc(): OpenDoc | null {
  return useApp((s) => s.docs.find((d) => d.info.id === s.activeId) ?? null);
}
