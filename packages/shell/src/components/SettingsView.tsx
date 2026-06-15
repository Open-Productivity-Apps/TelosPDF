// Settings: MyBI-style full-page view — nav with search on the left
// (APP SETTINGS: General, Accessibility, Developer options, About),
// section content on the right, close button back to the workbench.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { ExternalLink, Github, Search } from "lucide-react";
import licenseText from "../../../../LICENSE?raw";
import { t, useLocale } from "../i18n";
import { LanguageSelect, LanguageDisclaimer } from "../i18n/LanguageSelect";
import { confirmExternalLink } from "./LinkConfirm";
import { usePrefs, type ThemePref } from "../prefs";
import { useApp, type FitMode } from "../store";
import { commands, type OcrModelStatus } from "../telos";
import { AppSelect } from "./AppSelect";
import { Select } from "./Select";
import {
  CURRENCY_CHOICES,
  REGION_CONTINENTS,
  detectRegion,
  numberLocale,
  regionDefaults,
  regionName,
  type AppRegion,
} from "../lib/regionFormat";
import { APP_BUILD, APP_VERSION } from "../version";

type SectionId = "general" | "region" | "ocr" | "translate" | "accessibility" | "about";

const SECTIONS: { id: SectionId; title: string; hint: string; keywords: string }[] = [
  { id: "general", title: "General", hint: "Page fit & sidebar", keywords: "fit zoom sidebar launch default" },
  { id: "region", title: "Region and language", hint: "Locale, translations & formats", keywords: "region language locale translate translation currency date time clock units metric imperial flag country" },
  { id: "ocr", title: "OCR", hint: "Text recognition engine", keywords: "ocr scan tesseract unlimited baidu model ai text recognition engine download" },
  { id: "translate", title: "Translate", hint: "Local model & Google API key", keywords: "translate translation google cloud api key qwen local model language" },
  { id: "accessibility", title: "Accessibility", hint: "Theme, motion & text", keywords: "theme dark light oled system motion animation text size contrast" },
  { id: "about", title: "About", hint: "Version, engines & licenses", keywords: "version engine pdfium license credits" },
];

export default function SettingsView() {
  const [section, setSection] = useState<SectionId>("general");
  const [query, setQuery] = useState("");
  useLocale();

  const q = query.trim().toLowerCase();
  const visible = SECTIONS.filter(
    (s) => !q || s.title.toLowerCase().includes(q) || s.keywords.includes(q) || s.hint.toLowerCase().includes(q),
  );

  return (
    <div className="settings-view">
      <div className="settings-nav">
        <div className="settings-title-row">
          <h2>Settings</h2>
        </div>
        <div className="settings-search">
          <Search size={15} />
          <input
            placeholder="Search settings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="settings-group">App settings</div>
        {visible.map((s) => (
          <button
            key={s.id}
            className={`settings-nav-item ${section === s.id ? "active" : ""}`}
            onClick={() => setSection(s.id)}
          >
            <div className="settings-nav-title">{t(s.title)}</div>
            <div className="settings-nav-hint">{t(s.hint)}</div>
          </button>
        ))}
        {visible.length === 0 && <div className="panel-note">No matches.</div>}
      </div>

      <div className="settings-content">
        {section === "general" && <GeneralSection />}
        {section === "region" && <RegionSection />}
        {section === "ocr" && <OcrSection />}
        {section === "translate" && <TranslateSection />}
        {section === "accessibility" && <AccessibilitySection />}
        {section === "about" && <AboutSection />}
      </div>
    </div>
  );
}

function SectionHeader({ title, hint }: { title: string; hint: string }) {
  useLocale();
  return (
    <header className="settings-header">
      <h1>{t(title)}</h1>
      <p>{t(hint)}</p>
    </header>
  );
}

function Row({ title, description, children }: { title: string; description: ReactNode; children?: ReactNode }) {
  useLocale();
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-title">{t(title)}</div>
        <div className="setting-desc">
          {typeof description === "string" ? t(description) : description}
        </div>
      </div>
      {children && <div className="setting-control">{children}</div>}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.id}
          className={value === o.id ? "active" : ""}
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange?: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button
      className={`switch ${on ? "on" : ""}`}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
      role="switch"
      aria-checked={on}
    >
      <span className="knob" />
    </button>
  );
}

function GeneralSection() {
  const prefs = usePrefs();
  const setFitMode = useApp((s) => s.setFitMode);
  return (
    <>
      <SectionHeader title="General" hint="Page fit & sidebar" />
      <Row
        title="Default page fit"
        description="How documents are zoomed when opened. Applies immediately and to every new document."
      >
        <Segmented<FitMode>
          value={prefs.defaultFit}
          options={[
            { id: "fit-width", label: "Fit width" },
            { id: "fit-page", label: "Fit page" },
            { id: "actual", label: "Actual size" },
          ]}
          onChange={(fit) => {
            prefs.setDefaultFit(fit);
            setFitMode(fit);
          }}
        />
      </Row>
      <Row
        title="Reopen last files on launch"
        description="Pick up where you left off — your open documents come back next start, including after a crash."
      >
        <Toggle on={prefs.restoreSession} onChange={prefs.setRestoreSession} />
      </Row>
      <Row
        title="Sidebar on launch"
        description="Whether the left tools sidebar starts expanded (icons with labels) or collapsed (icons only)."
      >
        <Segmented
          value={prefs.sidebarStart}
          options={[
            { id: "expanded", label: "Expanded" },
            { id: "collapsed", label: "Collapsed" },
          ]}
          onChange={prefs.setSidebarStart}
        />
      </Row>
    </>
  );
}

// Region & language — ported 1:1 from MyBI's RegionSection.
const CURRENCY_INFO: Record<string, string> = {
  USD: "$ · US Dollar", EUR: "€ · Euro", GBP: "£ · Pound Sterling", INR: "₹ · Indian Rupee",
  JPY: "¥ · Japanese Yen", CNY: "¥ · Chinese Yuan", AUD: "$ · Australian Dollar", CAD: "$ · Canadian Dollar",
  BRL: "R$ · Brazilian Real", RUB: "₽ · Russian Ruble", AED: "د.إ · UAE Dirham", SGD: "$ · Singapore Dollar",
  KRW: "₩ · South Korean Won", MXN: "$ · Mexican Peso", ZAR: "R · South African Rand", PKR: "₨ · Pakistani Rupee",
};

const RegionFlag = ({ code }: { code: string }) => (
  <span className={`fi fi-${code.toLowerCase()} lang-flag-ico`} aria-hidden />
);


function RegionSection() {
  const region = usePrefs((s) => s.appRegion);
  const setRegion = usePrefs((s) => s.setAppRegion);
  const setRegionAutoFrom = usePrefs((s) => s.setRegionAutoFrom);
  const [autoCode, setAutoCode] = useState("");
  useEffect(() => {
    void detectRegion(false).then(setAutoCode);
  }, []);
  const sample = (1234567.89).toLocaleString(numberLocale(region.numberStyle), {
    maximumFractionDigits: 2,
  });
  const autoLabel = autoCode ? `Auto (${regionName(autoCode)})` : "Auto (detecting…)";
  return (
    <>
      <SectionHeader title="Region and language" hint="Locale, translations & formats" />
      <div className="settings-group">Region</div>
      <Row
        title="Region"
        description="Follows your device's current region — read from the system locale and time zone only. No network and no location access. Pick a specific region to override."
      >
        <Select
          searchable
          searchPlaceholder="Search regions…"
          ariaLabel="Region"
          className="lang-select-control"
          value={region.code || ""}
          options={[
            { value: "", label: autoLabel, icon: autoCode ? <RegionFlag code={autoCode} /> : undefined },
            ...REGION_CONTINENTS.flatMap(({ continent, codes }) => [
              { value: `__hdr_${continent}`, label: continent, disabled: true, header: true },
              ...codes
                .map((c) => ({ value: c, label: regionName(c), icon: <RegionFlag code={c} /> }))
                .sort((a, b) => a.label.localeCompare(b.label)),
            ]),
          ]}
          onChange={(v) => {
            if (v) {
              setRegion(regionDefaults(v));
              return;
            }
            void detectRegion(false).then((code) => {
              setAutoCode(code);
              setRegionAutoFrom(code);
              setRegion(code ? { ...regionDefaults(code), code: "" } : { code: "" });
            });
          }}
        />
      </Row>
      <Row title="Language" description={<LanguageDisclaimer />}>
        <LanguageSelect />
      </Row>
      <div className="settings-group">Formats (follow the region — override any)</div>
      <Row title="Currency" description="The currency code used for money formats.">
        <AppSelect
          searchable
          searchPlaceholder="Search currencies…"
          value={region.currency}
          options={CURRENCY_CHOICES.map((c) => ({ value: c, label: c, hint: CURRENCY_INFO[c] }))}
          onChange={(v) => setRegion({ currency: v })}
        />
      </Row>
      <Row title="Number separators" description={`How thousands/decimals read — currently: ${sample}`}>
        <AppSelect
          value={region.numberStyle}
          options={(["1,234.56", "1.234,56", "1 234,56", "1,23,456.78"] as const).map((s) => ({
            value: s,
            label: s,
          }))}
          onChange={(v) => setRegion({ numberStyle: v as AppRegion["numberStyle"] })}
        />
      </Row>
      <Row title="Date format" description="The order short dates are written in.">
        <AppSelect
          value={region.dateOrder}
          options={[
            { value: "DMY", label: "Day/Month/Year (31/12/2026)" },
            { value: "MDY", label: "Month/Day/Year (12/31/2026)" },
            { value: "YMD", label: "Year-Month-Day (2026-12-31)" },
          ]}
          onChange={(v) => setRegion({ dateOrder: v as AppRegion["dateOrder"] })}
        />
      </Row>
      <Row title="Time format" description="12-hour (1:30 PM) or 24-hour (13:30) clock.">
        <Segmented
          value={region.clock}
          options={[
            { id: "12h", label: "12-hour" },
            { id: "24h", label: "24-hour" },
          ]}
          onChange={(v) => setRegion({ clock: v })}
        />
      </Row>
      <Row title="Measurement units" description="Metric (km, kg, °C) or imperial (mi, lb, °F).">
        <Segmented
          value={region.units}
          options={[
            { id: "metric", label: "Metric" },
            { id: "imperial", label: "Imperial" },
          ]}
          onChange={(v) => setRegion({ units: v })}
        />
      </Row>
    </>
  );
}

const GB = 1024 * 1024 * 1024;

function OcrSection() {
  const prefs = usePrefs();
  const showToast = useApp((s) => s.showToast);
  const [model, setModel] = useState<OcrModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [speed, setSpeed] = useState(0);
  const lastTick = useRef<{ bytes: number; at: number } | null>(null);

  useEffect(() => {
    commands.ocrModelStatus().then(setModel, () => {});
    const un = listen<{ downloaded: number; total: number }>("ocr-model-progress", (e) => {
      setProgress(e.payload);
      // Download speed from event deltas, lightly smoothed.
      const now = performance.now();
      const last = lastTick.current;
      if (last && now > last.at) {
        const inst = ((e.payload.downloaded - last.bytes) / (now - last.at)) * 1000;
        if (inst >= 0) setSpeed((s) => (s === 0 ? inst : s * 0.7 + inst * 0.3));
      }
      lastTick.current = { bytes: e.payload.downloaded, at: now };
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const download = () => {
    setDownloading(true);
    commands
      .downloadOcrModel()
      .then((st) => {
        setModel(st);
        showToast("Unlimited-OCR model installed.");
      })
      .catch((e) => showToast(String(e)))
      .finally(() => setDownloading(false));
  };

  return (
    <>
      <SectionHeader title="OCR" hint="Text recognition engine" />
      <Row
        title="Engine"
        description="Tesseract ships inside the app and runs instantly. Unlimited-OCR (Baidu's 3B vision model) is far stronger on scans, tables, and Chinese/Japanese/Korean text, but needs a one-time ~2.4 GB download."
      >
        <Segmented
          value={prefs.ocrEngine}
          options={[
            { id: "tesseract", label: "Tesseract 5" },
            { id: "unlimited", label: "Unlimited-OCR 3B" },
          ]}
          onChange={prefs.setOcrEngine}
        />
      </Row>
      {prefs.ocrEngine === "unlimited" && (
        <Row
          title="Model"
          description={
            model?.installed
              ? `Installed in ${model.dir} — Scan & OCR runs Unlimited-OCR while this engine is selected.`
              : "Downloads the model and the llama.cpp runtime (~2.5 GB total) and installs them automatically. Resumable if interrupted."
          }
        >
          {model?.installed ? (
            <span className="status-pill granted">{`Installed · ${(model.bytes / GB).toFixed(1)} GB`}</span>
          ) : downloading ? (
            <div className="dl-progress" title="Downloading the Unlimited-OCR model and runtime">
              <div className="dl-bar">
                <div
                  className="dl-fill"
                  style={{
                    width: `${progress ? Math.min(100, (progress.downloaded / progress.total) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className="dl-pct">
                {progress
                  ? `${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}% · ${(
                      progress.downloaded / GB
                    ).toFixed(2)} / ${(progress.total / GB).toFixed(2)} GB${
                      speed > 0 ? ` · ${(speed / 1048576).toFixed(1)} MB/s` : ""
                    }`
                  : t("Starting…")}
              </span>
            </div>
          ) : (
            <button className="modal-primary" onClick={download}>
              Download & install
            </button>
          )}
        </Row>
      )}
      <div className="settings-group" style={{ padding: "14px 0 6px" }}>
        Engine comparison
      </div>
      <div className="table-scroll">
        <table className="ocr-compare">
          <thead>
            <tr>
              <th></th>
              <th>Tesseract 5 (shipped)</th>
              <th>Unlimited-OCR 3B (Baidu)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Accuracy</td>
              <td>Good on clean printed text; struggles with messy scans, tables, formulas</td>
              <td>State of the art (93.2 OmniDocBench) — excels at scans, tables, formulas, CJK</td>
            </tr>
            <tr>
              <td>Searchable-PDF text layer</td>
              <td>Word-level boxes — precise selection & search highlights</td>
              <td>Paragraph-level boxes — coarser selection</td>
            </tr>
            <tr>
              <td>Size on disk</td>
              <td>~50 MB, bundled</td>
              <td>~2.4 GB, on-demand download</td>
            </tr>
            <tr>
              <td>Speed per page</td>
              <td>1–3 s on any CPU</td>
              <td>2–10 s on Apple Silicon / GPU; 30–60 s CPU-only</td>
            </tr>
            <tr>
              <td>Memory</td>
              <td>&lt; 0.5 GB</td>
              <td>6–12 GB</td>
            </tr>
            <tr>
              <td>License</td>
              <td>Apache-2.0</td>
              <td>MIT</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function TranslateSection() {
  const prefs = usePrefs();
  const [model, setModel] = useState<OcrModelStatus | null>(null);
  const downloading = useApp((s) => s.translateDlActive);
  const progress = useApp((s) => s.translateDlProgress);
  const speed = useApp((s) => s.translateDlSpeed);
  const dlBump = useApp((s) => s.translateDlBump);
  useEffect(() => {
    commands.translateModelStatus().then(setModel, () => {});
  }, [dlBump]);
  return (
    <>
      <SectionHeader title="Translate" hint="Local model & Google API key" />
      <Row
        title="Engine"
        description="The default engine the Translate PDF dialog opens with. Local runs offline; Google Cloud uses your API key."
      >
        <Segmented
          value={prefs.translateEngine}
          options={[
            { id: "local", label: "Local model" },
            { id: "google", label: "Google Cloud" },
          ]}
          onChange={prefs.setTranslateEngine}
        />
      </Row>
      <Row
        title="Local model"
        description="Qwen3 (~1.8 GB) runs translation fully offline on this device."
      >
        {model?.installed ? (
          <span className="status-pill granted">{t("Installed")}</span>
        ) : downloading ? (
          <div className="dl-progress">
            <div className="dl-bar">
              <div
                className="dl-fill"
                style={{
                  width: `${progress ? Math.min(100, (progress.downloaded / progress.total) * 100) : 0}%`,
                }}
              />
            </div>
            <span className="dl-pct">
              {progress
                ? `${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}% · ${(
                    progress.downloaded / 1048576
                  ).toFixed(0)} / ${(progress.total / 1048576).toFixed(0)} MB${
                    speed > 0 ? ` · ${(speed / 1048576).toFixed(1)} MB/s` : ""
                  }`
                : t("Starting…")}
            </span>
          </div>
        ) : (
          <button className="modal-primary" onClick={() => useApp.getState().startTranslateDl()}>
            {t("Download & install")}
          </button>
        )}
      </Row>
      <Row
        title="Google Cloud API key"
        description="Optional cloud engine — uses YOUR Google Cloud Translation key, stored only on this device. Selecting Google Cloud in the Translate dialog sends the document's text to Google."
      >
        <input
          className="translate-key settings-key"
          type="password"
          placeholder={t("Paste your API key")}
          value={prefs.googleTranslateKey}
          onChange={(e) => prefs.setGoogleTranslateKey(e.target.value)}
        />
        <button
          className="lang-contribute"
          title="console.cloud.google.com — enable the Cloud Translation API, then create an API key"
          onClick={() =>
            confirmExternalLink("https://console.cloud.google.com/apis/library/translate.googleapis.com")
          }
        >
          {t("Get a key")} <ExternalLink size={11} />
        </button>
      </Row>
    </>
  );
}

function AccessibilitySection() {
  const prefs = usePrefs();
  return (
    <>
      <SectionHeader title="Accessibility" hint="Theme, motion & text" />
      <Row title="Theme" description="System follows your OS appearance; Light and Dark force a look.">
        <Segmented<ThemePref>
          value={prefs.theme}
          options={[
            { id: "system", label: "System" },
            { id: "light", label: "Light" },
            { id: "dark", label: "Dark" },
          ]}
          onChange={prefs.setTheme}
        />
      </Row>
      <Row
        title="OLED mode"
        description="Pure-black dark surfaces — saves power on OLED displays. Applies whenever the dark theme is active."
      >
        <Toggle on={prefs.oledDark} onChange={prefs.setOledDark} />
      </Row>
      <Row
        title="Reduce motion"
        description="Turns off sidebar and panel animations."
      >
        <Toggle on={prefs.reduceMotion} onChange={prefs.setReduceMotion} />
      </Row>
    </>
  );
}

interface Engine {
  name: string;
  version: string;
  role: string;
  license: string;
  repo: string;
  site: string;
}

const ENGINES: Engine[] = [
  { name: "PDFium", version: "chromium/7763", role: "Rendering, text geometry, form fill (Chrome's PDF engine).", license: "BSD-3 / Apache-2.0", repo: "https://pdfium.googlesource.com/pdfium/", site: "https://pdfium.googlesource.com/pdfium/" },
  { name: "pdfium-render", version: "0.9", role: "Rust bindings to PDFium.", license: "MIT / Apache-2.0", repo: "https://github.com/ajrcarey/pdfium-render", site: "https://crates.io/crates/pdfium-render" },
  { name: "lopdf", version: "0.43", role: "Document surgery: page rotate/delete, incremental updates.", license: "MIT", repo: "https://github.com/J-F-Liu/lopdf", site: "https://crates.io/crates/lopdf" },
  { name: "pdf-writer", version: "0.15", role: "PDF content generation (Create new PDF).", license: "MIT / Apache-2.0", repo: "https://github.com/typst/pdf-writer", site: "https://crates.io/crates/pdf-writer" },
  { name: "Tauri", version: "2", role: "Cross-platform shell (Rust core + system webview).", license: "MIT / Apache-2.0", repo: "https://github.com/tauri-apps/tauri", site: "https://tauri.app" },
  { name: "React", version: "19", role: "Workbench interface.", license: "MIT", repo: "https://github.com/facebook/react", site: "https://react.dev" },
  { name: "Lucide", version: "0.525", role: "Icon set.", license: "ISC", repo: "https://github.com/lucide-icons/lucide", site: "https://lucide.dev" },
  { name: "Tesseract", version: "5", role: "OCR engine (bundled) for Scan & OCR.", license: "Apache-2.0", repo: "https://github.com/tesseract-ocr/tesseract", site: "https://tesseract-ocr.github.io" },
  { name: "LibreOffice", version: "system", role: "Office ↔ PDF conversion.", license: "MPL-2.0", repo: "https://github.com/LibreOffice/core", site: "https://www.libreoffice.org" },
  { name: "docx-rs", version: "0.4", role: "Writes .docx (PDF to Word text export).", license: "MIT", repo: "https://github.com/bokuweb/docx-rs", site: "https://crates.io/crates/docx-rs" },
  { name: "similar", version: "2", role: "Text diffing.", license: "Apache-2.0", repo: "https://github.com/mitsuhiko/similar", site: "https://crates.io/crates/similar" },
];

/** Popup shown for external links (the webview never navigates away). */
function LinkModal({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>{name}</h3>
        <p className="modal-url">{url}</p>
        <div className="modal-actions">
          <button
            className="modal-primary"
            onClick={() => {
              void navigator.clipboard.writeText(url).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
          <button className="modal-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function AboutSection() {
  const [tab, setTab] = useState<"app" | "ack" | "license">("app");
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);

  return (
    <>
      <SectionHeader title="About" hint="Version, engines & licenses" />
      <div className="about-tabs">
        <button className={tab === "app" ? "active" : ""} onClick={() => setTab("app")}>
          TelosPDF
        </button>
        <button className={tab === "ack" ? "active" : ""} onClick={() => setTab("ack")}>
          Acknowledgements
        </button>
        <button className={tab === "license" ? "active" : ""} onClick={() => setTab("license")}>
          License
        </button>
      </div>

      {tab === "app" && (
        <>
          <Row
            title="TelosPDF"
            description="Open-source PDF workstation · MIT license · Developed by Siddharth Sharma"
          >
            <span className="status-pill">{`v${APP_VERSION} (Build ${APP_BUILD})`}</span>
          </Row>
        </>
      )}

      {tab === "ack" && (
        <>
          <p className="settings-blurb">TelosPDF is built on the open-source work of others.</p>
          {ENGINES.map((e) => (
            <Row key={e.name} title={`${e.name} · ${e.version}`} description={e.role}>
              <span className="status-pill">{e.license}</span>
              <button
                className="link-btn"
                title="Open repository (external)"
                onClick={() => setLink({ name: e.name, url: e.repo })}
              >
                <Github size={16} />
                <ExternalLink size={10} className="ext-badge" />
              </button>
            </Row>
          ))}
        </>
      )}

      {tab === "license" && (
        <>
          <p className="settings-blurb">
            MIT license: anyone — including enterprises — may use, modify, and redistribute
            TelosPDF, provided copies retain the copyright and permission notice.
          </p>
          <pre className="license-text">{licenseText}</pre>
        </>
      )}

      {link && <LinkModal name={link.name} url={link.url} onClose={() => setLink(null)} />}
    </>
  );
}
