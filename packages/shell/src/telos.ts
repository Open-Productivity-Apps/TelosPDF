// Typed bridge to the Tauri host. Hand-written; replaced by
// tauri-specta generated bindings (packages/ipc) later.
import { invoke } from "@tauri-apps/api/core";

export interface DocumentInfo {
  id: number;
  title: string;
  /** Source file path (working-copy path once modified). */
  path: string;
  pages: number;
  /** Page sizes in PDF points (1/72 in). */
  sizes: [number, number][];
  rev: number;
  editable: boolean;
  modified: boolean;
  /** Opened from a password-protected file (unlocked with the password). */
  protected: boolean;
}

export interface OcrModelStatus {
  installed: boolean;
  dir: string;
  bytes: number;
}

export interface OutlineEntry {
  title: string;
  pageIndex: number | null;
  depth: number;
}

export interface AnnotationEntry {
  pageIndex: number;
  kind: string;
  contents: string;
  author: string;
}

/** lopdf object id, serialized as [number, generation]. */
export type CommentId = [number, number];

export interface TextSegmentEntry {
  /** [x, y, width, height] in PDF points, origin bottom-left. */
  bounds: [number, number, number, number];
  text: string;
}

export interface PageObjectEntry {
  /** Index in the page's object list — valid until the next mutation. */
  index: number;
  kind: "text" | "image" | "path" | "shading" | "form" | "unknown";
  /** [x, y, width, height] in PDF points, origin bottom-left. */
  bounds: [number, number, number, number];
  text: string | null;
}

export interface CommentEntry {
  /** Present when the document is editable; null = read-only listing. */
  id: CommentId | null;
  pageIndex: number;
  author: string;
  contents: string;
  modified: string;
  replyTo: CommentId | null;
  /** [x, y, w, h] in PDF points, bottom-left origin; zeros when unknown. */
  bounds: [number, number, number, number];
  /** A shared edit code exists — editable from other devices with the code. */
  hasEditCode: boolean;
  /** Note colour [r, g, b] (0–255), if the comment carries one. */
  color: [number, number, number] | null;
}

export interface FormFieldEntry {
  annotationIndex: number;
  name: string;
  kind: "text" | "checkbox" | "radio" | "combo" | "list" | "signature" | "button" | "unknown";
  value: string | null;
  checked: boolean | null;
  options: string[];
  /** [x, y, w, h] in PDF points, bottom-left origin. */
  bounds: [number, number, number, number];
}

export interface SearchHitEntry {
  pageIndex: number;
  /** Match rectangles in PDF points, bottom-left origin. */
  rects: [number, number, number, number][];
}

export const commands = {
  /** OS file picker → opened document, or null if cancelled. */
  openDocument: () => invoke<DocumentInfo | null>("open_document"),
  /** Open a known path (Welcome-tab recents). */
  openDocumentPath: (path: string) => invoke<DocumentInfo>("open_document_path", { path }),
  /** Blank single-page PDF. */
  createDocument: () => invoke<DocumentInfo>("create_document"),
  /** Image picker → one-page-per-image PDF. Null if cancelled. */
  createDocumentFromImages: () =>
    invoke<DocumentInfo | null>("create_document_from_images"),
  /** OS user name used as comment author (account-free app). */
  currentUser: () => invoke<string>("current_user"),
  /** All names this device's user goes by (login + full name). */
  currentUserNames: () => invoke<string[]>("current_user_names"),
  getComments: (id: number) => invoke<CommentEntry[]>("get_comments", { id }),
  addComment: (id: number, pageIndex: number, contents: string, replyTo: CommentId | null, editCode: string | null, color: [number, number, number] | null, title: string) =>
    invoke<DocumentInfo>("add_comment", { id, pageIndex, contents, replyTo, editCode, color, title }),
  editComment: (id: number, commentId: CommentId, contents: string, code: string | null, setCode: string | null, title: string) =>
    invoke<DocumentInfo>("edit_comment", { id, commentId, contents, code, setCode, title }),
  deleteComment: (id: number, commentId: CommentId, title: string) =>
    invoke<DocumentInfo>("delete_comment", { id, commentId, title }),
  getPageObjects: (id: number, pageIndex: number) =>
    invoke<PageObjectEntry[]>("get_page_objects", { id, pageIndex }),
  editTextObject: (id: number, pageIndex: number, objectIndex: number, text: string, title: string) =>
    invoke<DocumentInfo>("edit_text_object", { id, pageIndex, objectIndex, text, title }),
  deletePageObject: (id: number, pageIndex: number, objectIndex: number, title: string) =>
    invoke<DocumentInfo>("delete_page_object", { id, pageIndex, objectIndex, title }),
  addTextObject: (id: number, pageIndex: number, x: number, y: number, text: string, fontSize: number, title: string) =>
    invoke<DocumentInfo>("add_text_object", { id, pageIndex, x, y, text, fontSize, title }),
  movePageObject: (id: number, pageIndex: number, objectIndex: number, dx: number, dy: number, title: string) =>
    invoke<DocumentInfo>("move_page_object", { id, pageIndex, objectIndex, dx, dy, title }),
  /** Pick a replacement image for an image object. Null if cancelled. */
  replaceImageObject: (id: number, pageIndex: number, objectIndex: number, title: string) =>
    invoke<DocumentInfo | null>("replace_image_object", { id, pageIndex, objectIndex, title }),
  /** PDF → .txt. Returns the saved path, or null if cancelled. */
  exportText: (id: number) => invoke<string | null>("export_text", { id }),
  /** PDF → PNG per page into a chosen folder. Returns page count, or null. */
  exportImages: (id: number) => invoke<number | null>("export_images", { id }),
  exportHtml: (id: number, title: string) => invoke<string | null>("export_html", { id, title }),
  exportDocx: (id: number, title: string) => invoke<string | null>("export_docx", { id, title }),
  /** LibreOffice installed? (Office conversions need it.) */
  officeAvailable: () => invoke<boolean>("office_available"),
  /** Pick an Office/HTML file → convert to PDF → open. Null if cancelled. */
  createFromOffice: () => invoke<DocumentInfo | null>("create_from_office"),
  /** PDF → Office (word/excel/ppt) via LibreOffice. Returns path or null. */
  exportOffice: (id: number, target: "word" | "excel" | "ppt", title: string) =>
    invoke<string | null>("export_office", { id, target, title }),
  /** Run OCR (selected engine) → searchable PDF; replaces the working copy. */
  ocrDocument: (id: number, title: string, engine: "tesseract" | "unlimited") =>
    invoke<DocumentInfo>("ocr_document", { id, title, engine }),
  /** Status of the optional Unlimited-OCR model (Settings → OCR). */
  ocrModelStatus: () => invoke<OcrModelStatus>("ocr_model_status"),
  /** Download + install the Unlimited-OCR model (~2.4 GB, resumable). */
  downloadOcrModel: () => invoke<OcrModelStatus>("download_ocr_model"),
  /** Translation model (Qwen) install state. */
  translateModelStatus: () => invoke<OcrModelStatus>("translate_model_status"),
  /** Download the translation model (+ shared runtime), ~1.8 GB, resumable. */
  downloadTranslateModel: () => invoke<OcrModelStatus>("download_translate_model"),
  /** Stop a running translation after the current page. */
  cancelTranslate: () => invoke<void>("cancel_translate"),
  /** Experimental: translate the document with the local model → new PDF. */
  translateDocument: (id: number, language: string, title: string, engine: "local" | "google", apiKey: string) =>
    invoke<DocumentInfo>("translate_document", { id, language, title, engine, apiKey }),
  listPrinters: () => invoke<{ printers: string[]; default: string | null }>("list_printers"),
  printDocument: (
    id: number,
    options: {
      printer: string | null;
      copies: number;
      pages: string | null;
      pageSet: "all" | "odd" | "even";
      sides: "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
      reverse: boolean;
    },
  ) => invoke<void>("print_document", { id, options }),
  printQueue: () =>
    invoke<{ id: string; printer: string; size: string; when: string }[]>("print_queue"),
  cancelPrintJob: (jobId: string) => invoke<void>("cancel_print_job", { jobId }),
  /** Start a visual compare: pick two PDFs → session for the Compare tab. */
  startCompare: () =>
    invoke<{ id: number; nameA: string; nameB: string; pages: number } | null>("start_compare"),
  closeCompare: (id: number) => invoke<void>("close_compare", { id }),
  /** Compare this document's text with another PDF the user picks. */
  compareDocuments: (id: number) =>
    invoke<{ otherName: string; added: number; removed: number; lines: { tag: string; text: string }[] } | null>(
      "compare_documents",
      { id },
    ),
  getTextSegments: (id: number, pageIndex: number) =>
    invoke<TextSegmentEntry[]>("get_text_segments", { id, pageIndex }),
  /** Pick 2+ PDFs and merge them. Null if cancelled. */
  combineDocuments: () => invoke<DocumentInfo | null>("combine_documents"),
  closeDocument: (id: number) => invoke<void>("close_document", { id }),
  rotatePage: (id: number, pageIndex: number, clockwise: boolean, title: string) =>
    invoke<DocumentInfo>("rotate_page", { id, pageIndex, clockwise, title }),
  deletePage: (id: number, pageIndex: number, title: string) =>
    invoke<DocumentInfo>("delete_page", { id, pageIndex, title }),
  /** Save: writes to the doc's existing file. Some=saved, null=already saved;
   * throws NEEDS_SAVE_AS when the doc has no file yet. */
  saveDocument: (id: number, title: string) =>
    invoke<DocumentInfo | null>("save_document", { id, title }),
  /** Save As: writes the current state to a chosen path and repoints the
   * document at it (the modified dot clears). Null if cancelled. */
  saveDocumentAs: (id: number, title: string) =>
    invoke<DocumentInfo | null>("save_document_as", { id, title }),
  /** Boot handshake: closes splash, shows the window, returns any files
   * the OS asked us to open before the UI was ready. */
  frontendReady: () => invoke<DocumentInfo[]>("frontend_ready"),
  isDefaultPdfHandler: () => invoke<boolean>("is_default_pdf_handler"),
  undo: (id: number, title: string) => invoke<DocumentInfo>("undo", { id, title }),
  redo: (id: number, title: string) => invoke<DocumentInfo>("redo", { id, title }),
  movePage: (id: number, fromIndex: number, toIndex: number, title: string) =>
    invoke<DocumentInfo>("move_page", { id, fromIndex, toIndex, title }),
  insertBlankPage: (id: number, atIndex: number, title: string) =>
    invoke<DocumentInfo>("insert_blank_page", { id, atIndex, title }),
  /** Extract 0-based pages into a new document (opens as a new tab). */
  extractPages: (id: number, pages: number[]) =>
    invoke<DocumentInfo>("extract_pages", { id, pages }),
  getFormFields: (id: number, pageIndex: number) =>
    invoke<FormFieldEntry[]>("get_form_fields", { id, pageIndex }),
  setFormField: (id: number, pageIndex: number, annotationIndex: number, value: string | null, checked: boolean | null, title: string) =>
    invoke<DocumentInfo>("set_form_field", { id, pageIndex, annotationIndex, value, checked, title }),
  /** Place a PNG (data URL ok) on the page — signatures/stamps. */
  placeImage: (id: number, pageIndex: number, x: number, y: number, widthPt: number, imageBase64: string, title: string) =>
    invoke<DocumentInfo>("place_image", { id, pageIndex, x, y, widthPt, imageBase64, title }),
  redactDocument: (id: number, regions: [number, number, number, number, number][], title: string) =>
    invoke<DocumentInfo>("redact_document", { id, regions, title }),
  placeStamp: (id: number, pageIndex: number, x: number, y: number, text: string, fontSize: number, rgb: [number, number, number], title: string) =>
    invoke<DocumentInfo>("place_stamp", { id, pageIndex, x, y, text, fontSize, rgb, title }),
  /** Draw a markup shape (rect/ellipse/line/arrow); coords in PDF points. */
  addShape: (
    id: number,
    pageIndex: number,
    kind: "rect" | "ellipse" | "line" | "arrow",
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    stroke: [number, number, number],
    fill: [number, number, number] | null,
    strokeWidth: number,
    title: string,
  ) => invoke<DocumentInfo>("add_shape", { id, pageIndex, kind, x1, y1, x2, y2, stroke, fill, strokeWidth, title }),
  /** Draw freehand ink — each entry is a polyline of [x, y] PDF points. */
  addInk: (
    id: number,
    pageIndex: number,
    paths: [number, number][][],
    rgb: [number, number, number],
    strokeWidth: number,
    title: string,
  ) => invoke<DocumentInfo>("add_ink", { id, pageIndex, paths, rgb, strokeWidth, title }),
  /** Place a free text box with optional bold/italic/strike styling. */
  addTextBox: (
    id: number,
    pageIndex: number,
    x: number,
    y: number,
    text: string,
    fontSize: number,
    rgb: [number, number, number],
    bold: boolean,
    italic: boolean,
    strike: boolean,
    title: string,
  ) => invoke<DocumentInfo>("add_text_box", { id, pageIndex, x, y, text, fontSize, rgb, bold, italic, strike, title }),
  /** Decrypt a protected file into a work copy and open it. */
  unlockDocument: (path: string, password: string) =>
    invoke<DocumentInfo>("unlock_document", { path, password }),
  /** Write a password-protected (AES-128) copy. Returns path or null. */
  protectDocument: (
    id: number,
    userPassword: string,
    ownerPassword: string,
    allowPrint: boolean,
    allowCopy: boolean,
    allowModify: boolean,
    allowAnnotate: boolean,
    title: string,
  ) =>
    invoke<string | null>("protect_document", {
      id, userPassword, ownerPassword, allowPrint, allowCopy, allowModify, allowAnnotate, title,
    }),
  removePassword: (id: number, title: string) =>
    invoke<DocumentInfo>("remove_password", { id, title }),
  /** Compressed copy via Save As. targetDpi null = lossless/structural. */
  compressDocument: (id: number, targetDpi: number | null, title: string) =>
    invoke<{ path: string; before: number; after: number; imagesDownsampled: number } | null>(
      "compress_document",
      { id, targetDpi, title },
    ),
  searchDocument: (id: number, query: string, matchCase: boolean) =>
    invoke<SearchHitEntry[]>("search_document", { id, query, matchCase }),
  setDefaultPdfHandler: () => invoke<void>("set_default_pdf_handler"),
  getOutline: (id: number) => invoke<OutlineEntry[]>("get_outline", { id }),
  getAnnotations: (id: number) => invoke<AnnotationEntry[]>("get_annotations", { id }),
};

/**
 * URL for a rendered page over the `telos://` custom protocol.
 * Windows/Android expose custom schemes as `http://<scheme>.localhost`.
 * `rev` keys the cache: any mutation changes it, invalidating old renders.
 */
const usesHttpScheme = /windows|android/i.test(navigator.userAgent);

export function compareUrl(
  compareId: number,
  pageIndex: number,
  width: number,
  side: "diff" | "a" | "b" = "diff",
): string {
  const path = `compare/${compareId}/${pageIndex}?width=${Math.max(16, Math.round(width))}&side=${side}`;
  return usesHttpScheme ? `http://telos.localhost/${path}` : `telos://localhost/${path}`;
}

export function pageUrl(
  docId: number,
  pageIndex: number,
  width: number,
  rev: number,
  rotation: number,
): string {
  const path =
    `page/${docId}/${pageIndex}?width=${Math.max(16, Math.round(width))}` +
    `&rot=${rotation}&rev=${rev}`;
  return usesHttpScheme
    ? `http://telos.localhost/${path}`
    : `telos://localhost/${path}`;
}
