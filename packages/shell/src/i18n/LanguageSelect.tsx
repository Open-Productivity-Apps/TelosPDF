// Compact language picker — a dropdown (Settings → General). Lists every language grouped under
// disabled continent headers, each row a flat flag + native name + (english · country). Below it: a
// disclaimer that translations are community-contributed, with a "contribute" link. The first time a
// non-English language is chosen, the standard modal explains the same and links to the repo.

import { useEffect, useState } from "react";
import { confirmExternalLink } from "../components/LinkConfirm";
import { Select, type SelectOption } from "../components/Select";
import { FlagIcon } from "./FlagIcon";
import {
  cachedVersion,
  fetchManifest,
  hasCached,
  languagesByContinent,
  updateLocaleFromRepo,
  useLocale,
  findLanguage,
  T,
  type LocaleCode,
} from "./index";

const CONTRIBUTE_URL = "https://github.com/Open-Productivity-Apps/TelosPDF/tree/main/languages";
const seenKey = (c: LocaleCode) => `telos:langdisc:${c}`;

function ExtLinkIcon() {
  return (
    <svg className="ext-link-ico" width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

function ContributeLink({ label }: { label: string }) {
  return (
    <button type="button" className="lang-contribute" onClick={() => confirmExternalLink(CONTRIBUTE_URL)}>
      {label}<ExtLinkIcon />
    </button>
  );
}

function LanguageDisclaimerPopup({ locale, onClose }: { locale: LocaleCode; onClose: () => void }) {
  const lang = findLanguage(locale);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal lang-disc-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3 className="lang-disc-title">
          {lang && <FlagIcon code={locale} className="lang-disc-flag" />}
          {lang ? lang.native : locale}
        </h3>
        <p className="lang-disc-body">
          This translation <strong>may contain inaccuracies</strong> — only <strong>English (UK)</strong>
          is maintained by TelosPDF. Spot something off? Help fix it.
        </p>
        <div className="lang-disc-actions">
          <ContributeLink label="Help improve this translation" />
          <button type="button" className="btn primary" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}

export function LanguageSelect() {
  const [locale, setLocale] = useLocale();
  const [popup, setPopup] = useState<LocaleCode | null>(null);
  // Published languages (from the repo manifest). Until the manifest loads —
  // or offline — only the built-ins and anything already cached are usable.
  const [published, setPublished] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState<LocaleCode | null>(null);

  useEffect(() => {
    void fetchManifest().then(setPublished);
  }, []);

  const selectable = (code: LocaleCode) =>
    code === "en-GB" ||
    code === "en-US" ||
    hasCached(code) ||
    (published != null && code in published);

  const options: SelectOption[] = [];
  for (const { continent, items } of languagesByContinent()) {
    options.push({ value: `__hdr_${continent}`, label: continent, disabled: true, header: true });
    for (const l of items) {
      const ok = selectable(l.code);
      const downloaded = l.code === "en-GB" || l.code === "en-US" || hasCached(l.code);
      options.push({
        value: l.code,
        label: l.native,
        hint: l.english === l.native ? l.country : `${l.english} · ${l.country}`,
        icon: <FlagIcon code={l.code} />,
        disabled: !ok,
        tooltip: ok
          ? downloaded
            ? undefined
            : "Downloads when selected"
          : "Not translated yet — contributions welcome on GitHub",
        trailing: downloaded ? undefined : (
          <span className={`lang-dl${ok ? "" : " off"}`}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download
          </span>
        ),
      });
    }
  }

  function choose(code: string) {
    if (code.startsWith("__hdr_")) return;
    const loc = code as LocaleCode;
    if (!selectable(loc) || busy) return;
    void (async () => {
      // Download-first: the language applies once its strings are on disk.
      if (loc !== "en-GB" && loc !== "en-US" && !hasCached(loc)) {
        setBusy(loc);
        await updateLocaleFromRepo(loc);
        setBusy(null);
      }
      setLocale(loc);
      if (loc === "en-GB") return;
      let seen = false;
      try { seen = !!localStorage.getItem(seenKey(loc)); } catch { /* no storage */ }
      if (!seen) setPopup(loc);
    })();
  }
  function dismiss() {
    if (popup) { try { localStorage.setItem(seenKey(popup), "1"); } catch { /* no storage */ } }
    setPopup(null);
  }

  // An update is available when the repo's hash for the ACTIVE language
  // differs from the hash we downloaded it at.
  const updateReady =
    locale !== "en-GB" &&
    published != null &&
    locale in published &&
    published[locale] !== cachedVersion(locale);

  return (
    <div className="lang-select">
      <Select value={busy ?? locale} onChange={choose} options={options} ariaLabel="Language" className="lang-select-control"
        searchable searchPlaceholder="Search languages…" />
      {busy && <span className="lang-busy"><span className="spinner" aria-hidden /> Downloading…</span>}
      {!busy && updateReady && (
        <button
          type="button"
          className="lang-update"
          title="A newer translation is available on GitHub"
          onClick={() => {
            void updateLocaleFromRepo(locale).then(() => fetchManifest().then(setPublished));
          }}
        >
          Update
        </button>
      )}
      {popup && <LanguageDisclaimerPopup locale={popup} onClose={dismiss} />}
    </div>
  );
}

/** The community-contributed disclaimer + contribute link — used as the Language row's description. */
export function LanguageDisclaimer() {
  useLocale();
  return (
    <>
      <T>The app's display language. English (UK) ships built in; every other language downloads when you select it. Translations may contain inaccuracies.</T>{" "}
      <ContributeLink label="Help improve a translation" />
    </>
  );
}
