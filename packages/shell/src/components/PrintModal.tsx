// Print dialog — app-rendered (not the OS panel). Fixed-size popup.
// Print tab: options on the left, big printer icon + action buttons on the
// right. Print queue tab: the live system spooler queue (scrollable), each
// job cancellable. Prints natively via CUPS; window.print() is a no-op in
// macOS WKWebView.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, HelpCircle, Printer, RefreshCw, Trash2, X } from "lucide-react";
import { commands } from "../telos";
import { useApp, type OpenDoc } from "../store";

function Dropdown({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const current = options.find((o) => o.id === value);
  return (
    <div className="app-dropdown" ref={ref}>
      <button className="app-dropdown-trigger" onClick={() => setOpen((v) => !v)}>
        <span>{current?.label ?? value}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="app-dropdown-menu">
          {options.map((o) => (
            <button
              key={o.id}
              className={o.id === value ? "active" : ""}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
            >
              {o.id === value ? <Check size={14} /> : <span style={{ width: 14 }} />}
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tooltip that animates long-edge vs short-edge manual duplex. */
function DuplexHelp() {
  return (
    <span className="duplex-help">
      <HelpCircle size={14} />
      <span className="duplex-tip">
        <b>Two-sided on a one-sided printer</b>
        <div className="duplex-demos">
          <div className="flip-demo">
            <div className="flip-scene">
              <div className="flip-card flip-long">
                <div className="flip-face flip-front">1</div>
                <div className="flip-face flip-back back-long">2</div>
              </div>
            </div>
            <div className="flip-caption">Long edge</div>
            <div className="flip-sub">flip left↔right · back upright</div>
          </div>
          <div className="flip-demo">
            <div className="flip-scene">
              <div className="flip-card flip-short">
                <div className="flip-face flip-front">1</div>
                <div className="flip-face flip-back back-short">2</div>
              </div>
            </div>
            <div className="flip-caption">Short edge</div>
            <div className="flip-sub">flip top↕bottom · back inverted</div>
          </div>
        </div>
        Print odd pages first, then flip the printed stack and reload it. Long edge keeps the
        back upright (like a book); short edge turns it upside-down (like a notepad).
      </span>
    </span>
  );
}

export default function PrintModal({ doc, onClose }: { doc: OpenDoc; onClose: () => void }) {
  const showToast = useApp((s) => s.showToast);
  const [tab, setTab] = useState<"print" | "queue">("print");
  const [printers, setPrinters] = useState<string[]>([]);
  const [printer, setPrinter] = useState("");
  const [copies, setCopies] = useState(1);
  const [pageSet, setPageSet] = useState<"all" | "odd" | "even" | "custom">("all");
  const [pages, setPages] = useState("");
  const [sides, setSides] = useState<"one-sided" | "two-sided-long-edge" | "two-sided-short-edge">(
    "one-sided",
  );
  const [reverse, setReverse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<{ id: string; printer: string; size: string; when: string }[]>(
    [],
  );

  useEffect(() => {
    commands.listPrinters().then(
      (list) => {
        setPrinters(list.printers);
        setPrinter(list.default ?? list.printers[0] ?? "");
      },
      () => {},
    );
  }, []);

  const refreshQueue = () => commands.printQueue().then(setQueue, () => setQueue([]));
  useEffect(() => {
    if (tab === "queue") void refreshQueue();
  }, [tab]);

  const cancelJob = async (jobId: string) => {
    try {
      await commands.cancelPrintJob(jobId);
      void refreshQueue();
    } catch (e) {
      showToast(String(e));
    }
  };

  const print = async () => {
    setBusy(true);
    try {
      await commands.printDocument(doc.info.id, {
        printer: printer || null,
        copies,
        pages: pageSet === "custom" && pages.trim() ? pages.trim() : null,
        pageSet: pageSet === "custom" ? "all" : pageSet,
        sides,
        reverse,
      });
      showToast(`Sent to ${printer.replace(/_/g, " ") || "the default printer"}.`);
      setTab("queue");
      setTimeout(() => void refreshQueue(), 400);
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal-card print-card" onClick={(e) => e.stopPropagation()}>
        <div className="ribbon-tabs">
          <button className={tab === "print" ? "active" : ""} onClick={() => setTab("print")}>
            Print
          </button>
          <button className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}>
            Print queue
          </button>
        </div>

        {tab === "print" ? (
          <div className="print-body">
            <div className="print-form">
              <div className="print-field-row">
                <label>Printer</label>
                <Dropdown
                  value={printer}
                  options={
                    printers.length
                      ? printers.map((p) => ({ id: p, label: p.replace(/_/g, " ") }))
                      : [{ id: "", label: "System default" }]
                  }
                  onChange={setPrinter}
                />
              </div>

              <div className="print-field-row">
                <label>Pages</label>
                <Dropdown
                  value={pageSet}
                  options={[
                    { id: "all", label: "All pages" },
                    { id: "odd", label: "Odd pages only" },
                    { id: "even", label: "Even pages only" },
                    { id: "custom", label: "Custom range…" },
                  ]}
                  onChange={(v) => setPageSet(v as typeof pageSet)}
                />
              </div>
              {pageSet === "custom" && (
                <div className="print-field-row">
                  <label />
                  <input
                    className="code-input"
                    style={{ marginTop: 0 }}
                    placeholder="e.g. 1-3, 5, 8-10"
                    value={pages}
                    onChange={(e) => setPages(e.target.value)}
                  />
                </div>
              )}

              <div className="print-field-row">
                <label>
                  Two-sided <DuplexHelp />
                </label>
                <Dropdown
                  value={sides}
                  options={[
                    { id: "one-sided", label: "One-sided" },
                    { id: "two-sided-long-edge", label: "Two-sided (flip long edge)" },
                    { id: "two-sided-short-edge", label: "Two-sided (flip short edge)" },
                  ]}
                  onChange={(v) => setSides(v as typeof sides)}
                />
              </div>

              <div className="print-field-row">
                <label>Order</label>
                <label className="print-check">
                  <input
                    type="checkbox"
                    checked={reverse}
                    onChange={(e) => setReverse(e.target.checked)}
                  />
                  Reverse (print last page first)
                </label>
              </div>

              <div className="print-field-row">
                <label>Copies</label>
                <input
                  className="code-input"
                  style={{ marginTop: 0, width: 90 }}
                  type="number"
                  min={1}
                  max={99}
                  value={copies}
                  onChange={(e) => setCopies(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
                />
              </div>
            </div>

            <div className="print-side">
              <div className="print-icon-col">
                <Printer size={108} strokeWidth={1.1} />
              </div>
              <div className="print-actions">
                <button className="btn-danger" disabled={busy} onClick={onClose}>
                  <X size={15} /> Cancel
                </button>
                <button className="btn-success" disabled={busy} onClick={() => void print()}>
                  <Printer size={15} /> {busy ? "Printing…" : "Print"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="print-body">
            <div className="print-queue">
              <div className="queue-head">
                <span>System print queue</span>
                <button className="icon-btn" title="Refresh" onClick={() => void refreshQueue()}>
                  <RefreshCw size={14} />
                </button>
              </div>
              <div className="queue-list">
                {queue.length === 0 && (
                  <p className="panel-note">No jobs in the queue right now.</p>
                )}
                {queue.map((j) => (
                  <div key={j.id} className="queue-row">
                    <Printer size={16} />
                    <div className="queue-text">
                      <div className="queue-title">{j.id}</div>
                      <div className="queue-sub">
                        {j.printer}
                        {j.when ? ` · ${j.when}` : ""}
                      </div>
                    </div>
                    <button
                      className="icon-btn danger"
                      title="Cancel this job"
                      onClick={() => void cancelJob(j.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="print-actions">
                <button className="modal-secondary" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
