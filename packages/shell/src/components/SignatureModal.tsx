// Draw a signature (pointer/trackpad), reuse the saved one, then click on
// the page to place it. Stored locally (prefs) — never leaves the machine.
import { useEffect, useRef, useState } from "react";
import { usePrefs } from "../prefs";

export default function SignatureModal({
  onClose,
  onUse,
}: {
  onClose: () => void;
  /** Hand back a PNG data-URL; the caller enters click-to-place mode. */
  onUse: (dataUrl: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);
  const savedSignature = usePrefs((s) => s.savedSignature);
  const setSavedSignature = usePrefs((s) => s.setSavedSignature);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1a3f8f";
  }, []);

  const pos = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top] as const;
  };

  const start = (e: React.PointerEvent) => {
    drawing.current = true;
    const ctx = canvasRef.current!.getContext("2d")!;
    const [x, y] = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const [x, y] = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasInk(true);
  };

  const clear = () => {
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  };

  const use = () => {
    const dataUrl = canvasRef.current!.toDataURL("image/png");
    setSavedSignature(dataUrl);
    onUse(dataUrl);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>Your signature</h3>
        <p className="modal-body-text">
          Draw below, then click on the page where it should go. Saved on this device only.
        </p>
        <canvas
          ref={canvasRef}
          className="signature-canvas"
          width={440}
          height={160}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={() => (drawing.current = false)}
        />
        <div className="modal-actions">
          {savedSignature && (
            <button className="modal-secondary" onClick={() => onUse(savedSignature)}>
              Use saved
            </button>
          )}
          <button className="modal-secondary" onClick={clear}>
            Clear
          </button>
          <button className="modal-primary" disabled={!hasInk} onClick={use}>
            Use signature
          </button>
        </div>
      </div>
    </div>
  );
}
