// Host-platform facts the UI needs so it never describes the wrong machine —
// a Windows user should not read about Apple Silicon, and "⌘Z" means nothing
// outside macOS. The webview's UA is the only signal available synchronously
// at module load (Tauri's platform API is async), and it is reliable enough
// for phrasing.

const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;

export const isWindows = /Windows|Win32|Win64/i.test(ua);
export const isAndroid = /Android/i.test(ua);
export const isMac = !isWindows && !isAndroid && /Mac|iPhone|iPad|iPod/i.test(ua);
export const isLinux = !isWindows && !isMac && !isAndroid && /Linux|X11/i.test(ua);

/** The modifier key this OS actually uses (the app binds Cmd *or* Ctrl). */
export const modKey = isMac ? "⌘" : "Ctrl";

/**
 * Rewrite mac shortcut notation for non-mac hosts. Applied centrally in `t()`
 * so it fixes every translated string too — the translation KEY stays the
 * en-GB source text (with ⌘/Cmd), which keeps all `languages/*.json` catalogues
 * valid while Windows and Linux still read "Ctrl".
 */
export function localizeShortcuts(s: string): string {
  if (isMac || !s) return s;
  return s.includes("⌘") || s.includes("Cmd")
    ? s.replace(/⌘\s*\+?\s*/g, "Ctrl+").replace(/\bCmd\b/g, "Ctrl")
    : s;
}
