// Redact overlay for one page: drag to mark rectangles. Marks are held in
// shared state until Apply flattens every marked page to a blacked-out
// image (Viewer owns Apply). Bottom-left PDF-point coords.
import { useRef, useState } from "react";
import { useApp } from "../store";

export interface RedactRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  pageIndex: number;
  scale: number;
  pageHeightPt: number;
}

export default function RedactLayer({ pageIndex, scale, pageHeightPt }: Props) {
  const marks = useApp((s) => s.redactMarks);
  const addMark = useApp((s) => s.addRedactMark);
  const removeMark = useApp((s) => s.removeRedactMark);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );
  const origin = useRef<[number, number]>([0, 0]);

  const toPt = (clientX: number, clientY: number, rect: DOMRect) => [
    (clientX - rect.left) / scale,
    pageHeightPt - (clientY - rect.top) / scale,
  ];

  return (
    <div
      className="redact-layer"
      onMouseDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        origin.current = [e.clientX - rect.left, e.clientY - rect.top];
        setDraft({ x0: origin.current[0], y0: origin.current[1], x1: origin.current[0], y1: origin.current[1] });
      }}
      onMouseMove={(e) => {
        if (!draft) return;
        const rect = e.currentTarget.getBoundingClientRect();
        setDraft({ ...draft, x1: e.clientX - rect.left, y1: e.clientY - rect.top });
      }}
      onMouseUp={(e) => {
        if (!draft) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const [ax, ay] = toPt(rect.left + Math.min(draft.x0, draft.x1), rect.top + Math.max(draft.y0, draft.y1), rect);
        const [bx, by] = toPt(rect.left + Math.max(draft.x0, draft.x1), rect.top + Math.min(draft.y0, draft.y1), rect);
        setDraft(null);
        const w = Math.abs(bx - ax);
        const h = Math.abs(by - ay);
        if (w > 3 && h > 3) addMark({ page: pageIndex, x: Math.min(ax, bx), y: Math.min(ay, by), w, h });
      }}
    >
      {marks
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => m.page === pageIndex)
        .map(({ m, i }) => (
          <div
            key={i}
            className="redact-mark"
            style={{
              left: m.x * scale,
              top: (pageHeightPt - m.y - m.h) * scale,
              width: m.w * scale,
              height: m.h * scale,
            }}
            title="Click to remove this mark"
            onClick={(e) => {
              e.stopPropagation();
              removeMark(i);
            }}
          />
        ))}
      {draft && (
        <div
          className="redact-mark draft"
          style={{
            left: Math.min(draft.x0, draft.x1),
            top: Math.min(draft.y0, draft.y1),
            width: Math.abs(draft.x1 - draft.x0),
            height: Math.abs(draft.y1 - draft.y0),
          }}
        />
      )}
    </div>
  );
}
