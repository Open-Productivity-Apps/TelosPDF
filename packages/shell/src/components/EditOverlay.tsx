// Edit-PDF overlay for one page: clickable boxes over PDFium page objects,
// inline text editing, object deletion, and click-to-place text.
import { useEffect, useState } from "react";
import { commands, type PageObjectEntry } from "../telos";
import { useApp, type OpenDoc } from "../store";

interface Props {
  doc: OpenDoc;
  pageIndex: number;
  /** CSS pixels per PDF point at the current zoom. */
  scale: number;
  /** Page height in PDF points (unrotated). */
  pageHeightPt: number;
  addingText: boolean;
  onTextPlaced: () => void;
}

export default function EditOverlay({
  doc,
  pageIndex,
  scale,
  pageHeightPt,
  addingText,
  onTextPlaced,
}: Props) {
  const updateInfo = useApp((s) => s.updateInfo);
  const showToast = useApp((s) => s.showToast);
  const [objects, setObjects] = useState<PageObjectEntry[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // Drag-to-move: pixel delta while dragging; committed on mouse-up.
  const [drag, setDrag] = useState<{ index: number; x0: number; y0: number; dx: number; dy: number; moved: boolean } | null>(null);
  // After the drop, keep the box at its new spot until the fresh render
  // arrives — without this the element snaps back for the save round-trip
  // and moving feels laggy.
  const [settling, setSettling] = useState<{ index: number; dx: number; dy: number } | null>(null);
  const [busyOp, setBusyOp] = useState(false);

  const { id, rev, title } = { id: doc.info.id, rev: doc.info.rev, title: doc.info.title };

  useEffect(() => {
    setSelected(null);
    commands.getPageObjects(id, pageIndex).then(
      (list) => {
        setObjects(list);
        setSettling(null);
      },
      () => setObjects([]),
    );
  }, [id, rev, pageIndex]);

  const selectedObject = objects.find((o) => o.index === selected) ?? null;

  const apply = async () => {
    if (selectedObject == null || busyOp) return;
    setBusyOp(true);
    try {
      updateInfo(
        await commands.editTextObject(id, pageIndex, selectedObject.index, draft, title),
        pageIndex,
      );
      setSelected(null);
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusyOp(false);
    }
  };

  const removeObject = async () => {
    if (selectedObject == null) return;
    try {
      updateInfo(
        await commands.deletePageObject(id, pageIndex, selectedObject.index, title),
        pageIndex,
      );
      setSelected(null);
    } catch (e) {
      showToast(String(e));
    }
  };

  const startDrag = (index: number, e: React.MouseEvent) => {
    e.preventDefault();
    setDrag({ index, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moved: false });
  };

  const onDragMove = (e: React.MouseEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    setDrag({ ...drag, dx, dy, moved: drag.moved || Math.hypot(dx, dy) > 3 });
  };

  const endDrag = async () => {
    if (!drag) return;
    const { index, dx, dy, moved } = drag;
    setDrag(null);
    if (!moved) {
      // Treat as a click: select the object.
      const o = objects.find((obj) => obj.index === index);
      setSelected(index);
      setDraft(o?.text ?? "");
      return;
    }
    setSettling({ index, dx, dy });
    setBusyOp(true);
    try {
      updateInfo(
        await commands.movePageObject(id, pageIndex, index, dx / scale, -dy / scale, title),
        pageIndex,
      );
    } catch (e) {
      setSettling(null);
      showToast(String(e));
    } finally {
      setBusyOp(false);
    }
  };

  const replaceImage = async () => {
    if (selectedObject == null) return;
    try {
      const next = await commands.replaceImageObject(
        id,
        pageIndex,
        selectedObject.index,
        title,
      );
      if (next) updateInfo(next, pageIndex);
      setSelected(null);
    } catch (e) {
      showToast(String(e));
    }
  };

  const placeText = async (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xPt = (e.clientX - rect.left) / scale;
    const yPt = pageHeightPt - (e.clientY - rect.top) / scale;
    try {
      updateInfo(
        await commands.addTextObject(id, pageIndex, xPt, yPt, "New text", 14, title),
        pageIndex,
      );
      onTextPlaced();
    } catch (err) {
      showToast(String(err));
    }
  };

  return (
    <div
      className={`edit-overlay ${addingText ? "placing" : ""}`}
      onClick={addingText ? placeText : undefined}
      onMouseMove={onDragMove}
      onMouseUp={() => void endDrag()}
      onMouseLeave={() => drag?.moved && void endDrag()}
    >
      {!addingText &&
        objects.map((o) => {
          const [x, y, w, h] = o.bounds;
          if (w <= 0 || h <= 0) return null;
          return (
            <button
              key={`${rev}-${o.index}`}
              className={`object-box ${o.kind} ${selected === o.index ? "selected" : ""} ${drag?.index === o.index && drag.moved ? "dragging" : ""}`}
              style={{
                left: x * scale,
                top: (pageHeightPt - y - h) * scale,
                width: Math.max(w * scale, 6),
                height: Math.max(h * scale, 6),
                transform:
                  drag?.index === o.index && drag.moved
                    ? `translate(${drag.dx}px, ${drag.dy}px)`
                    : settling?.index === o.index
                      ? `translate(${settling.dx}px, ${settling.dy}px)`
                      : undefined,
              }}
              title={o.kind === "text" ? "Drag to move · click to edit" : `${o.kind} — drag to move`}
              onMouseDown={(e) => startDrag(o.index, e)}
              onClick={(e) => e.stopPropagation()}
            />
          );
        })}

      {selectedObject && (
        <div
          className="object-editor"
          style={{
            left: Math.max(0, selectedObject.bounds[0] * scale),
            top:
              (pageHeightPt - selectedObject.bounds[1]) * scale + 6,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {selectedObject.kind === "text" ? (
            <>
              <textarea
                autoFocus
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="editor-hint">
                Enter starts a new line (added as a separate text run below).
                Uses the document's embedded font — characters it lacks may not
                display (font substitution ships with the full Edit engine).
              </div>
              <div className="composer-actions">
                <button className="modal-primary" disabled={busyOp} onClick={() => void apply()}>
                  {busyOp ? "Applying…" : "Apply"}
                </button>
                <button className="modal-secondary" onClick={() => void removeObject()}>
                  Delete
                </button>
                <button className="modal-secondary" onClick={() => setSelected(null)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="composer-actions">
              <span className="editor-hint">{selectedObject.kind} object</span>
              {selectedObject.kind === "image" && (
                <button className="modal-primary" onClick={() => void replaceImage()}>
                  Replace…
                </button>
              )}
              <button className="modal-secondary" onClick={() => void removeObject()}>
                Delete
              </button>
              <button className="modal-secondary" onClick={() => setSelected(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
