// Welcome tab: brand + Start actions on the left, recent
// files (name + directory) on the right.
import { FilePlus2, FileText, FolderOpen } from "lucide-react";
import { usePrefs } from "../prefs";
import { t, useLocale } from "../i18n";
import { useApp } from "../store";

function splitPath(path: string): { name: string; dir: string } {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1
    ? { name: path, dir: "" }
    : { name: path.slice(idx + 1), dir: path.slice(0, idx) };
}

export default function WelcomeView() {
  const open = useApp((s) => s.open);
  const openPath = useApp((s) => s.openPath);
  const createNew = useApp((s) => s.createNew);
  const showToast = useApp((s) => s.showToast);
  useLocale();
  const recents = usePrefs((s) => s.recents);
  const removeRecent = usePrefs((s) => s.removeRecent);

  const openRecent = async (path: string) => {
    try {
      await openPath(path);
    } catch (e) {
      showToast(`Could not open file: ${e}`);
      removeRecent(path);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-left">
        <div className="welcome-brand">
          <div className="brand-logo large"><FileText size={28} strokeWidth={2} /></div>
          <div>
            <h1>TelosPDF</h1>
            <p className="welcome-tagline">{t("Open-source PDF workstation")}</p>
          </div>
        </div>

        <h3 className="welcome-heading">{t("Start")}</h3>
        <button className="welcome-action" onClick={() => void createNew()}>
          <FilePlus2 size={18} strokeWidth={1.7} />
          {t("Create PDF")}
        </button>
        <button className="welcome-action" onClick={() => void open()}>
          <FolderOpen size={18} strokeWidth={1.7} />
          {t("Open PDF…")}
        </button>
      </div>

      <div className="welcome-right">
        <h3 className="welcome-heading">{t("Recent")}</h3>
        {recents.length === 0 && (
          <p className="panel-note">{t("Files you open will show up here.")}</p>
        )}
        {recents.map((r) => {
          const { name, dir } = splitPath(r.path);
          return (
            <button
              key={r.path}
              className="recent-row"
              title={r.path}
              onClick={() => void openRecent(r.path)}
            >
              <FileText size={15} strokeWidth={1.7} />
              <span className="recent-name">{name}</span>
              <span className="recent-dir">{dir}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
