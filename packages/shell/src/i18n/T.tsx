// Inline translated text. <T>Background colour</T> renders the active-locale string and re-renders
// ITSELF when the language changes — so the parent component doesn't need its own useLocale().
// Use for JSX text nodes. For string props (title/placeholder/aria-label) call t(...) directly and
// add useLocale() to that component (an attribute can't be a child component).
import { t, useLocale } from "./index";

export function T({ children }: { children: string }) {
  useLocale();
  return <>{t(children)}</>;
}
