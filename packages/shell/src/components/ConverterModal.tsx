// One converter dialog, two tabs: "To PDF" (Word/Excel/PPT/HTML/Images →
// PDF) and "From PDF" (PDF → Word/Excel/PPT/Images/Text/HTML). Office
// conversions go through LibreOffice; the rest are built in.
import { useEffect, useState } from "react";
import {
  FileImage,
  FilePlus2,
  FileText,
  Globe,
  Image,
  Presentation,
  Table,
  type LucideIcon,
} from "lucide-react";
import { commands } from "../telos";
import { useApp } from "../store";

interface Opt {
  id: string;
  icon: LucideIcon;
  title: string;
  sub: string;
  office?: boolean;
}

const TO_PDF: Opt[] = [
  { id: "word", icon: FileText, title: "Word to PDF", sub: "doc, docx, rtf, odt", office: true },
  { id: "excel", icon: Table, title: "Excel to PDF", sub: "xls, xlsx, ods, csv", office: true },
  { id: "ppt", icon: Presentation, title: "PowerPoint to PDF", sub: "ppt, pptx, odp", office: true },
  { id: "html", icon: Globe, title: "HTML to PDF", sub: "html, htm", office: true },
  { id: "images", icon: Image, title: "Images to PDF", sub: "jpg, png, webp, tiff — one page each" },
  { id: "blank", icon: FilePlus2, title: "Blank PDF", sub: "Empty A4 page" },
];

const FROM_PDF: Opt[] = [
  { id: "to-word", icon: FileText, title: "PDF to Word", sub: "Editable .docx", office: true },
  { id: "to-ppt", icon: Presentation, title: "PDF to PowerPoint", sub: ".pptx", office: true },
  { id: "to-images", icon: FileImage, title: "PDF to Images", sub: "PNG per page" },
  { id: "to-text", icon: FileText, title: "PDF to Text", sub: "Plain .txt" },
  { id: "to-html", icon: Globe, title: "PDF to HTML", sub: "Web page" },
];

export default function ConverterModal({
  initial,
  onClose,
}: {
  initial: "to" | "from";
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"to" | "from">(initial);
  const [office, setOffice] = useState(true);
  const showToast = useApp((s) => s.showToast);

  useEffect(() => {
    commands.officeAvailable().then(setOffice, () => setOffice(false));
  }, []);

  const activeDoc = () => {
    const s = useApp.getState();
    return s.docs.find((d) => d.info.id === s.activeId) ?? s.docs[0] ?? null;
  };

  const runTo = (id: string) => {
    onClose();
    const s = useApp.getState();
    if (id === "blank") return void s.createNew();
    if (id === "images") return void s.createFromImages();
    // Word/Excel/PPT/HTML → PDF via LibreOffice.
    void commands
      .createFromOffice()
      .then((info) => info && s.addOpened(info))
      .catch((e) => showToast(String(e)));
  };

  const runFrom = (id: string) => {
    const doc = activeDoc();
    if (!doc) {
      showToast("Open a PDF first, then convert it.");
      return;
    }
    onClose();
    const done = (p: string | null, verb: string) => p && showToast(`${verb} ${p}`);
    const fail = (e: unknown) => showToast(String(e));
    switch (id) {
      case "to-word":
        return void commands.exportOffice(doc.info.id, "word", doc.info.title).then((p) => done(p, "Saved")).catch(fail);
      case "to-ppt":
        return void commands.exportOffice(doc.info.id, "ppt", doc.info.title).then((p) => done(p, "Saved")).catch(fail);
      case "to-text":
        return void commands.exportText(doc.info.id).then((p) => done(p, "Text saved to")).catch(fail);
      case "to-html":
        return void commands.exportHtml(doc.info.id, doc.info.title).then((p) => done(p, "HTML saved to")).catch(fail);
      case "to-images":
        return void commands.exportImages(doc.info.id).then((n) => n != null && showToast(`Exported ${n} page image(s).`)).catch(fail);
    }
  };

  const options = tab === "to" ? TO_PDF : FROM_PDF;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card menu-card" onClick={(e) => e.stopPropagation()}>
        <div className="ribbon-tabs">
          <button className={tab === "to" ? "active" : ""} onClick={() => setTab("to")}>
            To PDF
          </button>
          <button className={tab === "from" ? "active" : ""} onClick={() => setTab("from")}>
            From PDF
          </button>
        </div>
        {!office && options.some((o) => o.office) && (
          <p className="panel-note" style={{ padding: "0 0 8px" }}>
            Office conversions need LibreOffice — install it from libreoffice.org to enable them.
          </p>
        )}
        <div className="menu-options">
          {options.map((o) => {
            const disabled = o.office && !office;
            return (
              <button
                key={o.id}
                className="menu-option"
                disabled={disabled}
                onClick={() => (tab === "to" ? runTo(o.id) : runFrom(o.id))}
              >
                <o.icon size={20} strokeWidth={1.7} />
                <span className="menu-option-text">
                  <span className="menu-option-title">{o.title}</span>
                  <span className="menu-option-sub">{o.sub}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
