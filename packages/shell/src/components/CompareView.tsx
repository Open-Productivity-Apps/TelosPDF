// Visual compare tab. A legend names the two files; full-width tabs switch
// between Original, New, and Differences (the changed page with regions that
// differ from the original tinted red). Neither source PDF opens as a normal
// document.
import { useEffect, useState } from "react";
import { compareUrl } from "../telos";
import type { CompareTab } from "../store";

export default function CompareView({ tab }: { tab: CompareTab }) {
  const [width, setWidth] = useState(720);
  const [view, setView] = useState<"a" | "b" | "diff">("diff");

  useEffect(() => {
    const el = document.querySelector<HTMLDivElement>(".compare-pages");
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(Math.max(320, Math.min(el.clientWidth - 48, 1100)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="compare-view">
      <div className="compare-legend">
        <span>
          Comparing <b>{tab.nameA}</b> (original) → <b>{tab.nameB}</b> (new)
        </span>
        {view === "diff" && (
          <span className="compare-key">
            <span className="compare-swatch" /> highlighted = changed
          </span>
        )}
      </div>
      <div className="compare-tabs">
        <button className={view === "a" ? "active" : ""} onClick={() => setView("a")}>
          Original
        </button>
        <button className={view === "b" ? "active" : ""} onClick={() => setView("b")}>
          New
        </button>
        <button className={view === "diff" ? "active" : ""} onClick={() => setView("diff")}>
          Differences
        </button>
      </div>
      <div className="compare-pages">
        {Array.from({ length: tab.pages }, (_, i) => (
          <div key={`${view}-${i}`} className="compare-page-slot">
            <div className="compare-page-label">Page {i + 1}</div>
            <img
              className="compare-page"
              src={compareUrl(tab.id, i, Math.round(width * 2), view)}
              style={{ width }}
              loading="lazy"
              alt={`Page ${i + 1}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
