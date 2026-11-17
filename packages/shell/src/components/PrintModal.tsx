// Print dialog — app-rendered (not the OS panel). Fixed-size popup.
// Print tab: options on the left, big printer icon + action buttons on the
// right. Print queue tab: the live system spooler queue (scrollable) with a
// progress bar per job, each job cancellable; sending a job switches here
// and opens the OS's own queue too. Prints natively via CUPS;
// window.print() is a no-op in macOS WKWebView.
import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  HelpCircle,
  Printer,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { commands, type PrintJobEntry } from "../telos";
import { PRINT_ENDED, pollPrintQueue, useApp, type OpenDoc, type TrackedPrint } from "../store";

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

/** Pages a print selection covers, for the progress bar. */
function selectedPages(total: number, pageSet: string, range: string): number {
  if (pageSet === "odd") return Math.ceil(total / 2);
  if (pageSet === "even") return Math.floor(total / 2);
  if (pageSet !== "custom" || !range.trim()) return total;
  const pages = new Set<number>();
  for (const part of range.split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = Math.max(1, Math.min(a, b)); p <= Math.min(total, Math.max(a, b)); p++) pages.add(p);
  }
  return pages.size || total;
}

type Tone = "active" | "done" | "muted" | "error";

/** Where a job is, as a bar: `pct` null = under way, amount unknown. */
function jobProgress(
  state: TrackedPrint["state"],
  pagesDone: number | null,
  expected: number,
): { pct: number | null; label: string; tone: Tone } {
  switch (state) {
    case "sending":
      return { pct: 5, label: "Sending to the printer…", tone: "active" };
    case "sent":
      return { pct: 12, label: "Sent — waiting for the print queue…", tone: "active" };
    case "queued":
      return { pct: 20, label: "Waiting in the queue", tone: "active" };
    case "held":
      return { pct: 20, label: "On hold", tone: "muted" };
    case "printing":
      if (pagesDone == null || expected <= 0) return { pct: null, label: "Printing…", tone: "active" };
      return {
        pct: 20 + (80 * Math.min(pagesDone, expected)) / expected,
        label: `Printing page ${Math.min(pagesDone + 1, expected)} of ${expected}`,
        tone: "active",
      };
    case "done":
      return { pct: 100, label: "Printed", tone: "done" };
    case "cancelled":
      return { pct: 100, label: "Cancelled", tone: "muted" };
    case "failed":
      return { pct: 100, label: "Failed", tone: "error" };
  }
}

function QueueRow({
  title,
  printer,
  progress,
  message,
  onCancel,
}: {
  title: string;
  printer: string;
  progress: ReturnType<typeof jobProgress>;
  message: string;
  onCancel?: () => void;
}) {
  return (
    <div className="queue-row">
      <Printer size={16} />
      <div className="queue-text">
        <div className="queue-title">{title}</div>
        <div className="queue-sub">
          {printer ? `${printer} · ` : ""}
          {progress.label}
        </div>
        <div
          className={`queue-progress ${progress.tone} ${progress.pct == null ? "indeterminate" : ""}`}
          role="progressbar"
          aria-valuenow={progress.pct ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="queue-progress-fill" style={{ width: `${progress.pct ?? 35}%` }} />
        </div>
        {message && <div className={`queue-message ${progress.tone}`}>{message}</div>}
      </div>
      {onCancel && (
        <button className="icon-btn danger" title="Cancel this job" onClick={onCancel}>
          <Trash2 size={14} />
        </button>
      )}
    </div>
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
  const tracked = useApp((s) => s.printJobs);
  const queue = useApp((s) => s.printQueue);

  useEffect(() => {
    commands.listPrinters().then(
      (list) => {
        setPrinters(list.printers);
        setPrinter(list.default ?? list.printers[0] ?? "");
      },
      () => {},
    );
  }, []);

  // The queue stays live while this popup is open.
  useEffect(() => useApp.getState().watchPrintQueue(), []);
  const refreshQueue = () => void pollPrintQueue();

  const cancelJob = async (jobId: string) => {
    try {
      await commands.cancelPrintJob(jobId);
      refreshQueue();
    } catch (e) {
      showToast(String(e));
    }
  };

  const openSystemQueue = (target: string | null) =>
    commands.openPrintQueue(target).catch((e) => showToast(String(e)));

  const print = async () => {
    const app = useApp.getState();
    const expected = selectedPages(doc.info.pages, pageSet, pages) * copies;
    const key = app.startPrint({ title: doc.info.title, printer: printer || null, expected });
    setBusy(true);
    setTab("queue");
    try {
      const sent = await commands.printDocument(doc.info.id, {
        printer: printer || null,
        title: doc.info.title,
        copies,
        pages: pageSet === "custom" && pages.trim() ? pages.trim() : null,
        pageSet: pageSet === "custom" ? "all" : pageSet,
        sides,
        reverse,
      });
      app.printSent(key, sent);
      void openSystemQueue(sent.printer ?? (printer || null));
    } catch (e) {
      app.printFailed(key, String(e));
    } finally {
      setBusy(false);
    }
  };

  // This session's jobs first (with their outcome), then anything else
  // waiting on the spooler.
  const ours = new Set(tracked.flatMap((j) => (j.jobId ? [j.jobId] : [])));
  const others = queue.filter((e: PrintJobEntry) => !ours.has(e.id) && !PRINT_ENDED.has(e.state));

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
                <span className="queue-head-actions">
                  <button
                    className="icon-btn"
                    title="Open the system print queue"
                    onClick={() => void openSystemQueue(printer || null)}
                  >
                    <ExternalLink size={14} />
                  </button>
                  <button className="icon-btn" title="Refresh" onClick={refreshQueue}>
                    <RefreshCw size={14} />
                  </button>
                </span>
              </div>
              <div className="queue-list">
                {tracked.length === 0 && others.length === 0 && (
                  <p className="panel-note">No jobs in the queue right now.</p>
                )}
                {tracked.map((j) => (
                  <QueueRow
                    key={`ours-${j.key}`}
                    title={j.title}
                    printer={(j.printer ?? "").replace(/_/g, " ")}
                    progress={jobProgress(j.state, j.pagesDone, j.expected)}
                    message={j.message}
                    onCancel={
                      j.jobId && !PRINT_ENDED.has(j.state)
                        ? () => void cancelJob(j.jobId!)
                        : undefined
                    }
                  />
                ))}
                {others.map((e) => (
                  <QueueRow
                    key={e.id}
                    title={e.title ?? e.id}
                    printer={e.printer}
                    progress={jobProgress(e.state, e.pagesDone, e.pagesTotal ?? 0)}
                    message={e.message}
                    onCancel={() => void cancelJob(e.id)}
                  />
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
