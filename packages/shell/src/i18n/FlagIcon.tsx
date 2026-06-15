// Flat flag icon (flag-icons) — replaces emoji flags, which don't render on Windows and look
// inconsistent across platforms. The ISO-3166 code is derived from the language's emoji flag
// (regional-indicator letters), with subdivision flags special-cased.
import { findLanguage } from "./index";

// Home-nation flags: their emoji are TAG sequences, not regional-indicator pairs, so isoFromEmoji
// can't derive them — map them explicitly to the flag-icons subdivision codes.
const SUBDIVISION: Record<string, string> = { "en-GB": "gb-eng", gd: "gb-sct", cy: "gb-wls" };

/** "🇬🇧" → "gb" (two regional-indicator symbols → their ASCII letters). null if not derivable. */
function isoFromEmoji(flag: string): string | null {
  const cps = [...flag].map((c) => c.codePointAt(0) ?? 0);
  const A = 0x1f1e6, Z = 0x1f1ff;
  if (cps.length >= 2 && cps[0] >= A && cps[0] <= Z && cps[1] >= A && cps[1] <= Z) {
    return String.fromCharCode(cps[0] - A + 97) + String.fromCharCode(cps[1] - A + 97);
  }
  return null;
}

/** Resolve the flag-icons ISO code for a locale (subdivision override → emoji-derived). */
export function flagIso(code: string): string | null {
  if (SUBDIVISION[code]) return SUBDIVISION[code];
  return isoFromEmoji(findLanguage(code)?.flag ?? "");
}

export function FlagIcon({ code, className = "" }: { code: string; className?: string }) {
  const iso = flagIso(code);
  // No derivable flag (e.g. a region locale without a country) → a neutral globe placeholder.
  if (!iso) return <span className={`lang-flag-ico lang-flag-none${className ? " " + className : ""}`} aria-hidden>🌐</span>;
  return <span className={`fi fi-${iso} lang-flag-ico${className ? " " + className : ""}`} aria-hidden />;
}
