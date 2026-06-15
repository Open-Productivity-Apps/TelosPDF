// Left sidebar, MyBI-style: one panel that expands to icon+label rows and
// collapses to an icon-only rail. Tools that need an open document route
// through NeedDocModal (recents + Open/Create) instead of a dead-end toast.
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Archive,
  ArrowLeftRight,
  Home,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  EyeOff,
  FilePlus2,
  FileText,
  KeyRound,
  Languages,
  LayoutGrid,
  X,
  Lock,
  GitCompare,
  Highlighter,
  Merge,
  PenLine,
  Printer,
  ScanLine,
  Settings,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { t, useLocale } from "../i18n";
import { usePrefs } from "../prefs";
import { useApp, type OpenDoc } from "../store";
import CompressModal from "./CompressModal";
import NeedDocModal from "./NeedDocModal";
import PrintModal from "./PrintModal";
import ProtectModal from "./ProtectModal";
import ConverterModal from "./ConverterModal";
import { commands } from "../telos";
import { FlagIcon } from "../i18n/FlagIcon";
import { Select } from "./Select";

// Translate targets the model handles best; Latin script only (the output
// PDF uses the built-in Helvetica font). value = English name fed to the
// model; label = endonym, mirroring the language picker.
const TRANSLATE_TARGETS: { value: string; label: string; code: string }[] = [
  { value: "English", label: "English", code: "en-GB" },
  { value: "Spanish", label: "Español", code: "es" },
  { value: "French", label: "Français", code: "fr" },
  { value: "German", label: "Deutsch", code: "de" },
  { value: "Italian", label: "Italiano", code: "it" },
  { value: "Portuguese", label: "Português", code: "pt-PT" },
  { value: "Dutch", label: "Nederlands", code: "nl" },
  { value: "Indonesian", label: "Bahasa Indonesia", code: "id" },
  { value: "Swahili", label: "Kiswahili", code: "sw" },
];

interface Tool {
  id: string;
  label: string;
  icon: LucideIcon;
  phase?: string;
}

const TOOLS: Tool[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "create", label: "Create PDF", icon: FilePlus2 },
  { id: "convert", label: "PDF converter", icon: ArrowLeftRight },
  { id: "edit", label: "Edit PDF", icon: SquarePen },
  { id: "combine", label: "Combine PDF", icon: Merge },
  { id: "compare", label: "Compare files", icon: GitCompare },
  { id: "organize", label: "Organize pages", icon: LayoutGrid },
  { id: "fill-sign", label: "Fill & Sign", icon: PenLine },
  { id: "markup", label: "Markup", icon: Highlighter },
  { id: "print", label: "Print", icon: Printer },
  { id: "ocr", label: "Scan & OCR", icon: ScanLine },
  { id: "translate", label: "Translate PDF", icon: Languages },
  { id: "protect", label: "Protect PDF", icon: Lock },
  { id: "redact", label: "Redact PDF", icon: EyeOff },
  { id: "compress", label: "Compress PDF", icon: Archive },
  { id: "unlock", label: "Remove password", icon: KeyRound },
];

export default function LeftSidebar() {
  useLocale();
  const expanded = useApp((s) => s.leftOpen);
  const toggleLeft = useApp((s) => s.toggleLeft);
  const settingsActive = useApp((s) => s.settingsActive);
  const openSettings = useApp((s) => s.openSettings);
  const closeSettings = useApp((s) => s.closeSettings);
  const showToast = useApp((s) => s.showToast);
  const [converter, setConverter] = useState<"to" | "from" | null>(null);
  const [protecting, setProtecting] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [translateTarget, setTranslateTarget] = useState<OpenDoc | null>(null);
  const [translateLang, setTranslateLang] = useState("Spanish");
  const [translating, setTranslating] = useState(false);
  const [translateProgress, setTranslateProgress] = useState<{ page: number; pages: number } | null>(null);
  const [tmInstalled, setTmInstalled] = useState<boolean | null>(null);
  const tmDownloading = useApp((s) => s.translateDlActive);
  const tmProgress = useApp((s) => s.translateDlProgress);
  const tmSpeed = useApp((s) => s.translateDlSpeed);
  const tmBump = useApp((s) => s.translateDlBump);
  const translateEngine = usePrefs((s) => s.translateEngine);
  const setTranslateEngine = usePrefs((s) => s.setTranslateEngine);
  const googleKey = usePrefs((s) => s.googleTranslateKey);
  const setGoogleKey = usePrefs((s) => s.setGoogleTranslateKey);
  useEffect(() => {
    if (!translateTarget) return;
    setTmInstalled(null);
    void commands.translateModelStatus().then((st) => setTmInstalled(st.installed), () => setTmInstalled(false));
  }, [translateTarget, tmBump]);

  useEffect(() => {
    if (!translating) {
      setTranslateProgress(null);
      return;
    }
    const un = listen<{ page: number; pages: number }>("translate-progress", (e) =>
      setTranslateProgress(e.payload),
    );
    return () => {
      void un.then((f) => f());
    };
  }, [translating]);
  // A tool that needs a document but none is open: prompt, then run.
  const [needDoc, setNeedDoc] = useState<{ label: string; run: (id: number) => void } | null>(null);
  // Short windows: chevrons page the icon list (scrollbar itself is hidden).
  const toolsRef = useRef<HTMLDivElement>(null);
  const [toolsNav, setToolsNav] = useState({ up: false, down: false });
  useEffect(() => {
    const el = toolsRef.current;
    if (!el) return;
    // Chevrons appear only in the direction that actually has hidden icons.
    const check = () =>
      setToolsNav({
        up: el.scrollTop > 2,
        down: el.scrollTop + el.clientHeight < el.scrollHeight - 2,
      });
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener("scroll", check);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", check);
    };
  }, []);

  /** Run `action` with the active document, prompting to open one if none. */
  const withDoc = (label: string, action: (doc: OpenDoc) => void) => {
    const s = useApp.getState();
    const doc = s.docs.find((d) => d.info.id === s.activeId) ?? s.docs[0];
    if (doc) {
      s.setActive(doc.info.id);
      action(doc);
    } else {
      setNeedDoc({
        label,
        run: (id) => {
          const d = useApp.getState().docs.find((x) => x.info.id === id);
          if (d) action(d);
        },
      });
    }
  };

  const enterMode = (label: string, set: (on: boolean) => void) =>
    withDoc(label, (doc) => {
      if (!doc.info.editable) {
        showToast(t("This document opened view-only."));
        return;
      }
      useApp.getState().setActive(doc.info.id);
      set(true);
    });

  const run = (tool: Tool) => {
    const app = useApp.getState();
    switch (tool.id) {
      case "home":
        app.openWelcome();
        return;
      case "create":
        setConverter("to");
        return;
      case "convert":
        setConverter("from");
        return;
      case "combine":
        void app.combine().catch((e) => showToast(String(e)));
        return;
      case "compare":
        void app.startCompare().catch((e) => showToast(String(e)));
        return;
      case "edit":
        enterMode("Edit PDF", app.setEditMode);
        return;
      case "organize":
        enterMode("Organize pages", app.setOrganizeMode);
        return;
      case "fill-sign":
        enterMode("Fill & Sign", app.setFillMode);
        return;
      case "markup":
        enterMode("Markup", app.setMarkupMode);
        return;
      case "redact":
        enterMode("Redact PDF", app.setRedactMode);
        return;
      case "print":
        withDoc("Print", () => setPrinting(true));
        return;
      case "compress":
        withDoc("Compress PDF", () => setCompressing(true));
        return;
      case "protect":
        withDoc("Protect PDF", () => setProtecting(true));
        return;
      case "ocr":
        withDoc("Scan & OCR", (doc) => {
          const engine = usePrefs.getState().ocrEngine;
          void (async () => {
            if (engine === "unlimited") {
              const st = await commands.ocrModelStatus().catch(() => null);
              if (!st?.installed) {
                showToast(t("Download the Unlimited-OCR model first: Settings → OCR."));
                return;
              }
              showToast(t("Running Unlimited-OCR — this can take a little while per page…"));
            }
            try {
              const info = await commands.ocrDocument(doc.info.id, doc.info.title, engine);
              app.updateInfo(info);
              app.showToast(
                engine === "unlimited"
                  ? t("Unlimited-OCR complete — the document now has a searchable text layer.")
                  : t("OCR complete — the document now has a searchable text layer."),
              );
            } catch (e) {
              showToast(String(e));
            }
          })();
        });
        return;
      case "translate":
        withDoc("Translate PDF", (doc) => setTranslateTarget(doc));
        return;
      case "unlock":
        withDoc("Remove password", (doc) => {
          if (!doc.info.protected) {
            showToast(t("This document isn't password-protected."));
            return;
          }
          void commands
            .removePassword(doc.info.id, doc.info.title)
            .then((info) => {
              app.updateInfo(info);
              app.showToast(t("Password removed — Save As (Cmd+S) writes the unlocked file."));
            })
            .catch((e) => showToast(String(e)));
        });
        return;
      default:
        showToast(`${tool.label} ships in ${tool.phase} — see PLAN.md.`);
    }
  };

  const activeDoc = () => {
    const s = useApp.getState();
    return s.docs.find((d) => d.info.id === s.activeId) ?? s.docs[0] ?? null;
  };

  return (
    <aside className={`left-sidebar ${expanded ? "expanded" : "collapsed"}`}>
      <div className="brand-row" title="TelosPDF">
        <div className="brand-logo"><FileText size={15} strokeWidth={2.2} /></div>
        {expanded && <span className="brand-name">TelosPDF</span>}
      </div>
      {toolsNav.up && (
        <button className="rail-vnav" onClick={() => toolsRef.current?.scrollBy({ top: -140, behavior: "smooth" })}>
          <ChevronUp size={14} />
        </button>
      )}
      <div className="sidebar-tools" ref={toolsRef}>
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            className="sidebar-row"
            data-tip={expanded ? undefined : t(tool.label)}
            onClick={() => run(tool)}
          >
            <tool.icon size={20} strokeWidth={1.7} />
            {expanded && <span className="row-label">{t(tool.label)}</span>}
            {expanded && tool.phase && <span className="tool-phase">{tool.phase}</span>}
          </button>
        ))}
      </div>

      {toolsNav.down && (
        <button className="rail-vnav" onClick={() => toolsRef.current?.scrollBy({ top: 140, behavior: "smooth" })}>
          <ChevronDown size={14} />
        </button>
      )}
      <div className="sidebar-bottom">
        <button
          className="sidebar-row"
          data-tip={expanded ? undefined : t("Settings")}
          onClick={settingsActive ? closeSettings : openSettings}
        >
          <Settings size={20} strokeWidth={1.7} />
          {expanded && <span className="row-label">{t("Settings")}</span>}
        </button>
        <button className="sidebar-row" data-tip={expanded ? undefined : t("Expand")} onClick={toggleLeft}>
          {expanded ? (
            <ChevronLeft size={20} strokeWidth={1.7} />
          ) : (
            <ChevronRight size={20} strokeWidth={1.7} />
          )}
          {expanded && <span className="row-label">{t("Collapse")}</span>}
        </button>
      </div>

      {converter && (
        <ConverterModal initial={converter} onClose={() => setConverter(null)} />
      )}
      {translateTarget && (
        <div className="modal-overlay" onClick={() => !translating && setTranslateTarget(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>{t("Translate PDF")}</h3>
            <p className="settings-blurb">
              {t(
                "Experimental — translates the document's text and opens the result as a new text PDF. Latin-script languages only for now.",
              )}
            </p>
            <div className="segmented translate-engines">
              <button
                className={translateEngine === "local" ? "active" : ""}
                disabled={translating}
                onClick={() => setTranslateEngine("local")}
              >
                {t("Local model")}
              </button>
              <button
                className={translateEngine === "google" ? "active" : ""}
                disabled={translating}
                onClick={() => setTranslateEngine("google")}
              >
                {t("Google Cloud")}
              </button>
            </div>
            {translateEngine === "google" && (
              <>
                <p className="settings-blurb">
                  {t(
                    "Sends the document's text to Google using YOUR API key (stored only on this device). Light use fits Google's free tier.",
                  )}
                </p>
                <input
                  className="translate-lang translate-key"
                  type="password"
                  placeholder={t("Google Cloud Translation API key")}
                  value={googleKey}
                  disabled={translating}
                  onChange={(e) => setGoogleKey(e.target.value)}
                />
              </>
            )}
            {translateEngine === "local" && tmInstalled === false && (
              <>
                {tmDownloading ? (
                  <div className="dl-progress translate-progress">
                    <div className="dl-bar">
                      <div
                        className="dl-fill"
                        style={{
                          width: `${tmProgress ? Math.min(100, (tmProgress.downloaded / tmProgress.total) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <span className="dl-pct">
                      {tmProgress
                        ? `${Math.min(100, Math.round((tmProgress.downloaded / tmProgress.total) * 100))}% · ${(
                            tmProgress.downloaded / 1048576
                          ).toFixed(0)} / ${(tmProgress.total / 1048576).toFixed(0)} MB${
                            tmSpeed > 0 ? ` · ${(tmSpeed / 1048576).toFixed(1)} MB/s` : ""
                          }`
                        : "0%"}
                    </span>
                  </div>
                ) : (
                  <p className="settings-blurb">
                    {t("Translation uses a small local model (Qwen3, ~1.8 GB) — download it once and it stays on this device.")}
                  </p>
                )}
                <div className="modal-actions">
                  <button
                    className="modal-primary translate-go"
                    disabled={tmDownloading}
                    onClick={() => useApp.getState().startTranslateDl()}
                  >
                    {tmDownloading ? t("Downloading…") : t("Download & install")}
                  </button>
                  <button className="modal-secondary translate-stop" onClick={() => setTranslateTarget(null)}>
                    <X size={14} /> {t("Cancel")}
                  </button>
                </div>
              </>
            )}
            {(translateEngine === "google" || tmInstalled) && (
            <>
            <div className="translate-lang-row">
              <Select
                value={translateLang}
                onChange={setTranslateLang}
                disabled={translating}
                ariaLabel="Target language"
                className="lang-select-control"
                searchable
                searchPlaceholder="Search languages…"
                options={TRANSLATE_TARGETS.map((l) => ({
                  value: l.value,
                  label: l.label,
                  hint: l.value === l.label ? undefined : l.value,
                  icon: <FlagIcon code={l.code} />,
                }))}
              />
            </div>
            {translating && (
              <div className="dl-progress translate-progress">
                <div className="dl-bar">
                  <div
                    className="dl-fill"
                    style={{
                      width: `${translateProgress ? Math.round(((translateProgress.page - 0.5) / translateProgress.pages) * 100) : 0}%`,
                    }}
                  />
                </div>
                <span className="dl-pct">
                  {translateProgress
                    ? `${Math.round(((translateProgress.page - 0.5) / translateProgress.pages) * 100)}% · ${translateProgress.page}/${translateProgress.pages}`
                    : "0%"}
                </span>
              </div>
            )}
            <div className="modal-actions">
              <button
                className="modal-primary translate-go"
                disabled={translating || (translateEngine === "google" && !googleKey.trim())}
                onClick={() => {
                  const doc = translateTarget;
                  setTranslating(true);
                  showToast(t("Translating — this can take a while per page…"));
                  void commands
                    .translateDocument(doc.info.id, translateLang, doc.info.title, translateEngine, googleKey.trim())
                    .then((info) => {
                      useApp.getState().addOpened(info);
                      showToast(t("Translation opened as a new document."));
                      setTranslateTarget(null);
                    })
                    .catch((e) => showToast(String(e)))
                    .finally(() => setTranslating(false));
                }}
              >
                {translating ? (
                  <>
                    <span className="spinner" aria-hidden />{" "}
                    {translateProgress
                      ? `${Math.round(((translateProgress.page - 0.5) / translateProgress.pages) * 100)}%`
                      : t("Translating…")}
                  </>
                ) : (
                  <>
                    <Languages size={14} /> {t("Translate")}
                  </>
                )}
              </button>
              <button
                className="modal-secondary translate-stop"
                onClick={() => {
                  if (translating) {
                    void commands.cancelTranslate();
                  } else {
                    setTranslateTarget(null);
                  }
                }}
              >
                <X size={14} /> {t("Cancel")}
              </button>
            </div>
            </>
            )}
          </div>
        </div>
      )}
      {needDoc && (
        <NeedDocModal
          toolLabel={needDoc.label}
          onClose={() => setNeedDoc(null)}
          onReady={(id) => needDoc.run(id)}
        />
      )}
      {protecting &&
        (() => {
          const doc = activeDoc();
          return doc ? <ProtectModal doc={doc} onClose={() => setProtecting(false)} /> : null;
        })()}
      {compressing &&
        (() => {
          const doc = activeDoc();
          return doc ? <CompressModal doc={doc} onClose={() => setCompressing(false)} /> : null;
        })()}
      {printing &&
        (() => {
          const doc = activeDoc();
          return doc ? <PrintModal doc={doc} onClose={() => setPrinting(false)} /> : null;
        })()}
    </aside>
  );
}
