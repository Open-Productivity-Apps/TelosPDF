// Workbench composition: left rail (tools, collapse at bottom) · tools panel
// · tabbed viewer · right panel · right rail (nav panels + view controls) ·
// status bar.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import LeftSidebar from "./components/LeftSidebar";
import TabStrip from "./components/TabStrip";
import Viewer from "./components/Viewer";
import OrganizeView from "./components/OrganizeView";
import RightPanel from "./components/RightPanels";
import RightRail from "./components/RightRail";
import SettingsView from "./components/SettingsView";
import WelcomeView from "./components/WelcomeView";
import CompareView from "./components/CompareView";
import { commands, type DocumentInfo } from "./telos";
import { LinkConfirmHost } from "./components/LinkConfirm";
import { LocaleSwitchPrompt } from "./i18n/LocaleSwitchPrompt";
import { detectRegion, regionDefaults } from "./lib/regionFormat";
import { usePrefs } from "./prefs";
import { useActiveDoc, useApp } from "./store";
import { APP_BUILD, APP_VERSION } from "./version";

export default function App() {
  const doc = useActiveDoc();
  const settingsActive = useApp((s) => s.settingsActive);
  const welcomeVisible = useApp((s) => s.welcomeOpen && s.welcomeActive);
  const organizeVisible = useApp((s) => s.organizeMode);
  const activeCompare = useApp((s) => s.activeCompare);
  const compareTabs = useApp((s) => s.compareTabs);
  const toast = useApp((s) => s.toast);
  const busy = useApp((s) => s.busy);
  const showToast = useApp((s) => s.showToast);
  const reduceMotion = usePrefs((s) => s.reduceMotion);
  const theme = usePrefs((s) => s.theme);
  const oledDark = usePrefs((s) => s.oledDark);

  // Apply persisted preferences on launch (and live for reduce-motion).
  useEffect(() => {
    // Fit mode from settings; the left rail restores its last collapsed
    // state (persisted per toggle), which the store already initialised.
    useApp.getState().setFitMode(usePrefs.getState().defaultFit);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);

  // Global translate-model download progress → store (survives tab switches).
  useEffect(() => {
    let last: { bytes: number; at: number } | null = null;
    const un = listen<{ downloaded: number; total: number }>("translate-model-progress", (e) => {
      const now = performance.now();
      let speed = useApp.getState().translateDlSpeed;
      if (last && now > last.at) {
        const inst = ((e.payload.downloaded - last.bytes) / (now - last.at)) * 1000;
        if (inst >= 0) speed = speed === 0 ? inst : speed * 0.7 + inst * 0.3;
      }
      last = { bytes: e.payload.downloaded, at: now };
      useApp.setState({ translateDlProgress: e.payload, translateDlSpeed: speed });
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Region "Auto": re-seed the format defaults only when the detected region
  // actually changes, so manual overrides made while on Auto survive.
  useEffect(() => {
    const prefs = usePrefs.getState();
    if (prefs.appRegion.code) return;
    void detectRegion(false).then((code) => {
      if (!code) return;
      const p = usePrefs.getState();
      if (code !== p.regionAutoFrom) {
        p.setAppRegion({ ...regionDefaults(code), code: "" });
        p.setRegionAutoFrom(code);
      }
    });
  }, []);

  // Theme: resolve "system" against the OS setting (and track it live);
  // OLED pure-black only ever modifies the dark theme.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      if (resolved === "dark" && oledDark) {
        document.documentElement.dataset.oled = "true";
      } else {
        delete document.documentElement.dataset.oled;
      }
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, oledDark]);

  const [defaultPrompt, setDefaultPrompt] = useState(false);
  const unlockRequest = useApp((s) => s.unlockRequest);
  const cancelUnlock = useApp((s) => s.cancelUnlock);
  const [unlockPw, setUnlockPw] = useState("");
  const [unlockError, setUnlockError] = useState("");

  const tryUnlock = async () => {
    try {
      await useApp.getState().unlock(unlockPw);
      setUnlockPw("");
      setUnlockError("");
    } catch (e) {
      setUnlockError(String(e).includes("wrong password") ? "Wrong password — try again." : String(e));
    }
  };

  // Boot handshake: closes the splash, shows the window, adopts any files
  // the OS opened us with, and keeps listening for more (file association).
  useEffect(() => {
    const addOpened = useApp.getState().addOpened;
    let unlisten: (() => void) | undefined;
    void listen<DocumentInfo>("open-file", (e) => addOpened(e.payload)).then(
      (fn) => (unlisten = fn),
    );
    void commands
      .frontendReady()
      .then((pending) => {
        pending.forEach(addOpened);
        // Session restore: reopen last session's files (crash recovery),
        // unless the OS handed us files to open instead.
        const prefs = usePrefs.getState();
        if (pending.length === 0 && prefs.restoreSession) {
          for (const path of prefs.lastSession) {
            void useApp.getState().openPath(path).catch(() => {});
          }
        }
      })
      .catch(() => {});
    // First run: offer to become the default PDF app.
    if (!usePrefs.getState().defaultHandlerPrompted) {
      void commands
        .isDefaultPdfHandler()
        .then((isDefault) => {
          if (!isDefault) setDefaultPrompt(true);
        })
        .catch(() => {});
    }
    return () => unlisten?.();
  }, []);

  const answerDefaultPrompt = (makeDefault: boolean) => {
    setDefaultPrompt(false);
    usePrefs.getState().setDefaultHandlerPrompted();
    if (makeDefault) {
      void commands
        .setDefaultPdfHandler()
        .then(() => showToast("TelosPDF is now your default PDF app."))
        .catch((e) => showToast(String(e)));
    }
  };

  // Remember which real files are open (session restore).
  const docs = useApp((s) => s.docs);
  useEffect(() => {
    const paths = docs
      .map((d) => d.info.path)
      .filter((p) => !p.includes("telospdf-work"));
    const prev = usePrefs.getState().lastSession;
    if (paths.length !== prev.length || paths.some((p, i) => p !== prev[i])) {
      usePrefs.getState().setLastSession(paths);
    }
  }, [docs]);

  // Block right-click (inspect element) and reload shortcuts — the app
  // behaves like a native application.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (e.key === "Escape" && useApp.getState().settingsActive) {
        useApp.getState().closeSettings();
        return;
      }
      const inField = (e.target as HTMLElement)?.closest?.("input, textarea");
      // Cmd/Ctrl+A — select only the PDF's text (the rendered text layers),
      // never the app chrome. Falls through when typing in a field.
      if ((e.metaKey || e.ctrlKey) && key === "a" && !inField) {
        const pages = document.querySelector(".pages-wrap");
        if (pages) {
          e.preventDefault();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(pages);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        return;
      }
      // Cmd/Ctrl+F — find in document.
      if ((e.metaKey || e.ctrlKey) && key === "f") {
        e.preventDefault();
        const s = useApp.getState();
        if (s.activeId != null && !s.settingsActive) s.openSearch();
        return;
      }
      // Cmd/Ctrl+Z / +Shift+Z — undo/redo (not while typing).
      if ((e.metaKey || e.ctrlKey) && key === "z" && !inField) {
        e.preventDefault();
        const s = useApp.getState();
        void (e.shiftKey ? s.redo() : s.undo());
        return;
      }
      // Cmd/Ctrl+S — Save As (the original file is never overwritten).
      if ((e.metaKey || e.ctrlKey) && key === "s") {
        e.preventDefault();
        const s = useApp.getState();
        void s.save().catch((err) => s.showToast(String(err)));
        return;
      }
      const reload = ((e.metaKey || e.ctrlKey) && key === "r") || e.key === "F5";
      const devtools =
        ((e.metaKey || e.ctrlKey) && e.altKey && key === "i") ||
        ((e.ctrlKey && e.shiftKey && key === "i")) ||
        e.key === "F12";
      if (reload || devtools) e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const saveAs = async () => {
    try {
      await useApp.getState().saveAs();
    } catch (e) {
      showToast(String(e));
    }
  };

  return (
    <div className="workbench">
      <LeftSidebar />

      {settingsActive ? (
        // Settings is a full-page view: no tab strip, no right rail.
        <main className="main">
          <SettingsView />
        </main>
      ) : (
        <>
          <main className="main">
            <TabStrip />
            {welcomeVisible ? (
              <WelcomeView />
            ) : activeCompare != null ? (
              (() => {
                const t = compareTabs.find((c) => c.id === activeCompare);
                return t ? <CompareView tab={t} /> : <Viewer />;
              })()
            ) : organizeVisible && doc ? (
              <OrganizeView doc={doc} />
            ) : (
              <Viewer />
            )}
          </main>
          <RightPanel />
          <RightRail />
        </>
      )}

      <footer className="status-bar">
        {doc ? (
          doc.info.modified ? (
            <button className="status-item" onClick={() => void saveAs()}>
              ● Modified — Save As…
            </button>
          ) : (
            <span>✓ Opened</span>
          )
        ) : (
          <span>Ready</span>
        )}
        {doc && !doc.info.editable && <span title="lopdf could not parse this file">view-only</span>}
        <div className="spacer" />
        <span className="status-version">
          TelosPDF {APP_VERSION} (Build {APP_BUILD})
        </span>
      </footer>

      {toast && <div className="toast">{toast}</div>}

      {busy && (
        <div className="busy-overlay">
          <div className="busy-card">
            <span className="spinner" />
            {busy}
          </div>
        </div>
      )}

      {unlockRequest && (
        <div className="modal-overlay">
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Password required</h3>
            <p className="modal-body-text">
              This PDF is protected. Enter its password to unlock and open it.
            </p>
            <p className="modal-url">{unlockRequest}</p>
            <input
              autoFocus
              className="code-input"
              type="password"
              placeholder="Password"
              value={unlockPw}
              onChange={(e) => setUnlockPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void tryUnlock()}
            />
            {unlockError && <p className="modal-error">{unlockError}</p>}
            <div className="modal-actions">
              <button className="modal-primary" onClick={() => void tryUnlock()}>
                Unlock
              </button>
              <button
                className="modal-secondary"
                onClick={() => {
                  cancelUnlock();
                  setUnlockPw("");
                  setUnlockError("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {defaultPrompt && (
        <div className="modal-overlay" onClick={() => answerDefaultPrompt(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Open PDFs with TelosPDF?</h3>
            <p className="modal-body-text">
              Make TelosPDF the default app for .pdf files. Double-clicking a PDF anywhere will
              open it here. You can change this anytime in your system settings.
            </p>
            <div className="modal-actions">
              <button className="modal-primary" onClick={() => answerDefaultPrompt(true)}>
                Make default
              </button>
              <button className="modal-secondary" onClick={() => answerDefaultPrompt(false)}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
      <LinkConfirmHost />
      <LocaleSwitchPrompt />
      <TipHost />
    </div>
  );
}

/** Instant tooltip for icon-only controls: any element with `data-tip` gets a
 * fixed-position tip beside it (never clipped by rail overflow). */
function TipHost() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; side: "right" | "left" } | null>(
    null,
  );
  useEffect(() => {
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.("[data-tip]") as HTMLElement | null;
      const text = el?.dataset.tip;
      if (!el || !text) {
        setTip(null);
        return;
      }
      const r = el.getBoundingClientRect();
      const side = r.left < window.innerWidth / 2 ? "right" : "left";
      setTip({ text, x: side === "right" ? r.right + 8 : r.left - 8, y: r.top + r.height / 2, side });
    };
    document.addEventListener("mouseover", over);
    return () => document.removeEventListener("mouseover", over);
  }, []);
  if (!tip) return null;
  return (
    <div
      className="tip"
      style={
        tip.side === "right"
          ? { left: tip.x, top: tip.y }
          : { right: window.innerWidth - tip.x, top: tip.y }
      }
    >
      {tip.text}
    </div>
  );
}
