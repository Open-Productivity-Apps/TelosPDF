// Selectable text layer: transparent text runs positioned over the page
// raster (PDF.js approach) — native browser selection and Cmd+C just work.
// Runs are horizontally scaled so selection highlights match the glyphs.
import { useEffect, useMemo, useState } from "react";
import { commands, type TextSegmentEntry } from "../telos";

const measureCtx = document.createElement("canvas").getContext("2d")!;

interface Props {
  docId: number;
  rev: number;
  pageIndex: number;
  /** CSS pixels per PDF point at the current zoom. */
  scale: number;
  /** Page height in PDF points (unrotated). */
  pageHeightPt: number;
}

export default function TextLayer({ docId, rev, pageIndex, scale, pageHeightPt }: Props) {
  const [segments, setSegments] = useState<TextSegmentEntry[]>([]);

  useEffect(() => {
    let alive = true;
    // Small settle delay: while scrolling flies past pages, their text
    // layers come and go — don't pay the fetch+measure for page flybys.
    const timer = setTimeout(() => {
      commands.getTextSegments(docId, pageIndex).then(
        (s) => alive && setSegments(s),
        () => alive && setSegments([]),
      );
    }, 160);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [docId, rev, pageIndex]);

  const spans = useMemo(
    () =>
      segments.map((segment, i) => {
        const [x, y, w, h] = segment.bounds;
        const fontSize = Math.max(h * scale, 1);
        measureCtx.font = `${fontSize}px sans-serif`;
        const measured = measureCtx.measureText(segment.text).width;
        const scaleX = measured > 0 ? (w * scale) / measured : 1;
        return (
          <span
            key={`${rev}-${i}`}
            style={{
              left: x * scale,
              top: (pageHeightPt - y - h) * scale,
              fontSize,
              transform: `scaleX(${scaleX})`,
            }}
          >
            {segment.text}
          </span>
        );
      }),
    [segments, scale, pageHeightPt, rev],
  );

  return <div className="text-layer">{spans}</div>;
}
