// Organize Pages mode: the center becomes a zoomable thumbnail grid
// (PLAN.md UI spec §8.3). Click selects (Cmd toggles, Shift ranges), drag
// reorders, and the toolbar acts on the selection.
import { useState } from "react";
import {
  Copy,
  FilePlus2,
  RotateCcwSquare,
  RotateCwSquare,
  Save,
  Trash2,
} from "lucide-react";
import { commands, pageUrl } from "../telos";
import { useApp, type OpenDoc } from "../store";

export default function OrganizeView({ doc }: { doc: OpenDoc }) {
  const updateInfo = useApp((s) => s.updateInfo);
  const addOpened = useApp((s) => s.addOpened);
  const setOrganizeMode = useApp((s) => s.setOrganizeMode);
  const showToast = useApp((s) => s.showToast);
  const [selected, setSelected] = useState<number[]>([]);
  const [lastPick, setLastPick] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [thumb, setThumb] = useState(150);

  const { info } = doc;

  const pick = (i: number, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setSelected((sel) => (sel.includes(i) ? sel.filter((p) => p !== i) : [...sel, i]));
    } else if (e.shiftKey && lastPick != null) {
      const [a, b] = [Math.min(lastPick, i), Math.max(lastPick, i)];
      setSelected(Array.from({ length: b - a + 1 }, (_, k) => a + k));
    } else {
      setSelected((sel) => (sel.length === 1 && sel[0] === i ? [] : [i]));
    }
    setLastPick(i);
  };

  const run = async (op: () => Promise<void>) => {
    try {
      await op();
    } catch (e) {
      showToast(String(e));
    }
  };

  const rotateSelection = (clockwise: boolean) =>
    run(async () => {
      let next = info;
      for (const page of selected) {
        next = await commands.rotatePage(info.id, page, clockwise, info.title);
      }
      updateInfo(next);
    });

  const deleteSelection = () =>
    run(async () => {
      let next = info;
      // Descending order keeps the remaining indices valid.
      for (const page of [...selected].sort((a, b) => b - a)) {
        next = await commands.deletePage(info.id, page, info.title);
      }
      updateInfo(next);
      setSelected([]);
    });

  const insertBlank = () =>
    run(async () => {
      const at = selected.length > 0 ? Math.max(...selected) + 1 : info.pages;
      updateInfo(await commands.insertBlankPage(info.id, at, info.title));
    });

  const extractSelection = () =>
    run(async () => {
      const picked = [...selected].sort((a, b) => a - b);
      const next = await commands.extractPages(info.id, picked);
      addOpened(next);
      showToast(`Extracted ${picked.length} page(s) into a new document.`);
    });

  const drop = (to: number) =>
    run(async () => {
      setDropAt(null);
      const from = dragFrom;
      setDragFrom(null);
      if (from == null || from === to) return;
      updateInfo(await commands.movePage(info.id, from, to, info.title));
      setSelected([to]);
    });

  return (
    <div className="organize">
      <div className="edit-toolbar">
        <button className="edit-tool" onClick={() => void insertBlank()}>
          <FilePlus2 size={15} /> Insert blank
        </button>
        <button
          className="edit-tool"
          disabled={selected.length === 0}
          onClick={() => void extractSelection()}
        >
          <Copy size={15} /> Extract
        </button>
        <button
          className="edit-tool"
          disabled={selected.length === 0}
          onClick={() => void rotateSelection(false)}
        >
          <RotateCcwSquare size={15} /> Rotate left
        </button>
        <button
          className="edit-tool"
          disabled={selected.length === 0}
          onClick={() => void rotateSelection(true)}
        >
          <RotateCwSquare size={15} /> Rotate right
        </button>
        <button
          className="edit-tool danger"
          disabled={selected.length === 0 || selected.length >= info.pages}
          onClick={() => void deleteSelection()}
        >
          <Trash2 size={15} /> Delete
        </button>
        <span className="editor-hint">
          {selected.length > 0
            ? `${selected.length} page(s) selected`
            : "Click to select · Cmd-click multi · Shift-click range · drag to reorder"}
        </span>
        <div className="spacer" />
        <input
          type="range"
          min={100}
          max={240}
          value={thumb}
          onChange={(e) => setThumb(Number(e.target.value))}
          title="Thumbnail size"
        />
        <button
          className="edit-tool save-btn"
          onClick={() => void useApp.getState().save().finally(() => setOrganizeMode(false))}
        >
          <Save size={15} /> Save
        </button>
      </div>

      <div className="organize-grid">
        {info.sizes.map(([w, h], i) => {
          const rotated = doc.viewRotation % 180 !== 0;
          const [lw, lh] = rotated ? [h, w] : [w, h];
          const th = Math.round((lh / lw) * thumb);
          return (
            <div
              key={`${info.rev}-${i}`}
              className={`organize-cell ${selected.includes(i) ? "selected" : ""} ${
                dropAt === i ? "drop-target" : ""
              }`}
              draggable
              onDragStart={() => setDragFrom(i)}
              onDragOver={(e) => {
                e.preventDefault();
                setDropAt(i);
              }}
              onDragLeave={() => setDropAt((d) => (d === i ? null : d))}
              onDrop={() => void drop(i)}
              onDragEnd={() => {
                setDragFrom(null);
                setDropAt(null);
              }}
              onClick={(e) => pick(i, e)}
            >
              <img
                src={pageUrl(info.id, i, thumb * 2, doc.pageRevs[i] ?? info.rev, doc.viewRotation)}
                width={thumb}
                height={th}
                loading="lazy"
                alt={`Page ${i + 1}`}
                draggable={false}
              />
              <div className="organize-label">{i + 1}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
