// TelosPDF i18n runtime (ported 1:1 from MyBI) — GETTEXT-STYLE: the KEY passed to t() IS the en-GB source string written in
// the code (e.g. t("Colour palettes")). So en-GB needs NO locale file — the app's own text is the
// source of truth. Other languages are OVERRIDE files that map each en-GB string to its translation;
// en-US only lists the UK→US spelling differences. Lookup, highest wins:
//   1. OVERRIDES — the active language's file fetched from the repo (cached in localStorage),
//   2. BUNDLED   — any locale shipped in ./locales (normally none now; en-GB is not a file),
//   3. the key itself — i.e. the en-GB source string.
//
// On launch (and whenever the language changes) we check the repo for a NEWER version of just the
// ACTIVE language and download it only if it changed — UNLESS Cyber lockdown is on, in which case we
// never reach the network and use the cached strings (or the en-GB source text).

import { useEffect, useState } from "react";

import { LANGUAGES, DEFAULT_LOCALE, SOURCE_LOCALE, isLocale, isRtl, type LocaleCode } from "./languages";

function applyDocLang(code: LocaleCode): void {
  try {
    document.documentElement.lang = code;
    document.documentElement.dir = isRtl(code) ? "rtl" : "ltr";
  } catch { /* no document */ }
}

type Messages = Record<string, string>;

// Layer 2 — bundled at build time (no async load).
const BUNDLED = {} as Record<LocaleCode, Messages>;
for (const [path, mod] of Object.entries(import.meta.glob<{ default: Messages }>("./locales/*.json", { eager: true }))) {
  const code = path.replace(/^.*\/(.+)\.json$/, "$1");
  if (isLocale(code)) BUNDLED[code] = (mod as { default: Messages }).default ?? (mod as unknown as Messages);
}

// Layer 1 — repo overrides, restored from cache on boot.
const OVERRIDES = {} as Partial<Record<LocaleCode, Messages>>;

// Locale files live in the `languages/` folder on main of Open-Productivity-Apps/TelosPDF.
const LANG_BASE = "https://raw.githubusercontent.com/Open-Productivity-Apps/TelosPDF/main/languages";
const LOCALE_KEY = "telos:locale";
const cacheKey = (c: LocaleCode) => `telos:lang:${c}`;
const verKey = (c: LocaleCode) => `telos:langver:${c}`;
const EVENT = "telos:locale";

for (const l of LANGUAGES) {
  try {
    const raw = localStorage.getItem(cacheKey(l.code));
    if (raw) OVERRIDES[l.code] = JSON.parse(raw) as Messages;
  } catch { /* no storage / bad cache */ }
}

/** Best registry match for the OS/browser language (e.g. "fr-FR"→"fr"), or null if none found. */
export function detectSystemLocale(): LocaleCode | null {
  try {
    const sys = navigator.language;
    if (!sys) return null;
    const base = sys.split("-")[0];
    // English is canonical (en-GB IS the source; en-US is only spelling). navigator.language is the
    // LANGUAGE, which is often "en-US" even when the user's REGION is the UK — so never auto-suggest
    // switching to en-US. Any English variant resolves to en-GB (US stays a manual pick in Settings).
    if (base === "en") return "en-GB";
    // Pass fresh expressions to isLocale so it doesn't narrow `sys`/`base` to `never`
    // (LocaleCode is a string alias, so the guard's else-branch would otherwise collapse).
    if (isLocale(`${sys}`)) return sys as LocaleCode;
    if (base === "zh") return /hant|TW|HK|MO/i.test(sys) ? "zh-Hant" : "zh-Hans";
    if (isLocale(`${base}`)) return base as LocaleCode;
    const m = LANGUAGES.find((l) => l.code.split("-")[0] === base);
    return m ? m.code : null;
  } catch { return null; }
}

// The app's source language IS en-GB, so we never silently adopt the OS language — we start in the
// saved locale (or en-GB) and instead OFFER to switch via <LocaleSwitchPrompt/> on launch.
function initialLocale(): LocaleCode {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved && isLocale(saved)) return saved;
  } catch { /* no storage */ }
  return DEFAULT_LOCALE;
}

let current: LocaleCode = initialLocale();
applyDocLang(current);

export function getLocale(): LocaleCode {
  return current;
}

export function setLocale(code: LocaleCode): void {
  if (code === current) return;
  current = code;
  try { localStorage.setItem(LOCALE_KEY, code); } catch { /* no storage */ }
  applyDocLang(code);
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: code })); } catch { /* no window */ }
  // Download the chosen language now (no-op if cached + unchanged, or under Cyber lockdown).
  void updateLocaleFromRepo(code);
}

// en-US is the en-GB source with UK→US spelling applied on the fly — so we don't maintain a full
// en-US catalogue. Curated WHOLE-WORD pairs only (a blanket -ise→-ize would wreck "precise",
// "exercise", "promise"…). en-US.json may still add explicit overrides where this is wrong.
const UK_TO_US: Record<string, string> = {
  colour: "color", colours: "colors", coloured: "colored", colouring: "coloring", colourful: "colorful",
  recolour: "recolor", recoloured: "recolored", recolouring: "recoloring",
  centre: "center", centres: "centers", centred: "centered", centring: "centering",
  customise: "customize", customised: "customized", customising: "customizing", customisation: "customization",
  organise: "organize", organised: "organized", organising: "organizing", organisation: "organization", organisations: "organizations",
  optimise: "optimize", optimised: "optimized", optimising: "optimizing", optimisation: "optimization",
  personalise: "personalize", personalised: "personalized", personalising: "personalizing", personalisation: "personalization",
  analyse: "analyze", analysed: "analyzed", analysing: "analyzing",
  catalogue: "catalog", catalogues: "catalogs",
  behaviour: "behavior", behaviours: "behaviors",
  favourite: "favorite", favourites: "favorites", favourited: "favorited",
  licence: "license", licences: "licenses", defence: "defense", offence: "offense",
  grey: "gray", greys: "grays", greyscale: "grayscale", greyed: "grayed",
  cancelled: "canceled", cancelling: "canceling", labelled: "labeled", labelling: "labeling",
  modelling: "modeling", travelling: "traveling", fulfil: "fulfill", fulfilment: "fulfillment", enrolment: "enrollment",
  summarise: "summarize", summarised: "summarized", recognise: "recognize", recognised: "recognized",
  maximise: "maximize", minimise: "minimize", prioritise: "prioritize", synchronise: "synchronize",
  initialise: "initialize", normalise: "normalize", visualise: "visualize", visualisation: "visualization",
  utilise: "utilize", realise: "realize", finalise: "finalize", emphasise: "emphasize", categorise: "categorize",
  dialogue: "dialog", dialogues: "dialogs", metre: "meter", metres: "meters", litre: "liter", litres: "liters",
};
function toUsSpelling(s: string): string {
  return s.replace(/[A-Za-z]+/g, (w) => {
    const us = UK_TO_US[w.toLowerCase()];
    if (!us) return w;
    if (w === w.toUpperCase()) return us.toUpperCase();              // ALLCAPS
    if (w[0] === w[0].toUpperCase()) return us[0].toUpperCase() + us.slice(1); // Capitalised
    return us;
  });
}

/** Translate `key` (the en-GB source string): override → bundled → en-US auto-spelling → the key. */
export function t(key: string, locale: LocaleCode = current): string {
  const hit = OVERRIDES[locale]?.[key] ?? BUNDLED[locale]?.[key] ?? BUNDLED[SOURCE_LOCALE]?.[key];
  if (hit != null) return hit;
  if (locale === "en-US") return toUsSpelling(key); // no catalogue needed — spelling-transform en-GB
  return key;
}

/**
 * Check the repo for a newer version of `locale` and download it ONLY if it changed (manifest
 * version compare → "if update then go, else don't"). Skipped entirely under Cyber lockdown. Fetches
 * just the ONE selected language. Best-effort: any failure (offline / 404 / lockdown) keeps the
 * cached-or-bundled strings. Returns true if new strings were applied.
 */
export async function updateLocaleFromRepo(locale: LocaleCode = current): Promise<boolean> {
  
  try {
    const manifest = await fetch(`${LANG_BASE}/manifest.json`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ locales?: Record<string, unknown> }>) : null));
    const remoteVer = manifest?.locales?.[locale];
    if (remoteVer == null) return false; // language not published in the repo → keep bundled
    let cachedVer: string | null = null;
    try { cachedVer = localStorage.getItem(verKey(locale)); } catch { /* no storage */ }
    if (String(remoteVer) === cachedVer) return false; // already current — nothing to download

    const msgs = await fetch(`${LANG_BASE}/${locale}.json`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Messages>) : null));
    if (!msgs || typeof msgs !== "object") return false;

    OVERRIDES[locale] = msgs;
    try {
      localStorage.setItem(cacheKey(locale), JSON.stringify(msgs));
      localStorage.setItem(verKey(locale), String(remoteVer));
    } catch { /* no storage — in-memory only this session */ }
    if (locale === current) {
      try { window.dispatchEvent(new CustomEvent(EVENT, { detail: locale })); } catch { /* no window */ }
    }
    return true;
  } catch {
    return false; // offline / blocked / bad payload → keep what we have
  }
}

// Launch check: refresh ONLY the active language (deferred so it never blocks boot).
try { setTimeout(() => void updateLocaleFromRepo(current), 0); } catch { /* no timer */ }

/** Published locales from the repo manifest (code → version hash), or null when offline. */
export async function fetchManifest(): Promise<Record<string, string> | null> {
  try {
    const m = (await fetch(`${LANG_BASE}/manifest.json`, { cache: "no-store" }).then((r) =>
      r.ok ? r.json() : null,
    )) as { locales?: Record<string, string> } | null;
    return m?.locales ?? null;
  } catch {
    return null;
  }
}

/** Strings for `code` are already downloaded (or cached from a prior run). */
export function hasCached(code: LocaleCode): boolean {
  return !!OVERRIDES[code];
}

/** The manifest hash the cached download was made from, if any. */
export function cachedVersion(code: LocaleCode): string | null {
  try {
    return localStorage.getItem(verKey(code));
  } catch {
    return null;
  }
}

/** React hook: the active locale + setter. Re-renders on language change AND on a repo refresh. */
export function useLocale(): [LocaleCode, (c: LocaleCode) => void] {
  const [loc, setLoc] = useState<LocaleCode>(current);
  const [, force] = useState(0);
  useEffect(() => {
    const onChange = (e: Event) => {
      setLoc((e as CustomEvent<LocaleCode>).detail);
      force((n) => n + 1); // re-render even when only the strings changed (same locale)
    };
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  return [loc, setLocale];
}

export { LANGUAGES, languagesByContinent, findLanguage, isRtl, type LocaleCode } from "./languages";
export { T } from "./T";
