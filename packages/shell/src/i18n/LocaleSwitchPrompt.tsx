// On launch we detect the OS/region language. The app stays in en-GB (its source language), but if
// the detected language differs we auto-download that locale file (so it's ready) and surface a
// gentle "Switch to <language>?" banner — offered once per language, never forced. Skipped under
// Cyber lockdown (the download is a no-op there; we still offer, and it applies when reachable).

import { useEffect, useState } from "react";
import {
  detectSystemLocale, getLocale, setLocale, updateLocaleFromRepo, findLanguage, type LocaleCode,
} from "./index";
import { FlagIcon } from "./FlagIcon";

const askedKey = (c: LocaleCode) => `telos:localeoffer:${c}`;

export function LocaleSwitchPrompt() {
  const [offer, setOffer] = useState<LocaleCode | null>(null);

  useEffect(() => {
    const detected = detectSystemLocale();
    if (!detected || detected === getLocale()) return; // already in the OS language (or none)
    try { if (localStorage.getItem(askedKey(detected))) return; } catch { /* no storage */ }
    let cancelled = false;
    // Auto-download the detected language now so accepting is instant (no-op offline/lockdown).
    void updateLocaleFromRepo(detected).finally(() => { if (!cancelled) setOffer(detected); });
    return () => { cancelled = true; };
  }, []);

  if (!offer) return null;
  const lang = findLanguage(offer);
  const dismiss = () => {
    try { localStorage.setItem(askedKey(offer), "1"); } catch { /* no storage */ }
    setOffer(null);
  };
  const accept = () => { setLocale(offer); dismiss(); };

  return (
    <div className="locale-offer" role="dialog" aria-live="polite" aria-label="Language suggestion">
      <FlagIcon code={offer} className="locale-offer-flag" />
      <span className="locale-offer-text">
        Switch to <strong>{lang?.native ?? offer}</strong>
        {lang && lang.english !== lang.native ? <span className="locale-offer-en"> · {lang.english}</span> : null}?
      </span>
      <button type="button" className="btn primary sm" onClick={accept}>Switch</button>
      <button type="button" className="btn sm" onClick={dismiss}>Not now</button>
    </div>
  );
}
