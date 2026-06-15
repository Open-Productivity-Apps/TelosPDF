// App-wide "open external link?" gate (ported from MyBI). A link never
// navigates the in-app webview — it asks here first. TelosPDF has no external
// opener plugin, so confirming copies the URL for the user's browser, matching
// the LinkModal convention used elsewhere in Settings.
import { useState } from "react";
import { create } from "zustand";

export const useLinkConfirm = create<{ url: string | null; ask: (u: string) => void; clear: () => void }>(
  (set) => ({
    url: null,
    ask: (url) => set({ url }),
    clear: () => set({ url: null }),
  }),
);

/** Ask before opening an external link (from anywhere in the app). */
export function confirmExternalLink(url: string): void {
  useLinkConfirm.getState().ask(url);
}

/** The confirmation popup host — render ONCE near the app root. */
export function LinkConfirmHost() {
  const url = useLinkConfirm((s) => s.url);
  const clear = useLinkConfirm((s) => s.clear);
  const [copied, setCopied] = useState(false);
  if (!url) return null;
  return (
    <div className="modal-overlay" onClick={clear}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-label="External web link"
      >
        <h3>External link</h3>
        <p className="modal-url">{url}</p>
        <div className="modal-actions">
          <button
            className="modal-primary"
            onClick={() => {
              void navigator.clipboard.writeText(url).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
          <button
            className="modal-secondary"
            onClick={() => {
              setCopied(false);
              clear();
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
