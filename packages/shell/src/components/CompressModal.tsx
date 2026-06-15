// Compress PDF: preset picker → compressed copy via Save As, reporting
// before → after sizes. Never grows a file (backend falls back to a copy).
import { useState } from "react";
import { commands } from "../telos";
import { useApp, type OpenDoc } from "../store";

const PRESETS = [
  {
    id: "lossless",
    dpi: null,
    title: "Lossless",
    hint: "Recompress streams & drop unused objects. Pixel-identical.",
  },
  {
    id: "balanced",
    dpi: 150,
    title: "Balanced",
    hint: "Downsample images to 150 DPI. Great for sharing & email.",
  },
  {
    id: "small",
    dpi: 100,
    title: "Smallest",
    hint: "Downsample images to 100 DPI. Screen reading only.",
  },
] as const;

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function CompressModal({
  doc,
  onClose,
}: {
  doc: OpenDoc;
  onClose: () => void;
}) {
  const showToast = useApp((s) => s.showToast);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["id"]>("balanced");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const chosen = PRESETS.find((p) => p.id === preset)!;
    setBusy(true);
    try {
      const result = await commands.compressDocument(doc.info.id, chosen.dpi, doc.info.title);
      onClose();
      if (result) {
        const saved = result.before - result.after;
        const pct = result.before > 0 ? Math.round((saved / result.before) * 100) : 0;
        showToast(
          saved > 0
            ? `${fmtSize(result.before)} → ${fmtSize(result.after)} (−${pct}%) · saved to ${result.path}`
            : `Already optimal — copied unchanged to ${result.path}`,
        );
      }
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>Compress PDF</h3>
        <p className="modal-body-text">
          Writes a compressed copy — the open document is untouched. The result is never larger
          than the original.
        </p>
        <div className="preset-list">
          {PRESETS.map((p) => (
            <label key={p.id} className={`preset-row ${preset === p.id ? "active" : ""}`}>
              <input
                type="radio"
                name="preset"
                checked={preset === p.id}
                onChange={() => setPreset(p.id)}
              />
              <span>
                <span className="preset-title">{p.title}</span>
                <span className="preset-hint">{p.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button className="modal-primary" disabled={busy} onClick={() => void run()}>
            {busy ? "Compressing…" : "Compress & Save As…"}
          </button>
          <button className="modal-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
