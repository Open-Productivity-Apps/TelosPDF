// App-made dropdown (no native <select>): a bordered trigger showing the current
// value + a chevron, opening an in-app menu styled like every other MyBI dropdown.
// Used wherever a form needs a picker (e.g. GitHub publish defaults) so dropdowns
// look identical across platforms instead of inheriting the OS control.

import { useEffect, useRef, useState } from "react";

export interface AppSelectOption {
  value: string;
  label: string;
  /** Optional leading icon (e.g. a flag) shown before the label in the menu AND on the button. */
  icon?: React.ReactNode;
  /** Optional dimmed secondary text after the label (e.g. a currency symbol + name). */
  hint?: string;
}

export function AppSelect({
  value,
  options,
  placeholder = "Select…",
  disabled = false,
  onChange,
  searchable,
  searchPlaceholder,
}: {
  value: string;
  options: AppSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  /** Show a find-as-you-type box in the menu — for long lists (regions). Matches label + hint. */
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const sel = options.find((o) => o.value === value);
  // Find-as-you-type over label + hint; the query resets each time the menu opens.
  const q = query.trim().toLowerCase();
  const shown = !searchable || !q
    ? options
    : options.filter((o) => o.label.toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q));

  return (
    <div className={`app-select${disabled ? " disabled" : ""}`} ref={ref}>
      <button
        type="button"
        className="app-select-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { setQuery(""); setOpen((v) => !v); }}
      >
        {sel?.icon && <span className="app-select-val-ico" aria-hidden>{sel.icon}</span>}
        <span className={`app-select-val${sel ? "" : " ph"}`}>{sel?.label ?? placeholder}</span>
        <svg className="app-select-caret" width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="app-select-menu" role="listbox">
          {searchable && (
            <input
              className="app-select-search"
              autoFocus
              value={query}
              placeholder={searchPlaceholder ?? "Search…"}
              aria-label={searchPlaceholder ?? "Search"}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          )}
          {options.length === 0 ? (
            <div className="app-select-empty">Nothing to pick yet.</div>
          ) : shown.length === 0 ? (
            <div className="app-select-empty">No matches.</div>
          ) : (
            shown.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`app-select-item${o.value === value ? " sel" : ""}`}
                onClick={() => { onChange(o.value); setOpen(false); }}
              >
                {o.icon && <span className="app-select-item-ico" aria-hidden>{o.icon}</span>}
                {o.label}
                {o.hint && <span className="app-select-item-hint">{o.hint}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
