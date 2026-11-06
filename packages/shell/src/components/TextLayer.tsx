// Selectable text layer: transparent words positioned over the page raster
// (PDF.js approach) — native browser selection just works. One span per word
// keeps a partial-line highlight on the glyphs. Each span is scaled to its
// word, and its trailing space is stretched to reach the next word, so a line
// highlights as one level bar.
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { commands, type TextWordEntry } from "../telos";

const measureCtx = document.createElement("canvas").getContext("2d")!;
measureCtx.font = "100px sans-serif";

/** Width in em of `text` in the layer's font. */
const emWidth = (text: string) => measureCtx.measureText(text).width / 100;

// Positioned text gives the browser no flow to follow: mid-drag over blank
// space, a selection would jump to the end of the layer. A filler element
// covers the layer during a selection and rides next to its moving end, so
// blank space resolves to right there instead.
const fillers = new Map<HTMLElement, HTMLElement>();
let dragging = false;
let lastRange: Range | null = null;

function parkFiller(filler: HTMLElement, layer: HTMLElement) {
  layer.append(filler);
  layer.classList.remove("selecting");
}

function parkAll() {
  fillers.forEach(parkFiller);
  lastRange = null;
}

function trackSelection() {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    parkAll();
    return;
  }
  const range = selection.getRangeAt(0);
  fillers.forEach((filler, layer) => {
    if (range.intersectsNode(layer)) layer.classList.add("selecting");
    else parkFiller(filler, layer);
  });
  const startMoved =
    lastRange != null &&
    (range.compareBoundaryPoints(Range.END_TO_END, lastRange) === 0 ||
      range.compareBoundaryPoints(Range.START_TO_END, lastRange) === 0);
  const edge = startMoved ? range.startContainer : range.endContainer;
  const word = edge.nodeType === Node.TEXT_NODE ? edge.parentElement : (edge as HTMLElement);
  const layer = word?.parentElement?.closest<HTMLElement>(".text-layer");
  const filler = layer && fillers.get(layer);
  if (word && layer && filler && word !== filler && word.parentElement === layer) {
    layer.insertBefore(filler, startMoved ? word : word.nextSibling);
  }
  lastRange = range.cloneRange();
}

// The browser's own copy carries the layer's HTML, which pastes into rich
// editors as invisible, absolutely positioned text. Ligature glyphs (ﬁ, ﬂ)
// are expanded so copied words stay searchable.
function copyPlainText(e: ClipboardEvent) {
  const selection = document.getSelection();
  const anchor = selection?.anchorNode;
  const el = anchor instanceof Element ? anchor : anchor?.parentElement;
  if (!selection || selection.isCollapsed || !el?.closest(".pages-wrap")) return;
  const text = selection
    .toString()
    .replace(/\0/g, "")
    .replace(/[ﬀ-ﬆ]/g, (ligature) => ligature.normalize("NFKC"));
  e.clipboardData?.setData("text/plain", text);
  e.preventDefault();
}

let tracking = false;

function startTracking() {
  if (tracking) return;
  tracking = true;
  document.addEventListener("pointerdown", () => {
    dragging = true;
  });
  document.addEventListener("pointerup", () => {
    dragging = false;
    parkAll();
  });
  window.addEventListener("blur", () => {
    dragging = false;
    parkAll();
  });
  document.addEventListener("keyup", () => {
    if (!dragging) parkAll();
  });
  document.addEventListener("selectionchange", trackSelection);
  document.addEventListener("copy", copyPlainText);
}

/** Triple-click selects the line (word spans are separate blocks, so the
 *  browser's own triple-click would stop at one word). */
function selectLine(e: MouseEvent<HTMLDivElement>) {
  if (e.detail !== 3) return;
  const word = (e.target as HTMLElement).closest<HTMLElement>("span[data-line]");
  if (!word) return;
  const line = e.currentTarget.querySelectorAll(`span[data-line="${word.dataset.line}"]`);
  const range = document.createRange();
  range.setStartBefore(line[0]);
  range.setEndAfter(line[line.length - 1]);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

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
  const [words, setWords] = useState<TextWordEntry[]>([]);
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    // Small settle delay: while scrolling flies past pages, their text
    // layers come and go — don't pay the fetch+measure for page flybys.
    const timer = setTimeout(() => {
      commands.getTextWords(docId, pageIndex).then(
        (w) => alive && setWords(w),
        () => alive && setWords([]),
      );
    }, 160);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [docId, rev, pageIndex]);

  useEffect(() => {
    const layer = layerRef.current!;
    const filler = document.createElement("div");
    filler.className = "end-of-content";
    layer.append(filler);
    fillers.set(layer, filler);
    startTracking();
    return () => {
      fillers.delete(layer);
      filler.remove();
    };
  }, []);

  // New spans land after the parked filler; it has to stay last.
  useEffect(() => {
    const layer = layerRef.current!;
    const filler = fillers.get(layer);
    if (filler) layer.append(filler);
  }, [words]);

  // Measured once per fetch: em widths don't change with zoom.
  const measured = useMemo(() => words.map((word) => emWidth(word.text)), [words]);

  const spans = useMemo(() => {
    const spaceEm = emWidth(" ");
    const nodes: ReactNode[] = [];
    words.forEach((word, i) => {
      const [x, y, w, h] = word.bounds;
      const fontSize = Math.max(h * scale, 1);
      const scaleX = measured[i] > 0 ? (w * scale) / (measured[i] * fontSize) : 1;
      const next = words[i + 1];
      const sameLine = next?.line === word.line;
      // Leave wide gaps alone: that's a table column, not a word space.
      const gap = sameLine ? (next.bounds[0] - x - w) * scale : 0;
      const bridged = gap > 0 && gap < fontSize * 3;
      nodes.push(
        <span
          key={`${rev}-${i}`}
          data-line={word.line}
          style={{
            left: x * scale,
            top: (pageHeightPt - y - h) * scale,
            fontSize,
            transform: `scaleX(${scaleX})`,
            wordSpacing: bridged ? gap / scaleX - spaceEm * fontSize : undefined,
          }}
        >
          {sameLine ? `${word.text} ` : word.text}
        </span>,
      );
      if (next && !sameLine) nodes.push(<br key={`${rev}-br-${i}`} />);
    });
    return nodes;
  }, [words, measured, scale, pageHeightPt, rev]);

  return (
    <div ref={layerRef} className="text-layer" onClick={selectLine}>
      {spans}
    </div>
  );
}
