// Shown when a tool needs an open PDF but none is active: offers recent
// files, Open, and Create — instead of a dead-end toast. On success it runs
// the pending tool action against the freshly opened document.
import { FilePlus2, FileText, FolderOpen, X } from "lucide-react";
import { usePrefs } from "../prefs";
import { useApp } from "../store";

function splitPath(path: string): { name: string; dir: string } {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? { name: path, dir: "" } : { name: path.slice(idx + 1), dir: path.slice(0, idx) };
}

export default function NeedDocModal({
  toolLabel,
  onClose,
  onReady,
}: {
  toolLabel: string;
  onClose: () => void;
  /** Called with the opened document id once a PDF is available. */
  onReady: (docId: number) => void;
}) {
  const recents = usePrefs((s) => s.recents);
  const removeRecent = usePrefs((s) => s.removeRecent);
  const showToast = useApp((s) => s.showToast);

  const afterOpen = () => {
    const s = useApp.getState();
    const doc = s.docs.find((d) => d.info.id === s.activeId);
    if (doc) {
      onClose();
      onReady(doc.info.id);
    }
  };

  const openRecent = async (path: string) => {
    try {
      await useApp.getState().openPath(path);
      afterOpen();
    } catch (e) {
      showToast(String(e));
      removeRecent(path);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>{toolLabel} needs a PDF</h3>
        <p className="modal-body-text">Open a document to continue.</p>
        <div className="need-doc-actions">
          <button
            className="welcome-action"
            onClick={() => {
              void useApp.getState().open().then(afterOpen);
            }}
          >
            <FolderOpen size={17} strokeWidth={1.7} /> Open PDF…
          </button>
          <button
            className="welcome-action"
            onClick={() => {
              void useApp.getState().createNew().then(afterOpen);
            }}
          >
            <FilePlus2 size={17} strokeWidth={1.7} /> Create blank PDF
          </button>
        </div>
        {recents.length > 0 && (
          <>
            <div className="need-doc-heading">Recent</div>
            <div className="need-doc-recents">
              {recents.slice(0, 6).map((r) => {
                const { name, dir } = splitPath(r.path);
                return (
                  <div
                    key={r.path}
                    className="recent-row"
                    role="button"
                    tabIndex={0}
                    title={r.path}
                    onClick={() => void openRecent(r.path)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void openRecent(r.path);
                    }}
                  >
                    <FileText size={15} strokeWidth={1.7} />
                    <span className="recent-name">{name}</span>
                    <span className="recent-dir">{dir}</span>
                    <button
                      className="recent-x"
                      title="Remove from Recent"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeRecent(r.path);
                      }}
                    >
                      <X size={13} strokeWidth={2} />
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
        <div className="modal-actions">
          <button className="modal-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
