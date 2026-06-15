// Fill & Sign: interactive overlays over PDFium form fields — text inputs
// commit on blur/Enter, checkboxes/radios toggle on click. Values are
// written into the real AcroForm (incremental work-file save).
import { useEffect, useRef, useState } from "react";
import { commands, type FormFieldEntry } from "../telos";
import { useApp } from "../store";

interface Props {
  docId: number;
  rev: number;
  title: string;
  pageIndex: number;
  /** CSS pixels per PDF point. */
  scale: number;
  /** Page height in PDF points. */
  pageHeightPt: number;
}

export default function FormLayer({ docId, rev, title, pageIndex, scale, pageHeightPt }: Props) {
  const updateInfo = useApp((s) => s.updateInfo);
  const showToast = useApp((s) => s.showToast);
  const [fields, setFields] = useState<FormFieldEntry[]>([]);
  // Local text drafts keyed by annotation index (commit on blur/Enter).
  const drafts = useRef(new Map<number, string>());

  useEffect(() => {
    let alive = true;
    drafts.current.clear();
    commands.getFormFields(docId, pageIndex).then(
      (list) => alive && setFields(list),
      () => alive && setFields([]),
    );
    return () => {
      alive = false;
    };
  }, [docId, rev, pageIndex]);

  const commitText = async (field: FormFieldEntry) => {
    const draft = drafts.current.get(field.annotationIndex);
    if (draft == null || draft === (field.value ?? "")) return;
    try {
      updateInfo(
        await commands.setFormField(docId, pageIndex, field.annotationIndex, draft, null, title),
        pageIndex,
      );
    } catch (e) {
      showToast(String(e));
    }
  };

  const toggle = async (field: FormFieldEntry, state: boolean) => {
    try {
      updateInfo(
        await commands.setFormField(docId, pageIndex, field.annotationIndex, null, state, title),
        pageIndex,
      );
    } catch (e) {
      showToast(String(e));
    }
  };

  return (
    <div className="form-layer">
      {fields.map((f) => {
        const [x, y, w, h] = f.bounds;
        const style = {
          left: x * scale,
          top: (pageHeightPt - y - h) * scale,
          width: Math.max(w * scale, 8),
          height: Math.max(h * scale, 8),
        };
        if (f.kind === "text") {
          return (
            <input
              key={`${rev}-${f.annotationIndex}`}
              className="form-field-input"
              style={{ ...style, fontSize: Math.max(h * scale * 0.62, 9) }}
              defaultValue={f.value ?? ""}
              placeholder={f.name}
              title={f.name}
              onChange={(e) => drafts.current.set(f.annotationIndex, e.target.value)}
              onBlur={() => void commitText(f)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          );
        }
        if (f.kind === "checkbox" || f.kind === "radio") {
          return (
            <button
              key={`${rev}-${f.annotationIndex}`}
              className={`form-field-check ${f.checked ? "checked" : ""}`}
              style={style}
              title={f.name}
              onClick={() => void toggle(f, f.kind === "radio" ? true : !f.checked)}
            />
          );
        }
        return (
          <div
            key={`${rev}-${f.annotationIndex}`}
            className="form-field-other"
            style={style}
            title={
              f.kind === "signature"
                ? `${f.name} — use “Add signature” in the toolbar`
                : `${f.name} (${f.kind}${f.options.length ? `: ${f.options.join(", ")}` : ""}) — editing this field type is coming`
            }
          />
        );
      })}
    </div>
  );
}
