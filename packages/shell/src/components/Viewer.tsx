// Continuous-scroll page viewer. Pages arrive as PNGs over telos:// (the
// webview never touches PDF bytes); fit modes derive the effective zoom from
// the container size; an IntersectionObserver tracks the current page.
import { t, useLocale } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bold,
  Circle,
  EyeOff,
  FileText,
  Italic,
  MessageSquareText,
  Minus,
  Pencil,
  PenLine,
  Save,
  Square,
  Stamp,
  Strikethrough,
  Type,
  TypeOutline,
} from "lucide-react";
import EditOverlay from "./EditOverlay";
import FormLayer from "./FormLayer";
import MarkupLayer, { type MarkupStyle, type MarkupTool } from "./MarkupLayer";
import RedactLayer from "./RedactLayer";
import SignatureModal from "./SignatureModal";
import SearchBar from "./SearchBar";
import TextLayer from "./TextLayer";
import { commands, pageUrl, type CommentEntry } from "../telos";
import { useActiveDoc, useApp, type PendingPlacement } from "../store";

// Strong colours for markup (distinct from the softer sticky-note palette).
const MARKUP_COLORS: [number, number, number][] = [
  [229, 57, 53], // red
  [251, 192, 45], // yellow
  [67, 160, 71], // green
  [30, 136, 229], // blue
  [142, 36, 170], // purple
  [33, 33, 33], // near-black
];
const MARKUP_TOOLS: { id: MarkupTool; label: string; Icon: typeof Square }[] = [
  { id: "draw", label: "Draw (freehand)", Icon: Pencil },
  { id: "rect", label: "Rectangle", Icon: Square },
  { id: "ellipse", label: "Ellipse", Icon: Circle },
  { id: "line", label: "Line", Icon: Minus },
  { id: "arrow", label: "Arrow", Icon: ArrowUpRight },
  { id: "text", label: "Text box", Icon: Type },
];

const PT_TO_PX = 96 / 72;
const VIEWER_PADDING = 48;

export default function Viewer() {
  useLocale();
  const doc = useActiveDoc();
  const fitMode = useApp((s) => s.fitMode);
  const zoom = useApp((s) => s.zoom);
  const setEffectiveZoom = useApp((s) => s.setEffectiveZoom);
  const setCurrentPage = useApp((s) => s.setCurrentPage);
  const scrollRequest = useApp((s) => s.scrollRequest);
  const open = useApp((s) => s.open);
  const editMode = useApp((s) => s.editMode);
  const setEditMode = useApp((s) => s.setEditMode);
  const fillMode = useApp((s) => s.fillMode);
  const setFillMode = useApp((s) => s.setFillMode);
  const redactMode = useApp((s) => s.redactMode);
  const setRedactMode = useApp((s) => s.setRedactMode);
  const redactMarks = useApp((s) => s.redactMarks);
  const clearRedactMarks = useApp((s) => s.clearRedactMarks);
  const markupMode = useApp((s) => s.markupMode);
  const setMarkupMode = useApp((s) => s.setMarkupMode);
  const [redacting, setRedacting] = useState(false);
  // Markup tool + style (shared by the toolbar and every page's MarkupLayer).
  const [mTool, setMTool] = useState<MarkupTool>("draw");
  const [mColor, setMColor] = useState<[number, number, number]>(MARKUP_COLORS[0]);
  const [mFill, setMFill] = useState(false);
  const [mStroke, setMStroke] = useState(2);
  const [mSize, setMSize] = useState(16);
  const [mBold, setMBold] = useState(false);
  const [mItalic, setMItalic] = useState(false);
  const [mStrike, setMStrike] = useState(false);
  const markupStyle: MarkupStyle = {
    tool: mTool,
    color: mColor,
    fill: mFill,
    strokeWidth: mStroke,
    fontSize: mSize,
    bold: mBold,
    italic: mItalic,
    strike: mStrike,
  };
  const updateInfo = useApp((s) => s.updateInfo);
  const showToast = useApp((s) => s.showToast);
  const [signatureModal, setSignatureModal] = useState(false);
  const [placingSignature, setPlacingSignature] = useState<string | null>(null);
  const [stampMenu, setStampMenu] = useState(false);
  const [placingStamp, setPlacingStamp] = useState<{ text: string; rgb: [number, number, number] } | null>(null);
  const pendingPlacements = useApp((s) => s.pendingPlacements);
  const [committing, setCommitting] = useState(false);

  // Fill & Sign: ⌘Z removes the last unsaved placement; leaving the mode
  // discards whatever wasn't saved. Capture phase so the document-history
  // undo doesn't also fire.
  useEffect(() => {
    if (!fillMode) {
      useApp.getState().clearPlacements();
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation();
        useApp.getState().undoPlacement();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fillMode]);
  const searchOpen = useApp((s) => s.searchOpen);
  const searchHits = useApp((s) => s.searchHits);
  const searchCurrent = useApp((s) => s.searchCurrent);
  const focusComment = useApp((s) => s.focusComment);
  const [addingText, setAddingText] = useState(false);
  const [comments, setComments] = useState<CommentEntry[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<[number, number]>([0, 0]);

  useEffect(() => {
    if (!editMode) setAddingText(false);
  }, [editMode]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Settle-debounced: live window resizing would otherwise re-layout and
    // re-render every visible page dozens of times per second.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setContainerSize([el.clientWidth, el.clientHeight]), 120);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  }, []);

  // Trackpad pinch (reported as ctrlKey+wheel) and Cmd/Ctrl+wheel zoom.
  // During the gesture only a GPU transform on the page stack changes
  // (cheap); the real zoom — which relays out and re-renders pages — is
  // committed once, ~150ms after the gesture settles.
  const pagesWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let pending = 1;
    let raf = 0;
    let commitTimer: ReturnType<typeof setTimeout> | undefined;
    const commit = () => {
      const wrap = pagesWrapRef.current;
      const s = useApp.getState();
      const current = s.fitMode === "custom" ? s.zoom : s.effectiveZoom;
      s.setZoomValue(current * pending);
      pending = 1;
      if (wrap) {
        wrap.style.transform = "";
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      pending = Math.min(8, Math.max(0.1, pending * Math.exp(-e.deltaY * 0.005)));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const wrap = pagesWrapRef.current;
        if (wrap) {
          wrap.style.transformOrigin = "top center";
          wrap.style.transform = `scale(${pending})`;
        }
      });
      clearTimeout(commitTimer);
      commitTimer = setTimeout(commit, 150);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      cancelAnimationFrame(raf);
      clearTimeout(commitTimer);
    };
  }, []);

  // Drag-to-pan with the mouse (disabled in edit mode, where clicks select).
  // Move/up listeners attach only for the duration of a pan — a permanent
  // window mousemove handler taxes every pointer movement.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let last: [number, number] = [0, 0];
    const onMove = (e: MouseEvent) => {
      el.scrollLeft -= e.clientX - last[0];
      el.scrollTop -= e.clientY - last[1];
      last = [e.clientX, e.clientY];
    };
    const onUp = () => {
      el.classList.remove("panning");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || useApp.getState().editMode || useApp.getState().markupMode) return;
      const target = e.target as HTMLElement;
      // Text-layer drags are selections, not pans.
      if (target.closest("button, input, textarea, .object-editor, .text-layer")) return;
      last = [e.clientX, e.clientY];
      el.classList.add("panning");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
    el.addEventListener("mousedown", onDown);
    return () => {
      el.removeEventListener("mousedown", onDown);
      onUp();
    };
  }, []);

  // Comment markers: one fetch per document revision.
  const markerDocId = doc?.info.id;
  const markerRev = doc?.info.rev;
  useEffect(() => {
    setComments([]);
    if (markerDocId == null) return;
    let alive = true;
    commands.getComments(markerDocId).then(
      (list) => alive && setComments(list.filter((c) => c.bounds[2] > 0)),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [markerDocId, markerRev]);

  const commentsByPage = useMemo(() => {
    const map = new Map<number, CommentEntry[]>();
    for (const c of comments) {
      const list = map.get(c.pageIndex) ?? [];
      list.push(c);
      map.set(c.pageIndex, list);
    }
    return map;
  }, [comments]);

  // Rotation swaps the layout aspect for 90°/270°.
  const rotated = doc ? doc.viewRotation % 180 !== 0 : false;
  const layoutSizes = useMemo(() => {
    if (!doc) return [];
    return doc.info.sizes.map(([w, h]) => (rotated ? [h, w] : [w, h]) as [number, number]);
  }, [doc, rotated]);

  // Effective zoom from the fit mode, keyed to the widest page.
  const effectiveZoom = useMemo(() => {
    if (!doc || layoutSizes.length === 0) return 1;
    const [cw, ch] = containerSize;
    const maxW = Math.max(...layoutSizes.map(([w]) => w)) * PT_TO_PX;
    const maxH = Math.max(...layoutSizes.map(([, h]) => h)) * PT_TO_PX;
    switch (fitMode) {
      case "fit-width":
        return cw > 0 ? Math.max(0.1, (cw - VIEWER_PADDING) / maxW) : 1;
      case "fit-page":
        return cw > 0 && ch > 0
          ? Math.max(0.1, Math.min((cw - VIEWER_PADDING) / maxW, (ch - VIEWER_PADDING) / maxH))
          : 1;
      case "actual":
        return 1;
      default:
        return zoom;
    }
  }, [doc, layoutSizes, containerSize, fitMode, zoom]);

  useEffect(() => setEffectiveZoom(effectiveZoom), [effectiveZoom, setEffectiveZoom]);

  // Current-page tracking.
  const docId = doc?.info.id;
  useEffect(() => {
    const container = containerRef.current;
    if (!container || docId == null) return;
    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.page);
          ratios.set(idx, entry.intersectionRatio);
        }
        let best = 0;
        let bestRatio = -1;
        for (const [idx, ratio] of ratios) {
          if (ratio > bestRatio) {
            best = idx;
            bestRatio = ratio;
          }
        }
        if (bestRatio > 0) setCurrentPage(docId, best);
      },
      { root: container, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    container.querySelectorAll(".page-slot").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [docId, doc?.info.rev, doc?.info.pages, setCurrentPage]);

  // Scroll-to-page requests (from the page input / panels).
  useEffect(() => {
    if (!scrollRequest) return;
    containerRef.current
      ?.querySelector(`.page-slot[data-page="${scrollRequest.page}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [scrollRequest]);

  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  // Quantize render widths into geometric buckets (~30% apart) and let CSS
  // scale in between: continuous zoom stays responsive because the same
  // rendered bitmap is reused until the next bucket, instead of asking
  // PDFium for a fresh render on every wheel tick.
  const quantizeWidth = (px: number) => {
    const bucket = Math.round(Math.log(Math.max(px, 100) / 100) / Math.log(1.3));
    return Math.min(Math.round(100 * Math.pow(1.3, bucket)), 4096);
  };

  const openCb = useCallback(() => void open(), [open]);

  if (!doc) {
    return (
      <div className="viewer" ref={containerRef}>
        <div className="viewer-empty">
          <FileText size={48} strokeWidth={1} />
          <p>No document open</p>
          <button onClick={openCb}>Open a PDF</button>
        </div>
      </div>
    );
  }

  const editableHere = editMode && doc.info.editable && doc.viewRotation === 0;

  return (
    <>
      {searchOpen && <SearchBar />}
      {redactMode && (
        <div className="edit-toolbar">
          <span className="editor-hint">
            <EyeOff size={15} /> {t("Drag to mark regions · click a mark to remove")} ·{" "}
            {redactMarks.length} marked
          </span>
          <div className="spacer" />
          <button
            className="edit-tool danger"
            disabled={redactMarks.length === 0 || redacting}
            onClick={() => {
              const d = useApp.getState().docs.find((x) => x.info.id === useApp.getState().activeId);
              if (!d) return;
              setRedacting(true);
              void commands
                .redactDocument(
                  d.info.id,
                  redactMarks.map((m) => [m.page, m.x, m.y, m.w, m.h]),
                  d.info.title,
                )
                .then((next) => {
                  updateInfo(next);
                  clearRedactMarks();
                  showToast("Redactions applied — content permanently removed.");
                })
                .catch((e) => showToast(String(e)))
                .finally(() => setRedacting(false));
            }}
          >
            {redacting ? t("Applying…") : t("Apply redactions")}
          </button>
          <button
            className="edit-tool save-btn"
            onClick={() => void useApp.getState().save().finally(() => setRedactMode(false))}
          >
            <Save size={15} /> {t("Save")}
          </button>
        </div>
      )}
      {fillMode && (
        <div className="edit-toolbar">
          <button
            className={`edit-tool ${placingSignature ? "active" : ""}`}
            onClick={() => setSignatureModal(true)}
          >
            <PenLine size={15} /> {t("Add signature")}
          </button>
          <div className="tab-create">
            <button
              className={`edit-tool ${stampMenu || placingStamp ? "active" : ""}`}
              onClick={() => setStampMenu((v) => !v)}
            >
              <Stamp size={15} /> {t("Stamp")}
            </button>
            {stampMenu && (
              <div className="dropdown">
                {(
                  [
                    ["APPROVED", [22, 138, 61]],
                    ["REJECTED", [204, 44, 44]],
                    ["DRAFT", [120, 120, 124]],
                    ["CONFIDENTIAL", [204, 44, 44]],
                    ["SIGN HERE", [38, 97, 209]],
                    ["COMPLETED", [22, 138, 61]],
                  ] as [string, [number, number, number]][]
                ).map(([text, rgb]) => (
                  <button
                    key={text}
                    style={{ color: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`, fontWeight: 700 }}
                    onClick={() => {
                      setStampMenu(false);
                      setPlacingStamp({ text, rgb });
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="editor-hint">
            {placingSignature
              ? t("Click on the page to place your signature.")
              : placingStamp
                ? `Click on the page to place “${placingStamp.text}”.`
                : pendingPlacements.length > 0
                  ? t("Drag placed items to move them · ⌘Z removes the last · Save bakes them in.")
                  : t("Type into fields, click checkboxes — values save into the form.")}
          </span>
          <div className="spacer" />
          <button
            className="edit-tool save-btn"
            disabled={committing}
            onClick={() => {
              setPlacingSignature(null);
              setPlacingStamp(null);
              setStampMenu(false);
              setCommitting(true);
              void (async () => {
                const app = useApp.getState();
                const pend = app.pendingPlacements.filter((p) => p.docId === doc.info.id);
                try {
                  for (const p of pend) {
                    const next =
                      p.kind === "signature"
                        ? await commands.placeImage(doc.info.id, p.page, p.x, p.y, 150, p.dataUrl!, doc.info.title)
                        : await commands.placeStamp(doc.info.id, p.page, p.x, p.y, p.text!, 28, p.rgb!, doc.info.title);
                    updateInfo(next, p.page);
                    useApp.setState((s) => ({
                      pendingPlacements: s.pendingPlacements.filter((x) => x.id !== p.id),
                    }));
                  }
                  app.logPlaced(
                    pend.map((p) => ({
                      docId: p.docId,
                      page: p.page,
                      kind: p.kind,
                      label: p.kind === "stamp" ? p.text ?? "Stamp" : "Signature",
                      time: Date.now(),
                    })),
                  );
                  await app.save();
                  setFillMode(false);
                } catch (e) {
                  showToast(String(e));
                } finally {
                  setCommitting(false);
                }
              })();
            }}
          >
            <Save size={15} /> {committing ? t("Saving…") : t("Save")}
          </button>
        </div>
      )}
      {signatureModal && (
        <SignatureModal
          onClose={() => setSignatureModal(false)}
          onUse={(dataUrl) => {
            setSignatureModal(false);
            setPlacingSignature(dataUrl);
          }}
        />
      )}
      {editMode && (
        <div className="edit-toolbar">
          <button
            className={`edit-tool ${addingText ? "active" : ""}`}
            onClick={() => setAddingText((v) => !v)}
            disabled={!editableHere}
          >
            <TypeOutline size={15} /> {t("Add text")}
          </button>
          <span className="editor-hint">
            {doc.viewRotation !== 0
              ? t("Reset the view rotation to edit.")
              : addingText
                ? t("Click on the page to place the text.")
                : t("Click any object on the current page to edit or delete it.")}
          </span>
          <div className="spacer" />
          <button
            className="edit-tool save-btn"
            onClick={() => void useApp.getState().save().finally(() => setEditMode(false))}
          >
            <Save size={15} /> {t("Save")}
          </button>
        </div>
      )}
      {markupMode && (
        <div className="edit-toolbar">
          {MARKUP_TOOLS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`edit-tool ${mTool === id ? "active" : ""}`}
              title={label}
              onClick={() => setMTool(id)}
            >
              <Icon size={15} />
            </button>
          ))}
          <div className="swatch-row">
            {MARKUP_COLORS.map((c, ci) => (
              <button
                key={ci}
                className={`swatch ${mColor === c ? "on" : ""}`}
                style={{ background: `rgb(${c[0]}, ${c[1]}, ${c[2]})` }}
                title="Colour"
                onClick={() => setMColor(c)}
              />
            ))}
          </div>
          {mTool === "text" ? (
            <>
              <select
                title="Font size"
                value={mSize}
                onChange={(e) => setMSize(Number(e.target.value))}
              >
                {[10, 12, 14, 16, 20, 24, 32, 48].map((n) => (
                  <option key={n} value={n}>
                    {n} pt
                  </option>
                ))}
              </select>
              <button
                className={`edit-tool ${mBold ? "active" : ""}`}
                title="Bold"
                onClick={() => setMBold((v) => !v)}
              >
                <Bold size={15} />
              </button>
              <button
                className={`edit-tool ${mItalic ? "active" : ""}`}
                title="Italic"
                onClick={() => setMItalic((v) => !v)}
              >
                <Italic size={15} />
              </button>
              <button
                className={`edit-tool ${mStrike ? "active" : ""}`}
                title="Strikethrough"
                onClick={() => setMStrike((v) => !v)}
              >
                <Strikethrough size={15} />
              </button>
            </>
          ) : (
            <>
              <select
                title="Stroke width"
                value={mStroke}
                onChange={(e) => setMStroke(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n} pt
                  </option>
                ))}
              </select>
              {(mTool === "rect" || mTool === "ellipse") && (
                <button
                  className={`edit-tool ${mFill ? "active" : ""}`}
                  onClick={() => setMFill((v) => !v)}
                >
                  {t("Fill")}
                </button>
              )}
            </>
          )}
          <span className="editor-hint">
            {doc.viewRotation !== 0
              ? t("Reset the view rotation to mark up.")
              : mTool === "text"
                ? t("Click on the page to place a text box.")
                : t("Drag on the page to draw — marks are baked into the PDF.")}
          </span>
          <div className="spacer" />
          <button
            className="edit-tool save-btn"
            onClick={() => void useApp.getState().save().finally(() => setMarkupMode(false))}
          >
            <Save size={15} /> {t("Save")}
          </button>
        </div>
      )}
      <div className="viewer" ref={containerRef}>
        <div className="pages-wrap" ref={pagesWrapRef}>
        {layoutSizes.map(([w, h], i) => {
          const cssW = Math.round(w * PT_TO_PX * effectiveZoom);
          const cssH = Math.round((h / w) * cssW);
          // The backend's width param applies before view rotation, so for
          // 90°/270° the pre-rotation width is this slot's height.
          const renderW = quantizeWidth((rotated ? cssH : cssW) * dpr);
          const distance = Math.abs(i - doc.currentPage);
          const nearViewport = distance <= 4;
          const isCurrent = i === doc.currentPage;
          return (
            <div key={`${doc.info.id}-${i}`} className="page-slot" data-page={i}>
              <div
                className="page-frame"
                style={{ width: cssW, height: cssH }}
                data-loading={t("Loading…")}
              >
                {nearViewport && (
                  <img
                    className="page"
                    src={pageUrl(
                      doc.info.id,
                      i,
                      renderW,
                      doc.pageRevs[i] ?? doc.info.rev,
                      doc.viewRotation,
                    )}
                    width={cssW}
                    height={cssH}
                    // Visible page fetches first; neighbours are prefetch.
                    fetchPriority={isCurrent ? "high" : "low"}
                    onLoad={(e) => e.currentTarget.classList.add("ready")}
                    alt={`Page ${i + 1}`}
                  />
                )}
                {!editMode &&
                  doc.viewRotation === 0 &&
                  Math.abs(i - doc.currentPage) <= 1 && (
                    <TextLayer
                      docId={doc.info.id}
                      rev={doc.pageRevs[i] ?? doc.info.rev}
                      pageIndex={i}
                      scale={cssW / w}
                      pageHeightPt={h}
                    />
                  )}
                {searchHits.length > 0 &&
                  doc.viewRotation === 0 &&
                  searchHits.some((hit) => hit.pageIndex === i) && (
                    <div className="search-layer">
                      {searchHits.map((hit, hi) =>
                        hit.pageIndex === i
                          ? hit.rects.map(([x, y, rw, rh], ri) => (
                              <div
                                key={`${hi}-${ri}`}
                                className={`search-highlight ${hi === searchCurrent ? "current" : ""}`}
                                style={{
                                  left: x * (cssW / w),
                                  top: (h - y - rh) * (cssW / w),
                                  width: Math.max(rw * (cssW / w), 2),
                                  height: Math.max(rh * (cssW / w), 2),
                                }}
                              />
                            ))
                          : null,
                      )}
                    </div>
                  )}
                {!editMode &&
                  doc.viewRotation === 0 &&
                  (commentsByPage.get(i) ?? []).map((c, ci) =>
                    true ? (
                      <button
                        key={`marker-${ci}`}
                        className="comment-marker"
                        style={{
                          left: c.bounds[0] * (cssW / w),
                          top: (h - c.bounds[1] - c.bounds[3]) * (cssW / w),
                          width: Math.max(c.bounds[2] * (cssW / w), 14),
                          height: Math.max(c.bounds[3] * (cssW / w), 14),
                          ["--marker" as string]: c.color
                            ? `rgb(${c.color[0]}, ${c.color[1]}, ${c.color[2]})`
                            : undefined,
                        }}
                        onClick={() =>
                          c.id && focusComment(`${c.id[0]}-${c.id[1]}`, c.pageIndex)
                        }
                      >
                        <span className="comment-tooltip">
                          <span className="comment-tooltip-author">
                            <MessageSquareText size={11} /> {c.author || "Unknown"}
                          </span>
                          {c.contents.length > 160
                            ? `${c.contents.slice(0, 160)}…`
                            : c.contents}
                        </span>
                      </button>
                    ) : null,
                  )}
                {fillMode &&
                  doc.viewRotation === 0 &&
                  Math.abs(i - doc.currentPage) <= 2 && (
                    <FormLayer
                      docId={doc.info.id}
                      rev={doc.pageRevs[i] ?? doc.info.rev}
                      title={doc.info.title}
                      pageIndex={i}
                      scale={cssW / w}
                      pageHeightPt={h}
                    />
                  )}
                {redactMode &&
                  doc.viewRotation === 0 &&
                  Math.abs(i - doc.currentPage) <= 2 && (
                    <RedactLayer pageIndex={i} scale={cssW / w} pageHeightPt={h} />
                  )}
                {markupMode &&
                  doc.viewRotation === 0 &&
                  Math.abs(i - doc.currentPage) <= 2 && (
                    <MarkupLayer
                      doc={doc}
                      pageIndex={i}
                      scale={cssW / w}
                      pageHeightPt={h}
                      style={markupStyle}
                    />
                  )}
                {(placingSignature || placingStamp) && (
                  <div
                    className="signature-place-layer"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const xPt = (e.clientX - rect.left) / (cssW / w);
                      const yPt = h - (e.clientY - rect.top) / (cssW / w);
                      // Placements stay as movable overlays until Save bakes
                      // them into the PDF.
                      if (placingSignature) {
                        useApp.getState().addPlacement({
                          docId: doc.info.id,
                          page: i,
                          x: xPt,
                          y: yPt,
                          kind: "signature",
                          dataUrl: placingSignature,
                        });
                        setPlacingSignature(null);
                      } else if (placingStamp) {
                        useApp.getState().addPlacement({
                          docId: doc.info.id,
                          page: i,
                          x: xPt,
                          y: yPt,
                          kind: "stamp",
                          text: placingStamp.text,
                          rgb: placingStamp.rgb,
                        });
                        setPlacingStamp(null);
                      }
                    }}
                  />
                )}
                {fillMode &&
                  pendingPlacements.some((p) => p.docId === doc.info.id && p.page === i) && (
                    <div className="pending-layer">
                      {pendingPlacements
                        .filter((p) => p.docId === doc.info.id && p.page === i)
                        .map((p) => (
                          <PendingItem key={p.id} p={p} scale={cssW / w} pageHeightPt={h} />
                        ))}
                    </div>
                  )}
                {editableHere && i === doc.currentPage && (
                  <EditOverlay
                    doc={doc}
                    pageIndex={i}
                    scale={cssW / w}
                    pageHeightPt={h}
                    addingText={addingText}
                    onTextPlaced={() => setAddingText(false)}
                  />
                )}
              </div>
            </div>
          );
        })}
        </div>
      </div>
    </>
  );
}

/** One unsaved Fill & Sign placement: rendered over the page, draggable. */
function PendingItem({
  p,
  scale,
  pageHeightPt,
}: {
  p: PendingPlacement;
  scale: number;
  pageHeightPt: number;
}) {
  const movePlacement = useApp((s) => s.movePlacement);
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = p.x;
    const oy = p.y;
    const onMove = (ev: PointerEvent) => {
      movePlacement(p.id, ox + (ev.clientX - startX) / scale, oy - (ev.clientY - startY) / scale);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const pos: React.CSSProperties = { left: p.x * scale, top: (pageHeightPt - p.y) * scale };
  return p.kind === "signature" ? (
    <img
      className="pending-item"
      src={p.dataUrl}
      style={{ ...pos, width: 150 * scale }}
      onPointerDown={onPointerDown}
      draggable={false}
      alt="Unsaved signature"
    />
  ) : (
    <span
      className="pending-item pending-stamp"
      style={{
        ...pos,
        fontSize: 28 * scale,
        color: p.rgb ? `rgb(${p.rgb[0]}, ${p.rgb[1]}, ${p.rgb[2]})` : undefined,
      }}
      onPointerDown={onPointerDown}
    >
      {p.text}
    </span>
  );
}
