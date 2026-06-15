// Markup drawing layer for one page. Pointer gestures create vector shapes,
// freehand ink, or free text boxes, which the backend bakes onto the page via
// PDFium path/text objects. Coordinates convert from overlay pixels to PDF
// points (bottom-left origin) on commit.
import { useRef, useState } from "react";
import { commands } from "../telos";
import { useApp, type OpenDoc } from "../store";

export type MarkupTool = "draw" | "rect" | "ellipse" | "line" | "arrow" | "text";

export interface MarkupStyle {
  tool: MarkupTool;
  color: [number, number, number];
  fill: boolean;
  strokeWidth: number;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  strike: boolean;
}

const css = (c: [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const cssA = (c: [number, number, number], a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

export default function MarkupLayer({
  doc,
  pageIndex,
  scale,
  pageHeightPt,
  style,
}: {
  doc: OpenDoc;
  pageIndex: number;
  scale: number;
  pageHeightPt: number;
  style: MarkupStyle;
}) {
  const updateInfo = useApp((s) => s.updateInfo);
  const showToast = useApp((s) => s.showToast);
  const { id, title } = doc.info;
  const ref = useRef<HTMLDivElement>(null);
  // In-progress gesture, in overlay-pixel coordinates.
  const [start, setStart] = useState<[number, number] | null>(null);
  const [cur, setCur] = useState<[number, number] | null>(null);
  const [ink, setInk] = useState<[number, number][]>([]);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<{ x: number; y: number; value: string } | null>(null);

  const toPt = (px: number, py: number): [number, number] => [px / scale, pageHeightPt - py / scale];
  const rel = (e: React.PointerEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onDown = (e: React.PointerEvent) => {
    if (busy || text || e.button !== 0) return;
    const p = rel(e);
    if (style.tool === "text") {
      setText({ x: p[0], y: p[1], value: "" });
      return;
    }
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setStart(p);
    setCur(p);
    if (style.tool === "draw") setInk([p]);
  };

  const onMove = (e: React.PointerEvent) => {
    if (!start) return;
    const p = rel(e);
    setCur(p);
    if (style.tool === "draw") setInk((pts) => [...pts, p]);
  };

  const onUp = async () => {
    if (!start || !cur) {
      setStart(null);
      setCur(null);
      return;
    }
    const s = start;
    const c = cur;
    const strokePts = ink;
    setStart(null);
    setCur(null);
    setInk([]);
    // The text tool commits from its input box, not on pointer-up.
    if (style.tool === "text") return;
    // Ignore a stray click (no real drag) for shape tools.
    if (style.tool !== "draw" && Math.hypot(c[0] - s[0], c[1] - s[1]) < 3) return;
    setBusy(true);
    try {
      if (style.tool === "draw") {
        const path = (strokePts.length > 1 ? strokePts : [s, c]).map(([x, y]) => toPt(x, y));
        updateInfo(
          await commands.addInk(id, pageIndex, [path], style.color, style.strokeWidth, title),
          pageIndex,
        );
      } else {
        const [x1, y1] = toPt(s[0], s[1]);
        const [x2, y2] = toPt(c[0], c[1]);
        updateInfo(
          await commands.addShape(
            id,
            pageIndex,
            style.tool,
            x1,
            y1,
            x2,
            y2,
            style.color,
            style.fill && (style.tool === "rect" || style.tool === "ellipse") ? style.color : null,
            style.strokeWidth,
            title,
          ),
          pageIndex,
        );
      }
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const commitText = async () => {
    if (!text) return;
    const t = text;
    setText(null);
    if (!t.value.trim()) return;
    const [xPt] = toPt(t.x, t.y);
    // Drop the baseline below the click by the ascent so the click sits near
    // the top of the text.
    const yPt = pageHeightPt - t.y / scale - style.fontSize * 0.85;
    setBusy(true);
    try {
      updateInfo(
        await commands.addTextBox(
          id,
          pageIndex,
          xPt,
          yPt,
          t.value,
          style.fontSize,
          style.color,
          style.bold,
          style.italic,
          style.strike,
          title,
        ),
        pageIndex,
      );
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const sw = Math.max(style.strokeWidth * scale, 1);
  const preview = () => {
    if (!start || !cur) return null;
    const [sx, sy] = start;
    const [cx, cy] = cur;
    const stroke = css(style.color);
    const fill = style.fill ? cssA(style.color, 0.3) : "none";
    if (style.tool === "draw") {
      return <polyline points={ink.map((p) => p.join(",")).join(" ")} fill="none" stroke={stroke} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" />;
    }
    if (style.tool === "rect") {
      return <rect x={Math.min(sx, cx)} y={Math.min(sy, cy)} width={Math.abs(cx - sx)} height={Math.abs(cy - sy)} fill={fill} stroke={stroke} strokeWidth={sw} />;
    }
    if (style.tool === "ellipse") {
      return <ellipse cx={(sx + cx) / 2} cy={(sy + cy) / 2} rx={Math.abs(cx - sx) / 2} ry={Math.abs(cy - sy) / 2} fill={fill} stroke={stroke} strokeWidth={sw} />;
    }
    // line / arrow
    return (
      <>
        <line x1={sx} y1={sy} x2={cx} y2={cy} stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
        {style.tool === "arrow" &&
          (() => {
            const ang = Math.atan2(cy - sy, cx - sx);
            const len = Math.max(style.strokeWidth * scale * 4, 10);
            const b = 0.5;
            return (
              <>
                <line x1={cx} y1={cy} x2={cx - len * Math.cos(ang - b)} y2={cy - len * Math.sin(ang - b)} stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
                <line x1={cx} y1={cy} x2={cx - len * Math.cos(ang + b)} y2={cy - len * Math.sin(ang + b)} stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
              </>
            );
          })()}
      </>
    );
  };

  return (
    <div
      ref={ref}
      className={`markup-overlay ${style.tool === "text" ? "text" : ""}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={() => void onUp()}
    >
      {(start || ink.length > 0) && <svg className="markup-svg">{preview()}</svg>}
      {text && (
        <div className="markup-textbox" style={{ left: text.x, top: text.y }} onPointerDown={(e) => e.stopPropagation()}>
          <textarea
            autoFocus
            rows={2}
            placeholder="Type text…"
            value={text.value}
            style={{
              color: css(style.color),
              fontSize: Math.max(style.fontSize * scale, 9),
              fontWeight: style.bold ? 700 : 400,
              fontStyle: style.italic ? "italic" : "normal",
              textDecoration: style.strike ? "line-through" : "none",
            }}
            onChange={(e) => setText({ ...text, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") setText(null);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commitText();
            }}
          />
          <div className="markup-textbox-actions">
            <button className="modal-primary" onClick={() => void commitText()}>
              Add
            </button>
            <button className="modal-secondary" onClick={() => setText(null)}>
              Cancel
            </button>
            <span className="markup-hint">⌘↵ to add</span>
          </div>
        </div>
      )}
    </div>
  );
}
