// Document tabs plus the icon-only create button ("+") whose dropdown offers
// Open PDF / Create new PDF.
import { useEffect, useRef, useState } from "react";
import {
  Bell,
  BrushCleaning,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  FileText,
  FolderOpen,
  GitCompare,
  Home,
  Plus,
  X,
} from "lucide-react";
import { t, useLocale } from "../i18n";
import { useUpdate } from "../update";
import { useApp } from "../store";

export default function TabStrip() {
  const docs = useApp((s) => s.docs);
  const activeId = useApp((s) => s.activeId);
  const setActive = useApp((s) => s.setActive);
  const close = useApp((s) => s.close);
  const open = useApp((s) => s.open);
  const createNew = useApp((s) => s.createNew);
  const welcomeOpen = useApp((s) => s.welcomeOpen);
  const welcomeActive = useApp((s) => s.welcomeActive);
  const activateWelcome = useApp((s) => s.activateWelcome);
  const closeWelcome = useApp((s) => s.closeWelcome);
  const compareTabs = useApp((s) => s.compareTabs);
  const activeCompare = useApp((s) => s.activeCompare);
  const setActiveCompare = useApp((s) => s.setActiveCompare);
  const closeCompare = useApp((s) => s.closeCompare);
  const notifications = useApp((s) => s.notifications);
  const clearNotifications = useApp((s) => s.clearNotifications);
  useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  const updateAvailable = useUpdate((s) => s.available);
  const updatePhase = useUpdate((s) => s.phase);
  const updateProgress = useUpdate((s) => s.progress);
  const installUpdate = useUpdate((s) => s.installUpdate);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [bellOpen, setBellOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!bellOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!bellRef.current?.contains(e.target as Node)) setBellOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [bellOpen]);

  // Track whether the tab row overflows so the ‹ › arrows appear.
  const docCount = docs.length + compareTabs.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [docCount]);

  const scrollBy = (dir: number) =>
    scrollRef.current?.scrollBy({ left: dir * 220, behavior: "smooth" });

  return (
    <div className="tab-strip">
      {overflow && (
        <button className="tab-nav" title="Scroll tabs left" onClick={() => scrollBy(-1)}>
          <ChevronLeft size={16} />
        </button>
      )}
      <div className="tab-scroll" ref={scrollRef}>
      {welcomeOpen && (
        <div
          className={`tab ${welcomeActive ? "active" : ""}`}
          onClick={activateWelcome}
          title="Welcome"
        >
          <Home size={14} />
          <span className="tab-title">{t("Welcome")}</span>
          <button
            className="tab-close"
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              closeWelcome();
            }}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {docs.map(({ info }) => (
        <div
          key={info.id}
          className={`tab ${info.id === activeId && !welcomeActive ? "active" : ""}`}
          onClick={() => setActive(info.id)}
          onAuxClick={(e) => {
            if (e.button === 1) void close(info.id);
          }}
          title={info.title}
        >
          <FileText size={14} />
          <span className="tab-title">
            {info.modified ? "● " : ""}
            {info.title}
          </span>
          <button
            className="tab-close"
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              void close(info.id);
            }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      {compareTabs.map((c) => (
        <div
          key={`cmp-${c.id}`}
          className={`tab ${c.id === activeCompare ? "active" : ""}`}
          onClick={() => setActiveCompare(c.id)}
          title={`Compare ${c.nameA} → ${c.nameB}`}
        >
          <GitCompare size={14} />
          <span className="tab-title">Compare: {c.nameB}</span>
          <button
            className="tab-close"
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              void closeCompare(c.id);
            }}
          >
            <X size={13} />
          </button>
        </div>
      ))}

      <div className="tab-create" ref={menuRef}>
        <button
          className={`rail-btn create-btn ${menuOpen ? "active" : ""}`}
          title="New…"
          onClick={(e) => {
            // Fixed position: the scrollable tab row would clip an absolute
            // dropdown hanging below the strip.
            const r = e.currentTarget.getBoundingClientRect();
            setMenuPos({ left: r.left, top: r.bottom + 4 });
            setMenuOpen((v) => !v);
          }}
        >
          <Plus size={18} strokeWidth={2} />
        </button>
        {menuOpen && (
          <div
            className="dropdown"
            style={menuPos ? { position: "fixed", left: menuPos.left, top: menuPos.top, zIndex: 300 } : undefined}
          >
            <button
              onClick={() => {
                setMenuOpen(false);
                void open();
              }}
            >
              <FolderOpen size={16} /> Open PDF…
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                void createNew();
              }}
            >
              <FilePlus2 size={16} /> Create new PDF
            </button>
          </div>
        )}
      </div>
      </div>

      {overflow && (
        <button className="tab-nav" title="Scroll tabs right" onClick={() => scrollBy(1)}>
          <ChevronRight size={16} />
        </button>
      )}

      <div className="tab-strip-right">
        {updateAvailable && (
          <button
            className="update-btn"
            title={`TelosPDF ${updateAvailable} ${updatePhase === "ready" ? t("is ready — click to restart") : t("is available")}`}
            disabled={updatePhase === "downloading" || updatePhase === "restarting"}
            onClick={() => void installUpdate()}
          >
            {updatePhase === "downloading"
              ? `${Math.round(updateProgress * 100)}%`
              : updatePhase === "restarting"
                ? t("Restarting…")
                : t("Update")}
          </button>
        )}
        <div className="tab-divider" />
        <div className="tab-create" ref={bellRef}>
          <button
            className={`rail-btn bell-btn ${bellOpen ? "active" : ""}`}
            title="Notifications"
            onClick={() => setBellOpen((v) => !v)}
          >
            <Bell size={16} />
            {notifications.length > 0 && <span className="bell-dot" />}
          </button>
          {bellOpen && (
            <div className="dropdown dropdown-right notif-popup">
              <div className="notif-head">
                <span>{t("Notifications")}</span>
                {notifications.length > 0 && (
                  <button className="mini-btn danger-solid" onClick={clearNotifications}>
                    <BrushCleaning size={13} /> {t("Clear")}
                  </button>
                )}
              </div>
              <div className="notif-list">
                {notifications.length === 0 && <div className="panel-note">{t("Nothing yet.")}</div>}
                {notifications.map((n) => (
                  <div key={n.id} className="notif-row">
                    <div className="notif-text">{n.text}</div>
                    <div className="notif-time">{n.at}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
