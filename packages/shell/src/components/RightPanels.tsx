// Right panel bodies: Pages (thumbnails with size slider + rotate/delete),
// Bookmarks (outline tree), Comments (threaded, add/reply/edit/delete).
import { t, useLocale } from "../i18n";
import { useEffect, useState } from "react";
import { KeyRound, MessageSquarePlus, Pencil, Reply, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import {
  commands,
  pageUrl,
  type CommentEntry,
  type CommentId,
  type OutlineEntry,
} from "../telos";
import { useActiveDoc, useApp } from "../store";
import { usePrefs } from "../prefs";

export default function RightPanel() {
  useLocale();
  const rightPanel = useApp((s) => s.rightPanel);
  const width = usePrefs((s) => s.rightPanelWidth);
  const setWidth = usePrefs((s) => s.setRightPanelWidth);
  if (!rightPanel) return null;
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      // Panel is on the right of the editor: dragging left widens it.
      setWidth(Math.max(220, Math.min(560, startW + (startX - ev.clientX))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return (
    <aside className="right-panel" style={{ width }}>
      <div className="panel-resize" onMouseDown={startResize} title="Drag to resize" />
      {rightPanel === "pages" && <PagesPanel />}
      {rightPanel === "bookmarks" && <BookmarksPanel />}
      {rightPanel === "comments" && <CommentsPanel />}
      {rightPanel === "signatures" && <SignaturesPanel />}
    </aside>
  );
}

/** Tracks Fill & Sign placements — unsaved ones and this session's saved
 * history — like the comments panel tracks notes. */
function SignaturesPanel() {
  const pending = useApp((s) => s.pendingPlacements);
  const placed = useApp((s) => s.placedLog);
  const goToPage = useApp((s) => s.goToPage);
  const undoPlacement = useApp((s) => s.undoPlacement);
  return (
    <>
      <div className="panel-header">{t("Signatures & stamps")}</div>
      <div className="panel-body">
        {pending.length === 0 && placed.length === 0 && (
          <div className="panel-note">{t("Nothing placed yet — use Fill & Sign.")}</div>
        )}
        {pending.length > 0 && (
          <>
            <div className="panel-subhead">
              {t("Unsaved")} ({pending.length})
              <button className="link-btn" title="Remove last (⌘Z)" onClick={undoPlacement}>
                {t("Undo")}
              </button>
            </div>
            {pending.map((p) => (
              <button key={p.id} className="list-row" onClick={() => goToPage(p.page)}>
                {p.kind === "stamp" ? p.text : "Signature"} — page {p.page + 1}
              </button>
            ))}
          </>
        )}
        {placed.length > 0 && (
          <>
            <div className="panel-subhead">{t("Saved this session")} ({placed.length})</div>
            {placed.map((r, i) => (
              <button key={i} className="list-row" onClick={() => goToPage(r.page)}>
                {r.label} — page {r.page + 1} ·{" "}
                {new Date(r.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </button>
            ))}
          </>
        )}
      </div>
    </>
  );
}

function PagesPanel() {
  const doc = useActiveDoc();
  const updateInfo = useApp((s) => s.updateInfo);
  const goToPage = useApp((s) => s.goToPage);
  const showToast = useApp((s) => s.showToast);
  const [thumbWidth, setThumbWidth] = useState(120);

  if (!doc) return <Empty label="Pages" hint="Open a document to see its pages." />;
  const { info } = doc;

  const rotate = async (page: number, clockwise: boolean) => {
    try {
      updateInfo(await commands.rotatePage(info.id, page, clockwise, info.title), page);
    } catch (e) {
      showToast(String(e));
    }
  };

  const remove = async (page: number) => {
    try {
      updateInfo(await commands.deletePage(info.id, page, info.title));
    } catch (e) {
      showToast(String(e));
    }
  };

  return (
    <>
      <div className="panel-header">
        Pages
        <input
          type="range"
          min={80}
          max={200}
          value={thumbWidth}
          onChange={(e) => setThumbWidth(Number(e.target.value))}
          title="Thumbnail size"
        />
      </div>
      <div className="panel-body thumbs">
        {info.sizes.map(([w, h], i) => {
          const rotated = doc.viewRotation % 180 !== 0;
          const [lw, lh] = rotated ? [h, w] : [w, h];
          const th = Math.round((lh / lw) * thumbWidth);
          return (
            <div key={`${info.rev}-${i}`} className="thumb-slot">
              <div
                className={`thumb-frame ${i === doc.currentPage ? "current" : ""}`}
                onClick={() => goToPage(i)}
              >
                <img
                  src={pageUrl(info.id, i, (rotated ? th : thumbWidth) * 2, info.rev, doc.viewRotation)}
                  width={thumbWidth}
                  height={th}
                  loading="lazy"
                  alt={`Page ${i + 1}`}
                />
                {info.editable && (
                  <div className="thumb-actions" onClick={(e) => e.stopPropagation()}>
                    <button title="Rotate left" onClick={() => void rotate(i, false)}>
                      <RotateCcw size={14} />
                    </button>
                    <button title="Rotate right" onClick={() => void rotate(i, true)}>
                      <RotateCw size={14} />
                    </button>
                    <button
                      title="Delete page"
                      className="danger"
                      onClick={() => void remove(i)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </div>
              <div className="thumb-label">{i + 1}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function BookmarksPanel() {
  const doc = useActiveDoc();
  const goToPage = useApp((s) => s.goToPage);
  const [items, setItems] = useState<OutlineEntry[] | null>(null);

  const docId = doc?.info.id;
  const rev = doc?.info.rev;
  useEffect(() => {
    setItems(null);
    if (docId == null) return;
    commands.getOutline(docId).then(setItems, () => setItems([]));
  }, [docId, rev]);

  if (!doc) return <Empty label="Bookmarks" hint="Open a document to see its bookmarks." />;
  return (
    <>
      <div className="panel-header">{t("Bookmarks")}</div>
      <div className="panel-body">
        {items == null && <div className="panel-note">{t("Loading…")}</div>}
        {items?.length === 0 && <div className="panel-note">{t("This document has no bookmarks.")}</div>}
        {items?.map((item, i) => (
          <button
            key={i}
            className="list-row"
            style={{ paddingLeft: 12 + item.depth * 14 }}
            disabled={item.pageIndex == null}
            onClick={() => item.pageIndex != null && goToPage(item.pageIndex)}
          >
            {item.title}
          </button>
        ))}
      </div>
    </>
  );
}

const idKey = (id: CommentId | null) => (id ? `${id[0]}-${id[1]}` : "");

// Sticky-note colour palette (first is the default amber). Shared visually
// with the on-page markers, which read each comment's stored colour.
export const COMMENT_COLORS: [number, number, number][] = [
  [245, 197, 66], // amber
  [229, 74, 74], // red
  [232, 140, 48], // orange
  [60, 179, 113], // green
  [56, 132, 222], // blue
  [150, 90, 220], // purple
  [222, 96, 168], // pink
];
export const rgbCss = (c: [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

function CommentsPanel() {
  const doc = useActiveDoc();
  const goToPage = useApp((s) => s.goToPage);
  const updateInfo = useApp((s) => s.updateInfo);
  const showToast = useApp((s) => s.showToast);
  const focusedComment = useApp((s) => s.focusedComment);
  const clearFocusedComment = useApp((s) => s.clearFocusedComment);
  const selectedComment = useApp((s) => s.selectedComment);
  const setSelectedComment = useApp((s) => s.setSelectedComment);
  const myEditCode = usePrefs((s) => s.myEditCode);
  const setMyEditCode = usePrefs((s) => s.setMyEditCode);
  const knownEditCodes = usePrefs((s) => s.knownEditCodes);
  const addKnownCode = usePrefs((s) => s.addKnownCode);
  const removeKnownCode = usePrefs((s) => s.removeKnownCode);
  const [items, setItems] = useState<CommentEntry[] | null>(null);
  const [meNames, setMeNames] = useState<string[]>([]);
  // Composer: add / reply / edit. Editing another author's comment needs a
  // matching edit code (tried from your known codes). Deletion is open.
  const [composer, setComposer] = useState<
    { mode: "add" } | { mode: "reply"; to: CommentId } | { mode: "edit"; id: CommentId } | null
  >(null);
  const [draft, setDraft] = useState("");
  const [color, setColor] = useState<[number, number, number]>(COMMENT_COLORS[0]);
  const [codesOpen, setCodesOpen] = useState(false);
  const [otherCode, setOtherCode] = useState("");

  const docId = doc?.info.id;
  const rev = doc?.info.rev;
  useEffect(() => {
    void commands.currentUserNames().then(setMeNames, () => {});
  }, []);
  useEffect(() => {
    setItems(null);
    setComposer(null);
    if (docId == null) return;
    commands.getComments(docId).then(setItems, () => setItems([]));
  }, [docId, rev]);

  // A marker on the page was clicked: scroll its row into view and flash.
  useEffect(() => {
    if (!focusedComment || items == null) return;
    const el = document.querySelector(`[data-ck="${focusedComment}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("flash");
      const timer = setTimeout(() => el.classList.remove("flash"), 1600);
      clearFocusedComment();
      return () => clearTimeout(timer);
    }
    clearFocusedComment();
  }, [focusedComment, items, clearFocusedComment]);

  // Delete/Backspace removes the selected comment — anyone may delete.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      const state = useApp.getState();
      const key = state.selectedComment;
      if (!key || items == null) return;
      const item = items.find((c) => idKey(c.id) === key);
      if (!item?.id) return;
      e.preventDefault();
      void remove(item.id);
      state.setSelectedComment(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!doc) return <Empty label="Comments" hint="Open a document to see its comments." />;
  const { info } = doc;
  const canEdit = info.editable;

  const resetComposer = () => {
    setComposer(null);
    setDraft("");
  };

  const submit = async () => {
    if (!composer || !draft.trim()) return;
    try {
      let next;
      if (composer.mode === "edit") {
        // Mine → no code; someone else's → try my known codes until one fits.
        const target = items?.find((i) => idKey(i.id) === idKey(composer.id));
        const mineC = target && isMine(target);
        if (mineC) {
          next = await commands.editComment(info.id, composer.id, draft.trim(), null, null, info.title);
        } else {
          const codes = [myEditCode, ...knownEditCodes].filter(Boolean);
          let ok;
          for (const c of codes) {
            try {
              ok = await commands.editComment(info.id, composer.id, draft.trim(), c, null, info.title);
              break;
            } catch {
              /* try next code */
            }
          }
          if (!ok) throw new Error("No matching edit code — add the author's code above.");
          next = ok;
        }
      } else {
        next = await commands.addComment(
          info.id,
          composer.mode === "reply"
            ? (items?.find((i) => idKey(i.id) === idKey(composer.to))?.pageIndex ?? doc.currentPage)
            : doc.currentPage,
          draft.trim(),
          composer.mode === "reply" ? composer.to : null,
          myEditCode.trim() || null,
          color,
          info.title,
        );
      }
      // "none": comments draw as DOM markers, so no page pixels change —
      // skip the full-document re-render that made edits feel laggy.
      updateInfo(next, "none");
      resetComposer();
    } catch (e) {
      showToast(String(e));
    }
  };

  const remove = async (id: CommentId) => {
    // Optimistic: drop the comment (and its reply subtree) from the list
    // immediately so deletion feels instant; the lopdf rewrite happens in the
    // background and reconciles on completion.
    const doomed = new Set<string>();
    const collect = (target: CommentId) => {
      const k = idKey(target);
      if (doomed.has(k)) return;
      doomed.add(k);
      items?.forEach((c) => c.replyTo && idKey(c.replyTo) === k && c.id && collect(c.id));
    };
    collect(id);
    const prev = items;
    setItems((list) => list?.filter((c) => !doomed.has(idKey(c.id))) ?? list);
    resetComposer();
    try {
      updateInfo(await commands.deleteComment(info.id, id, info.title), "none");
    } catch (e) {
      setItems(prev ?? null); // restore on failure
      showToast(String(e));
    }
  };

  const isMine = (item: CommentEntry) => {
    const a = item.author.trim().toLowerCase();
    return meNames.some((n) => n.trim().toLowerCase() === a);
  };

  const editor = (
    <div className="comment-composer">
      <textarea
        autoFocus
        rows={3}
        placeholder={composer?.mode === "reply" ? "Write a reply…" : "Write a comment…"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      {composer?.mode !== "edit" && (
        <div className="swatch-row" title="Note colour">
          {COMMENT_COLORS.map((c) => (
            <button
              key={c.join(",")}
              type="button"
              className={`swatch ${color.join(",") === c.join(",") ? "on" : ""}`}
              style={{ background: rgbCss(c) }}
              onClick={() => setColor(c)}
              aria-label={`Colour ${c.join(",")}`}
            />
          ))}
        </div>
      )}
      <div className="composer-actions">
        <button className="modal-primary" onClick={() => void submit()}>
          {composer?.mode === "edit" ? "Save" : "Post"}
        </button>
        <button className="modal-secondary" onClick={resetComposer}>
          Cancel
        </button>
      </div>
    </div>
  );

  const genCode = () =>
    Array.from({ length: 6 }, () =>
      "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".charAt(Math.floor(Math.random() * 32)),
    ).join("");

  const renderComment = (item: CommentEntry, depth: number) => {
    const mine = canEdit && item.id != null && isMine(item);
    // Someone else's comment is editable if it carries an edit code (you'll
    // need a matching code); deletion is always allowed.
    const editable = canEdit && item.id != null && (mine || item.hasEditCode);
    const key = idKey(item.id) || `${item.pageIndex}-${item.contents.slice(0, 12)}`;
    return (
      <div key={key} style={{ marginLeft: depth * 14 }}>
        <div
          className={`comment-row-static ${selectedComment === idKey(item.id) ? "selected" : ""}`}
          data-ck={idKey(item.id)}
          onClick={() => item.id && setSelectedComment(idKey(item.id))}
        >
          <div className="comment-meta">
            <span>
              <span
                className="comment-dot"
                style={{ background: rgbCss(item.color ?? COMMENT_COLORS[0]) }}
              />
              {item.author || "Unknown"}
              {item.hasEditCode && <span className="code-badge" title="Has a shared edit code"> ⚿</span>}
            </span>
            <button className="comment-page" onClick={() => goToPage(item.pageIndex)}>
              p. {item.pageIndex + 1}
            </button>
          </div>
          <div className="comment-text">{item.contents}</div>
          {canEdit && item.id != null && (
            <div className="comment-actions">
              <button
                title="Reply"
                onClick={() => {
                  setComposer({ mode: "reply", to: item.id! });
                  setDraft("");
                }}
              >
                <Reply size={13} /> Reply
              </button>
              {editable && (
                <button
                  title={mine ? "Edit" : "Edit (uses a matching edit code)"}
                  onClick={() => {
                    setComposer({ mode: "edit", id: item.id! });
                    setDraft(item.contents);
                  }}
                >
                  <Pencil size={13} /> Edit
                </button>
              )}
              <button className="danger" title="Delete" onClick={() => void remove(item.id!)}>
                <Trash2 size={13} /> Delete
              </button>
            </div>
          )}
          {composer &&
            ((composer.mode === "reply" && idKey(composer.to) === idKey(item.id)) ||
              (composer.mode === "edit" && idKey(composer.id) === idKey(item.id))) &&
            editor}
        </div>
        {items
          ?.filter((c) => c.replyTo != null && idKey(c.replyTo) === idKey(item.id))
          .map((c) => renderComment(c, depth + 1))}
      </div>
    );
  };

  return (
    <>
      <div className="panel-header">
        Comments
        {canEdit && (
          <div className="panel-header-actions">
            <button
              className={`panel-action ${codesOpen ? "active" : ""}`}
              title="Edit codes"
              onClick={() => setCodesOpen((v) => !v)}
            >
              <KeyRound size={15} />
            </button>
            <button
              className="panel-action"
              title="Add a comment to the current page"
              onClick={() => {
                setComposer({ mode: "add" });
                setDraft("");
              }}
            >
              <MessageSquarePlus size={16} />
            </button>
          </div>
        )}
      </div>
      {canEdit && codesOpen && (
        <div className="code-manager">
          <div className="code-manager-label">Your edit code (attached to comments you post)</div>
          <div className="code-row">
            <input
              className="code-input"
              style={{ marginTop: 0 }}
              placeholder="none"
              value={myEditCode}
              onChange={(e) => setMyEditCode(e.target.value)}
            />
            <button className="mini-btn" onClick={() => setMyEditCode(genCode())}>
              Generate
            </button>
          </div>
          <div className="code-manager-label">Add someone's code (to edit their comments)</div>
          <div className="code-row">
            <input
              className="code-input"
              style={{ marginTop: 0 }}
              placeholder="paste a code"
              value={otherCode}
              onChange={(e) => setOtherCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && otherCode.trim()) {
                  addKnownCode(otherCode.trim());
                  setOtherCode("");
                }
              }}
            />
            <button
              className="mini-btn"
              onClick={() => {
                if (otherCode.trim()) {
                  addKnownCode(otherCode.trim());
                  setOtherCode("");
                }
              }}
            >
              Add
            </button>
          </div>
          {knownEditCodes.length > 0 && (
            <div className="code-chips">
              {knownEditCodes.map((c) => (
                <span key={c} className="code-chip">
                  {c}
                  <button onClick={() => removeKnownCode(c)}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="panel-body">
        {composer?.mode === "add" && editor}
        {items == null && <div className="panel-note">{t("Loading…")}</div>}
        {items?.length === 0 && !composer && (
          <div className="panel-note">
            No comments yet{canEdit ? " — add the first one." : "."}
          </div>
        )}
        {!canEdit && items && items.length > 0 && (
          <div className="panel-note">This document opened view-only; comments are read-only.</div>
        )}
        {items?.filter((c) => c.replyTo == null).map((c) => renderComment(c, 0))}
      </div>
    </>
  );
}

function Empty({ label, hint }: { label: string; hint: string }) {
  return (
    <>
      <div className="panel-header">{label}</div>
      <div className="panel-body">
        <div className="panel-note">{hint}</div>
      </div>
    </>
  );
}
