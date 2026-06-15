// Right icon rail: document panels on top (Comments / Bookmarks / Pages),
// and the viewer control cluster pinned at the bottom — page input with
// total, prev/next, rotate view, fit mode, zoom in/out.
import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  ChevronDown,
  ChevronUp,
  Copy,
  Expand,
  MessageSquareText,
  PenLine,
  RotateCwSquare,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useActiveDoc, useApp, type FitMode, type RightPanelId } from "../store";

const PANELS: { id: RightPanelId & string; label: string; icon: typeof Bookmark }[] = [
  { id: "comments", label: "Comments", icon: MessageSquareText },
  { id: "bookmarks", label: "Bookmarks", icon: Bookmark },
  { id: "pages", label: "Pages", icon: Copy },
];

const FIT_MODES: { id: FitMode; label: string }[] = [
  { id: "fit-width", label: "Fit to width" },
  { id: "fit-page", label: "Zoom to page level" },
  { id: "actual", label: "Actual size" },
];

export default function RightRail() {
  const doc = useActiveDoc();
  const rightPanel = useApp((s) => s.rightPanel);
  const setRightPanel = useApp((s) => s.setRightPanel);
  const fitMode = useApp((s) => s.fitMode);
  const setFitMode = useApp((s) => s.setFitMode);
  const zoomBy = useApp((s) => s.zoomBy);
  const effectiveZoom = useApp((s) => s.effectiveZoom);
  const goToPage = useApp((s) => s.goToPage);
  const rotateView = useApp((s) => s.rotateView);
  // The signatures panel appears only once something has been placed.
  const signCount = useApp((s) => s.pendingPlacements.length + s.placedLog.length);

  const [fitMenuOpen, setFitMenuOpen] = useState(false);
  const fitRef = useRef<HTMLDivElement>(null);
  const [fitPos, setFitPos] = useState<{ right: number; bottom: number } | null>(null);
  const [pageInput, setPageInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [railNav, setRailNav] = useState({ up: false, down: false });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Chevrons appear only in the direction that actually has hidden icons.
    const check = () =>
      setRailNav({
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

  const currentPage = doc?.currentPage ?? 0;
  const pages = doc?.info.pages ?? 0;

  useEffect(() => setPageInput(String(currentPage + 1)), [currentPage]);

  useEffect(() => {
    if (!fitMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!fitRef.current?.contains(e.target as Node)) setFitMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [fitMenuOpen]);

  const navigate = (page: number) => {
    if (!doc) return;
    goToPage(Math.min(Math.max(page, 0), pages - 1));
  };

  const commitPageInput = () => {
    const n = parseInt(pageInput, 10);
    if (!Number.isNaN(n)) navigate(n - 1);
  };

  return (
    <nav className="rail rail-right">
      {railNav.up && (
        <button className="rail-vnav" onClick={() => scrollRef.current?.scrollBy({ top: -140, behavior: "smooth" })}>
          <ChevronUp size={14} />
        </button>
      )}
      <div className="rail-scroll" ref={scrollRef}>
      {PANELS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className={`rail-btn ${rightPanel === id ? "active" : ""}`}
          data-tip={label}
          onClick={() => setRightPanel(id)}
        >
          <Icon size={22} strokeWidth={1.6} />
        </button>
      ))}
      {signCount > 0 && (
        <button
          className={`rail-btn ${rightPanel === "signatures" ? "active" : ""}`}
          data-tip="Signatures & stamps"
          onClick={() => setRightPanel("signatures")}
        >
          <PenLine size={22} strokeWidth={1.6} />
        </button>
      )}
      <div className="spacer" />

      {/* Controls stay visible without a document — just disabled. */}
      <div className="nav-cluster">
        <input
          className="page-input"
          value={doc ? pageInput : ""}
          placeholder="–"
          disabled={!doc}
          onChange={(e) => setPageInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commitPageInput()}
          onBlur={commitPageInput}
          data-tip="Go to page"
        />
        <div className="page-total">{doc ? pages : "–"}</div>

        <button
          className="rail-btn"
          data-tip="Previous page"
          disabled={!doc || currentPage <= 0}
          onClick={() => navigate(currentPage - 1)}
        >
          <ChevronUp size={20} />
        </button>
        <button
          className="rail-btn"
          data-tip="Next page"
          disabled={!doc || currentPage >= pages - 1}
          onClick={() => navigate(currentPage + 1)}
        >
          <ChevronDown size={20} />
        </button>

        <div className="rail-divider" />

        <button
          className="rail-btn"
          data-tip="Rotate view"
          disabled={!doc}
          onClick={() => doc && rotateView(doc.info.id)}
        >
          <RotateCwSquare size={20} strokeWidth={1.7} />
        </button>

        <div className="tab-create" ref={fitRef}>
          <button
            className={`rail-btn ${fitMenuOpen ? "active" : ""}`}
            data-tip="Page fit"
            disabled={!doc}
            onClick={() => {
              const r = fitRef.current?.getBoundingClientRect();
              if (r) setFitPos({ right: window.innerWidth - r.left + 6, bottom: window.innerHeight - r.bottom });
              setFitMenuOpen((v) => !v);
            }}
          >
            <Expand size={20} strokeWidth={1.7} />
          </button>
          {fitMenuOpen && (
            <div
              className="dropdown dropdown-left"
              style={fitPos ? { position: "fixed", right: fitPos.right, bottom: fitPos.bottom, left: "auto", top: "auto" } : undefined}
            >
              {FIT_MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setFitMode(m.id);
                    setFitMenuOpen(false);
                  }}
                >
                  {fitMode === m.id ? "✓ " : ""}
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button className="rail-btn" data-tip="Zoom in" disabled={!doc} onClick={() => zoomBy(1)}>
          <ZoomIn size={20} strokeWidth={1.7} />
        </button>
        <button className="rail-btn" data-tip="Zoom out" disabled={!doc} onClick={() => zoomBy(-1)}>
          <ZoomOut size={20} strokeWidth={1.7} />
        </button>
        <div className="zoom-level" data-tip="Zoom level">
          {doc ? `${Math.round(effectiveZoom * 100)}%` : "–"}
        </div>
      </div>
      </div>
      {railNav.down && (
        <button className="rail-vnav" onClick={() => scrollRef.current?.scrollBy({ top: 140, behavior: "smooth" })}>
          <ChevronDown size={14} />
        </button>
      )}
    </nav>
  );
}
