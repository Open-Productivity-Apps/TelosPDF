// App-native dropdown — replaces the OS `<select>` popup (which can't be styled and
// looks/behaves differently per platform). Same value/onChange contract as a select,
// but renders its own listbox in a portal (so panel overflow never clips it) with
// keyboard support (↑/↓/Home/End/Enter/Esc) and viewport flip when there's no room.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Group header row: styled as a section label, never selectable, hidden while searching. */
  header?: boolean;
  /** Optional leading icon (e.g. a flag) shown before the label in the list AND on the
   *  button when this option is selected. */
  icon?: React.ReactNode;
  /** Optional secondary text shown dimmed after the label (e.g. a country name). */
  hint?: string;
  /** Optional right-aligned content (e.g. a Download chip). */
  trailing?: React.ReactNode;
  /** Native tooltip shown on hover. */
  tooltip?: string;
}

export function Select({
  value, onChange, options, className, ariaLabel, disabled, placeholder, leadingIcon,
  searchable, searchPlaceholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  placeholder?: string;
  /** Optional glyph shown before the value (e.g. an aggregate ∑ on measure wells). */
  leadingIcon?: React.ReactNode;
  /** Show a find-as-you-type box in the list — for long lists (languages, regions). Matches on
   *  the option label AND its hint; group headers are hidden while a query is active. */
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [query, setQuery] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left?: number; right?: number; top: number; minWidth: number; below: boolean; scale: number } | null>(null);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? placeholder ?? "";

  const place = () => {
    const el = btnRef.current;
    const b = el?.getBoundingClientRect();
    if (!el || !b) return;
    // The button may be inside a CSS-transform-SCALED ancestor (the options popup scales with
    // canvas zoom). The portaled list is mounted on <body> and ignores that transform, so it
    // would render at full size — bigger than the shrunken control. Recover the scale from the
    // rendered width vs the layout width and apply it to the list so they match.
    const scale = el.offsetWidth ? b.width / el.offsetWidth : 1;
    const spaceBelow = window.innerHeight - b.bottom;
    const below = spaceBelow > 240 || spaceBelow >= b.top;
    const top = below ? b.bottom + 4 : b.top - 4;
    // Anchor by the button's RIGHT edge when it sits close to the viewport's right
    // edge — a compact agg select near the right of the panel would otherwise grow
    // off-screen (the popup is min-width: button, but grows to fit option text).
    const nearRight = window.innerWidth - b.right < 200;
    setPos(nearRight
      ? { right: Math.max(8, window.innerWidth - b.right), top, minWidth: el.offsetWidth, below, scale }
      : { left: b.left, top, minWidth: el.offsetWidth, below, scale });
  };

  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (btnRef.current?.contains(e.target as Node) || listRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const reflow = () => place();
    document.addEventListener("pointerdown", onDoc, true);
    window.addEventListener("resize", reflow);
    window.addEventListener("scroll", reflow, true);
    return () => {
      document.removeEventListener("pointerdown", onDoc, true);
      window.removeEventListener("resize", reflow);
      window.removeEventListener("scroll", reflow, true);
    };
  }, [open]);

  // Find-as-you-type (opt-in via `searchable`) — with 95 languages or 200 regions nobody scrolls.
  // While a query is active the group HEADERS are dropped (they'd strand empty), and every list
  // operation below runs over `shown` rather than the raw `options`.
  const q = query.trim().toLowerCase();
  const shown = !searchable || !q
    ? options
    : options.filter((o) => !o.header && (
        o.label.toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q)
      ));

  const openList = () => {
    if (disabled) return;
    setQuery("");
    setActiveIdx(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const choose = (o: SelectOption) => {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
    btnRef.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openList(); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); btnRef.current?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => step(shown, i, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => step(shown, i, -1)); }
    else if (e.key === "Home") { e.preventDefault(); setActiveIdx(step(shown, -1, 1)); }
    else if (e.key === "End") { e.preventDefault(); setActiveIdx(step(shown, shown.length, -1)); }
    // Space is a literal character while typing a query — don't hijack it as "choose".
    else if (e.key === "Enter" || (e.key === " " && !(searchable && q))) { e.preventDefault(); const o = shown[activeIdx]; if (o) choose(o); }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        className={`app-select${className ? " " + className : ""}${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKey}
      >
        {(leadingIcon ?? selected?.icon) && <span className="app-select-lead" aria-hidden>{leadingIcon ?? selected?.icon}</span>}
        <span className={`app-select-label${selected ? "" : " placeholder"}`}>{label}</span>
        <svg className="app-select-chev" viewBox="0 0 24 24" width="14" height="14" aria-hidden>
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          ref={listRef}
          className={`app-select-pop${pos.below ? "" : " above"}`}
          role="listbox"
          style={{
            left: pos.left, right: pos.right, top: pos.top, minWidth: pos.minWidth,
            transform: `${pos.below ? "" : "translateY(-100%)"} scale(${pos.scale})`.trim(),
            transformOrigin: `${pos.below ? "top" : "bottom"} ${pos.right != null ? "right" : "left"}`,
          }}
        >
          {searchable && (
            <input
              className="app-select-search"
              autoFocus
              value={query}
              placeholder={searchPlaceholder ?? "Search…"}
              aria-label={searchPlaceholder ?? "Search"}
              onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
              onKeyDown={onKey}
            />
          )}
          {shown.length === 0 && <div className="app-select-empty">No matches.</div>}
          {shown.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              title={o.tooltip}
              className={`app-select-opt${o.value === value ? " sel" : ""}${i === activeIdx ? " active" : ""}${o.disabled ? " disabled" : ""}${o.header ? " hdr" : ""}`}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(o); }}
            >
              {o.icon && <span className="app-select-opt-ico" aria-hidden>{o.icon}</span>}
              {o.label}
              {o.hint && <span className="app-select-opt-hint">{o.hint}</span>}
              {/* Right edge: the selected tick, or the option's trailing content. */}
              {o.value === value
                ? <span className="app-select-tick" aria-hidden>✓</span>
                : o.trailing && <span className="app-select-trail">{o.trailing}</span>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Next non-disabled option index from `from` moving in `dir` (wraps). */
function step(options: SelectOption[], from: number, dir: number): number {
  let i = from;
  for (let n = 0; n < options.length; n++) {
    i += dir;
    if (i < 0) i = options.length - 1;
    if (i >= options.length) i = 0;
    if (!options[i]?.disabled) return i;
  }
  return Math.max(0, from);
}
