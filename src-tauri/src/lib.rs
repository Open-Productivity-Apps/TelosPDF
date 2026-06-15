//! Tauri host for TelosPDF.
//!
//! Responsibilities:
//! - typed commands — the control plane, JSON-sized only;
//! - the `telos://` custom protocol — the binary plane. Rendered pages go to
//!   the webview as PNG bytes over this protocol, never through JSON IPC
//!   (PLAN.md §3: the webview never touches PDF bytes).
//!
//! Mutation model (M0): the source file is never touched. On the first
//! mutation the lopdf model is saved to a revision-numbered work file in the
//! app temp dir and rendering switches to it; `?rev=` in page URLs gives the
//! webview correct cache invalidation. The document-actor model with
//! incremental updates replaces this in M1.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, OnceLock};

use serde::Serialize;
use tauri::Emitter;
use tauri::Manager;
use tauri::http::{Response, StatusCode, header};
use tauri_plugin_dialog::DialogExt;
use telos_core::{Renderer, TelosDocument};

/// Structural (lopdf) model. Parsed lazily on the first edit — parsing a
/// large file up front is exactly what made opening lag.
enum Model {
    NotLoaded,
    Ready(Box<TelosDocument>),
    /// lopdf could not parse a file PDFium renders fine — view-only.
    Failed,
}

struct DocEntry {
    model: Model,
    /// Undo history: every state this document has been in. `history[pos]`
    /// is the file currently rendered — index 0 is the opened source (or
    /// the created temp file); each mutation pushes a new work file.
    history: Vec<PathBuf>,
    pos: usize,
    /// Monotonic render revision — bumps on every visible change including
    /// undo/redo jumps, so `?rev=` page URLs never serve stale cache.
    rev: u32,
    /// History position last saved to (or opened from) a user-visible file.
    saved_pos: Option<usize>,
    /// Opened from a password-protected file (unlocked into the work copy).
    was_protected: bool,
    /// The real user file this document came from (for Save As defaults and
    /// password removal). None for created/combined temp documents.
    origin: Option<PathBuf>,
    /// Where Cmd+S writes directly (no dialog). Some for opened-from-disk and
    /// previously Save-As'd docs; None forces Save As (created/unlocked docs).
    save_path: Option<PathBuf>,
}

impl DocEntry {
    fn work(&self) -> &PathBuf {
        &self.history[self.pos]
    }

    fn modified(&self) -> bool {
        self.saved_pos != Some(self.pos)
    }

    /// Push a new state after `pos`, dropping any redo branch.
    fn push_state(&mut self, path: PathBuf) {
        for dropped in self.history.drain(self.pos + 1..) {
            // Redo branch files are always our temp work files — the saved
            // destination only ever sits at index 0 (save_as resets history).
            let _ = std::fs::remove_file(dropped);
        }
        if self.saved_pos.is_some_and(|sp| sp > self.pos) {
            self.saved_pos = None;
        }
        self.history.push(path);
        self.pos += 1;
        self.rev += 1;
        self.model = Model::NotLoaded;
    }

    /// Parse the structural model if not attempted yet.
    fn ensure_model(&mut self) -> Result<&mut TelosDocument, String> {
        if matches!(self.model, Model::NotLoaded) {
            self.model = match TelosDocument::open(self.work()) {
                Ok(doc) => Model::Ready(Box::new(doc)),
                Err(_) => Model::Failed,
            };
        }
        match &mut self.model {
            Model::Ready(doc) => Ok(doc),
            _ => Err("this document could not be fully parsed and is view-only in M0".into()),
        }
    }
}

#[derive(Default)]
struct DocRegistry {
    next_id: u32,
    docs: HashMap<u32, DocEntry>,
}

/// Files opened via OS association before the frontend was ready.
static PENDING_OPENS: LazyLock<Mutex<Vec<DocumentInfo>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static FRONTEND_READY: LazyLock<Mutex<bool>> = LazyLock::new(|| Mutex::new(false));

static REGISTRY: LazyLock<Mutex<DocRegistry>> = LazyLock::new(|| {
    Mutex::new(DocRegistry {
        next_id: 1,
        docs: HashMap::new(),
    })
});

/// One PDFium engine per process (`thread_safe` feature serializes calls).
fn renderer() -> Result<&'static Renderer, String> {
    static RENDERER: OnceLock<Result<Renderer, String>> = OnceLock::new();
    RENDERER
        .get_or_init(|| Renderer::new().map_err(|e| e.to_string()))
        .as_ref()
        .map_err(Clone::clone)
}

fn work_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("telospdf-work");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DocumentInfo {
    id: u32,
    title: String,
    path: String,
    pages: u32,
    sizes: Vec<(f32, f32)>,
    rev: u32,
    editable: bool,
    modified: bool,
    protected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutlineEntry {
    title: String,
    page_index: Option<u32>,
    depth: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationEntry {
    page_index: u32,
    kind: String,
    contents: String,
    author: String,
}

fn register(
    path: PathBuf,
    title: String,
    opened_from_disk: bool,
    was_protected: bool,
    origin: Option<PathBuf>,
) -> Result<DocumentInfo, String> {
    let renderer = renderer()?;
    let pages = renderer.page_count(&path).map_err(|e| e.to_string())?;
    let sizes = renderer.page_sizes(&path).map_err(|e| e.to_string())?;
    let path_str = path.to_string_lossy().into_owned();

    let mut reg = REGISTRY.lock().unwrap();
    let id = reg.next_id;
    reg.next_id += 1;
    reg.docs.insert(
        id,
        DocEntry {
            model: Model::NotLoaded,
            history: vec![path],
            pos: 0,
            rev: 0,
            saved_pos: if opened_from_disk { Some(0) } else { None },
            was_protected,
            origin: origin.clone(),
            save_path: if opened_from_disk { origin } else { None },
        },
    );
    Ok(DocumentInfo {
        id,
        title,
        path: path_str,
        pages,
        sizes,
        rev: 0,
        // Optimistic until the lazy parse proves otherwise; edit commands
        // surface a clear error if the file turns out unparseable.
        editable: true,
        // Created documents (blank/images/combined) start life unsaved.
        modified: !opened_from_disk,
        protected: was_protected,
    })
}

/// Re-read pages/sizes after a mutation and describe the current state.
fn refresh_info(id: u32, title_fallback: &str) -> Result<DocumentInfo, String> {
    let (work, rev, modified, editable, protected) = {
        let reg = REGISTRY.lock().unwrap();
        let entry = reg.docs.get(&id).ok_or("unknown document")?;
        (
            entry.work().clone(),
            entry.rev,
            entry.modified(),
            !matches!(entry.model, Model::Failed),
            entry.was_protected,
        )
    };
    let renderer = renderer()?;
    let pages = renderer.page_count(&work).map_err(|e| e.to_string())?;
    let sizes = renderer.page_sizes(&work).map_err(|e| e.to_string())?;
    Ok(DocumentInfo {
        id,
        title: title_fallback.to_string(),
        path: work.to_string_lossy().into_owned(),
        pages,
        sizes,
        rev,
        editable,
        modified,
        protected,
    })
}

/// Apply a mutation to the lopdf model and roll the work file forward.
fn mutate(
    id: u32,
    f: impl FnOnce(&mut TelosDocument) -> Result<(), telos_core::doc::DocError>,
) -> Result<(), String> {
    let mut reg = REGISTRY.lock().unwrap();
    let entry = reg.docs.get_mut(&id).ok_or("unknown document")?;
    let work = work_dir()?.join(format!("{id}-{}.pdf", entry.rev + 1));
    let doc = entry.ensure_model()?;
    f(doc).map_err(|e| e.to_string())?;
    doc.save_to(&work).map_err(|e| e.to_string())?;
    entry.push_state(work);
    Ok(())
}

/// Apply a PDFium-based mutation (Edit PDF): current work file → next work
/// file, then reload the lopdf model from the result so both engines agree.
/// Single-writer by construction — the UI serializes document mutations.
fn mutate_rendered(
    id: u32,
    f: impl FnOnce(&Renderer, &std::path::Path, &std::path::Path) -> Result<(), String>,
) -> Result<(), String> {
    let (src, rev) = {
        let reg = REGISTRY.lock().unwrap();
        let entry = reg.docs.get(&id).ok_or("unknown document")?;
        (entry.work().clone(), entry.rev)
    };
    let dest = work_dir()?.join(format!("{id}-{}.pdf", rev + 1));
    f(renderer()?, &src, &dest)?;

    let mut reg = REGISTRY.lock().unwrap();
    let entry = reg.docs.get_mut(&id).ok_or("unknown document")?;
    entry.push_state(dest);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageObjectEntry {
    index: u32,
    kind: String,
    /// (x, y, width, height) in PDF points, origin bottom-left.
    bounds: (f32, f32, f32, f32),
    text: Option<String>,
}

#[tauri::command]
async fn get_page_objects(id: u32, page_index: u32) -> Result<Vec<PageObjectEntry>, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let objects = renderer()?
        .page_objects(&work, page_index)
        .map_err(|e| e.to_string())?;
    Ok(objects
        .into_iter()
        .map(|o| PageObjectEntry {
            index: o.index,
            kind: o.kind,
            bounds: o.bounds,
            text: o.text,
        })
        .collect())
}

#[tauri::command]
async fn edit_text_object(
    id: u32,
    page_index: u32,
    object_index: u32,
    text: String,
    title: String,
) -> Result<DocumentInfo, String> {
    mutate_rendered(id, |r, src, dest| {
        r.edit_text_object(src, page_index, object_index, &text, dest)
            .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title)
}

#[tauri::command]
async fn delete_page_object(
    id: u32,
    page_index: u32,
    object_index: u32,
    title: String,
) -> Result<DocumentInfo, String> {
    mutate_rendered(id, |r, src, dest| {
        r.delete_page_object(src, page_index, object_index, dest)
            .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title)
}

#[tauri::command]
async fn add_text_object(
    id: u32,
    page_index: u32,
    x: f32,
    y: f32,
    text: String,
    font_size: f32,
    title: String,
) -> Result<DocumentInfo, String> {
    mutate_rendered(id, |r, src, dest| {
        r.add_text_object(src, page_index, x, y, &text, font_size, dest)
            .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title)
}

#[tauri::command]
async fn move_page_object(
    id: u32,
    page_index: u32,
    object_index: u32,
    dx: f32,
    dy: f32,
    title: String,
) -> Result<DocumentInfo, String> {
    mutate_rendered(id, |r, src, dest| {
        r.translate_page_object(src, page_index, object_index, dx, dy, dest)
            .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title)
}

#[tauri::command]
async fn replace_image_object(
    app: tauri::AppHandle,
    id: u32,
    page_index: u32,
    object_index: u32,
    title: String,
) -> Result<Option<DocumentInfo>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter(
            "Images",
            &["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "gif"],
        )
        .blocking_pick_file();
    let Some(file) = picked else { return Ok(None) };
    let image_path = file.into_path().map_err(|e| e.to_string())?;
    mutate_rendered(id, |r, src, dest| {
        r.replace_image_object(src, page_index, object_index, &image_path, dest)
            .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title).map(Some)
}

/// PDF → Text: extract all text to a .txt file. Returns the path, or None
/// if the user cancelled.
#[tauri::command]
async fn export_text(app: tauri::AppHandle, id: u32) -> Result<Option<String>, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let text = renderer()?.extract_text(&work).map_err(|e| e.to_string())?;
    let picked = app
        .dialog()
        .file()
        .add_filter("Text", &["txt"])
        .set_file_name("document.txt")
        .blocking_save_file();
    let Some(dest) = picked else { return Ok(None) };
    let dest = dest.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&dest, text).map_err(|e| e.to_string())?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

/// Locate LibreOffice's `soffice` for Office↔PDF conversion (not bundled —
/// ~1GB; detected if installed). Checks PATH and the standard app paths.
fn resolve_soffice() -> Option<PathBuf> {
    let candidates = [
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "/opt/homebrew/bin/soffice",
        "/usr/bin/soffice",
        "/usr/local/bin/soffice",
        "soffice",
    ];
    candidates
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.is_absolute() && p.exists())
        .or_else(|| {
            std::process::Command::new("soffice")
                .arg("--version")
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|_| PathBuf::from("soffice"))
        })
}

const OFFICE_MISSING: &str = "LibreOffice is required for Office conversions. Install it from libreoffice.org (macOS: `brew install --cask libreoffice`), then retry.";

/// Convert a file to `target_ext` via LibreOffice headless, into `out_dir`.
/// Returns the produced file path.
fn soffice_convert(
    src: &std::path::Path,
    target_ext: &str,
    infilter: Option<&str>,
    out_dir: &std::path::Path,
) -> Result<PathBuf, String> {
    let soffice = resolve_soffice().ok_or(OFFICE_MISSING)?;
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    // A private profile dir avoids clashing with a running LibreOffice.
    let profile = out_dir.join("lo-profile");
    let mut cmd = std::process::Command::new(&soffice);
    cmd.arg("--headless").arg("--norestore").arg(format!(
        "-env:UserInstallation=file://{}",
        profile.display()
    ));
    // PDF opens in Draw by default; forcing the Writer/Impress import filter
    // is what lets a PDF export to Word/PowerPoint.
    if let Some(filter) = infilter {
        cmd.arg(format!("--infilter={filter}"));
    }
    let out = cmd
        .arg("--convert-to")
        .arg(target_ext)
        .arg("--outdir")
        .arg(out_dir)
        .arg(src)
        .output()
        .map_err(|e| format!("running LibreOffice: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "conversion failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    // Output keeps the source stem with the new extension.
    let stem = src.file_stem().unwrap_or_default().to_string_lossy();
    let produced = out_dir.join(format!(
        "{stem}.{}",
        target_ext.split(':').next().unwrap_or(target_ext)
    ));
    if produced.exists() {
        Ok(produced)
    } else {
        Err("LibreOffice produced no output file.".into())
    }
}

/// Whether Office conversions are available (LibreOffice installed).
#[tauri::command]
fn office_available() -> bool {
    resolve_soffice().is_some()
}

/// Create a PDF from an Office/HTML file the user picks (Word, Excel,
/// PowerPoint, ODF, RTF, CSV, HTML). Opens the result as a new document.
#[tauri::command]
async fn create_from_office(app: tauri::AppHandle) -> Result<Option<DocumentInfo>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter(
            "Documents",
            &[
                "docx", "doc", "odt", "rtf", "xlsx", "xls", "ods", "csv", "pptx", "ppt", "odp",
                "html", "htm", "txt",
            ],
        )
        .blocking_pick_file();
    let Some(file) = picked else { return Ok(None) };
    let src = file.into_path().map_err(|e| e.to_string())?;
    let out_dir = work_dir()?.join(format!(
        "topdf-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
    ));
    let pdf = soffice_convert(&src, "pdf", None, &out_dir)?;
    open_at(pdf, false).map(Some)
}

/// Export the current PDF to an Office format (docx, xlsx, pptx) via
/// LibreOffice, saved next to a location the user picks.
#[tauri::command]
async fn export_office(
    app: tauri::AppHandle,
    id: u32,
    target: String,
    title: String,
) -> Result<Option<String>, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let (ext, infilter) = match target.as_str() {
        "word" => ("docx", "writer_pdf_import"),
        "ppt" => ("pptx", "impress_pdf_import"),
        _ => return Err("Unsupported target (Word and PowerPoint only).".into()),
    };
    let out_dir = work_dir()?.join(format!("frompdf-{id}"));
    let _ = std::fs::remove_dir_all(&out_dir);
    let produced = soffice_convert(&work, ext, Some(infilter), &out_dir)?;

    let base = title.trim_end_matches(".pdf");
    let dest = app
        .dialog()
        .file()
        .add_filter(ext.to_uppercase(), &[ext])
        .set_file_name(format!("{base}.{ext}"))
        .blocking_save_file();
    let Some(dest) = dest else { return Ok(None) };
    let dest = dest.into_path().map_err(|e| e.to_string())?;
    std::fs::copy(&produced, &dest).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&out_dir);
    Ok(Some(dest.to_string_lossy().into_owned()))
}

/// PDF → HTML: extract text and emit a simple, readable HTML document.
#[tauri::command]
async fn export_html(
    app: tauri::AppHandle,
    id: u32,
    title: String,
) -> Result<Option<String>, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let text = renderer()?.extract_text(&work).map_err(|e| e.to_string())?;
    let escape = |t: &str| {
        t.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let mut body = String::new();
    for (i, page) in text.split('\u{c}').enumerate() {
        body.push_str(&format!("<section class=\"page\"><h2>Page {}</h2>", i + 1));
        for para in page.split("\n\n") {
            let para = para.trim();
            if !para.is_empty() {
                body.push_str(&format!("<p>{}</p>", escape(para).replace('\n', "<br>")));
            }
        }
        body.push_str("</section>");
    }
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title>\
         <style>body{{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6}}\
         .page{{border-bottom:1px solid #ddd;padding-bottom:24px;margin-bottom:24px}}h2{{color:#888;font-size:14px}}</style>\
         </head><body>{}</body></html>",
        escape(&title),
        body
    );
    let base = title.trim_end_matches(".pdf");
    let picked = app
        .dialog()
        .file()
        .add_filter("HTML", &["html"])
        .set_file_name(format!("{base}.html"))
        .blocking_save_file();
    let Some(dest) = picked else { return Ok(None) };
    let dest = dest.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&dest, html).map_err(|e| e.to_string())?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

/// PDF → Word: extracted text as paragraphs in a .docx. Layout-faithful
/// conversion is future work; this preserves the readable text.
#[tauri::command]
async fn export_docx(
    app: tauri::AppHandle,
    id: u32,
    title: String,
) -> Result<Option<String>, String> {
    use docx_rs::*;
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let text = renderer()?.extract_text(&work).map_err(|e| e.to_string())?;
    let base = title.trim_end_matches(".pdf");
    let picked = app
        .dialog()
        .file()
        .add_filter("Word", &["docx"])
        .set_file_name(format!("{base}.docx"))
        .blocking_save_file();
    let Some(dest) = picked else { return Ok(None) };
    let dest = dest.into_path().map_err(|e| e.to_string())?;

    let mut docx = Docx::new();
    for raw in text.split('\u{c}') {
        for line in raw.split('\n') {
            let line = line.trim_end();
            docx = docx.add_paragraph(Paragraph::new().add_run(Run::new().add_text(line)));
        }
    }
    let file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
    docx.build().pack(file).map_err(|e| e.to_string())?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

/// PDF → Images: render every page as a PNG into a chosen folder. Returns
/// the page count, or None if the user cancelled.
#[tauri::command]
async fn export_images(app: tauri::AppHandle, id: u32) -> Result<Option<u32>, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(folder) = picked else {
        return Ok(None);
    };
    let folder = folder.into_path().map_err(|e| e.to_string())?;

    let renderer = renderer()?;
    let pages = renderer.page_count(&work).map_err(|e| e.to_string())?;
    for i in 0..pages {
        let png = renderer
            .render_page_png(&work, i, 1600, 0)
            .map_err(|e| e.to_string())?;
        std::fs::write(folder.join(format!("page-{:04}.png", i + 1)), png)
            .map_err(|e| e.to_string())?;
    }
    Ok(Some(pages))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextSegmentEntry {
    /// (x, y, width, height) in PDF points, origin bottom-left.
    bounds: (f32, f32, f32, f32),
    text: String,
}

#[tauri::command]
async fn get_text_segments(id: u32, page_index: u32) -> Result<Vec<TextSegmentEntry>, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let segments = renderer()?
        .text_segments(&work, page_index)
        .map_err(|e| e.to_string())?;
    Ok(segments
        .into_iter()
        .map(|s| TextSegmentEntry {
            bounds: s.bounds,
            text: s.text,
        })
        .collect())
}

/// Pick 2+ PDFs and merge them, in pick order, into a new document.
#[tauri::command]
async fn combine_documents(app: tauri::AppHandle) -> Result<Option<DocumentInfo>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF documents", &["pdf"])
        .blocking_pick_files();
    let Some(files) = picked else {
        return Ok(None);
    };
    let paths: Vec<PathBuf> = files
        .into_iter()
        .map(|f| f.into_path().map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;
    if paths.len() < 2 {
        return Err("Pick at least two PDFs to combine.".into());
    }
    let out = work_dir()?.join(format!(
        "combined-{}.pdf",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
    ));
    telos_core::doc::merge_documents(&paths, &out).map_err(|e| e.to_string())?;
    open_at(out, false).map(Some)
}

/// Open a path arriving from the OS (file association / argv): deliver to
/// the frontend if it's ready, else queue for frontend_ready.
fn open_external(app: &tauri::AppHandle, path: PathBuf) {
    if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("pdf") {
        return;
    }
    match open_at(path, true) {
        Ok(info) => {
            let ready = *FRONTEND_READY.lock().unwrap();
            if ready {
                let _ = app.emit_to("main", "open-file", info);
            } else {
                PENDING_OPENS.lock().unwrap().push(info);
            }
        }
        Err(e) => eprintln!("open-external failed: {e}"),
    }
}

/// Frontend booted: close the splash, show the main window, and hand over
/// any documents the OS asked us to open meanwhile.
#[tauri::command]
async fn frontend_ready(app: tauri::AppHandle) -> Result<Vec<DocumentInfo>, String> {
    *FRONTEND_READY.lock().unwrap() = true;
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    Ok(std::mem::take(&mut *PENDING_OPENS.lock().unwrap()))
}

/// macOS: LaunchServices default-handler check/set for PDFs. Other
/// platforms report "already default" so the UI never prompts (installer
/// association covers them).
#[cfg(target_os = "macos")]
mod pdf_default {
    use std::ffi::{CString, c_char, c_void};

    type CFStringRef = *const c_void;
    const UTF8: u32 = 0x0800_0100;
    const ROLES_ALL: u32 = 0xFFFF_FFFF;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(a: *const c_void, s: *const c_char, e: u32) -> CFStringRef;
        fn CFStringGetCString(s: CFStringRef, buf: *mut c_char, size: isize, e: u32) -> bool;
        fn CFRelease(r: *const c_void);
    }
    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn LSCopyDefaultRoleHandlerForContentType(t: CFStringRef, role: u32) -> CFStringRef;
        fn LSSetDefaultRoleHandlerForContentType(t: CFStringRef, role: u32, b: CFStringRef) -> i32;
    }

    fn cfstr(s: &str) -> CFStringRef {
        let c = CString::new(s).unwrap();
        unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8) }
    }

    pub fn current_handler() -> Option<String> {
        unsafe {
            let pdf = cfstr("com.adobe.pdf");
            let handler = LSCopyDefaultRoleHandlerForContentType(pdf, ROLES_ALL);
            CFRelease(pdf);
            if handler.is_null() {
                return None;
            }
            let mut buf = [0 as c_char; 512];
            let ok = CFStringGetCString(handler, buf.as_mut_ptr(), buf.len() as isize, UTF8);
            CFRelease(handler);
            if !ok {
                return None;
            }
            Some(
                std::ffi::CStr::from_ptr(buf.as_ptr())
                    .to_string_lossy()
                    .into_owned(),
            )
        }
    }

    pub fn set_self() -> Result<(), String> {
        unsafe {
            let pdf = cfstr("com.adobe.pdf");
            let me = cfstr("app.telospdf");
            let status = LSSetDefaultRoleHandlerForContentType(pdf, ROLES_ALL, me);
            CFRelease(pdf);
            CFRelease(me);
            if status == 0 {
                Ok(())
            } else {
                Err(format!(
                    "LaunchServices refused (status {status}). This works in the installed app bundle."
                ))
            }
        }
    }
}

#[tauri::command]
fn is_default_pdf_handler() -> bool {
    #[cfg(target_os = "macos")]
    {
        pdf_default::current_handler()
            .map(|h| h.eq_ignore_ascii_case("app.telospdf"))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
fn set_default_pdf_handler() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        pdf_default::set_self()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Set the default PDF app in your system settings.".into())
    }
}

fn open_at(path: PathBuf, from_disk: bool) -> Result<DocumentInfo, String> {
    let origin = if from_disk { Some(path.clone()) } else { None };
    if !path.is_file() {
        return Err(format!("file not found: {}", path.display()));
    }
    // Password-protected files must be unlocked first (the frontend prompts
    // and calls unlock_document with this same path). Some encryption schemes
    // make PDFium report a format error rather than a password error, so we
    // also treat a load failure on a detectably-encrypted file as needing a
    // password.
    let encrypted = telos_core::doc::is_encrypted(&path);
    match renderer()?.needs_password(&path) {
        Ok(true) => return Err(format!("PASSWORD_REQUIRED:{}", path.display())),
        Ok(false) => {}
        Err(e) => {
            if encrypted {
                return Err(format!("PASSWORD_REQUIRED:{}", path.display()));
            }
            return Err(format!("Could not open file: {e}"));
        }
    }
    // No structural parse here — opening must be render-path only. The
    // lopdf model loads lazily on the first edit (DocEntry::ensure_model).
    let title = renderer()?
        .title(&path)
        .ok()
        .flatten()
        .or_else(|| path.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "Untitled".into());
    register(path, title, from_disk, false, origin)
}

/// Open a specific file (Welcome-tab recents).
#[tauri::command]
async fn open_document_path(path: String) -> Result<DocumentInfo, String> {
    open_at(PathBuf::from(path), true)
}

#[tauri::command]
async fn open_document(app: tauri::AppHandle) -> Result<Option<DocumentInfo>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF documents", &["pdf"])
        .blocking_pick_file();
    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    open_at(path, true).map(Some)
}

#[tauri::command]
async fn create_document() -> Result<DocumentInfo, String> {
    let path = work_dir()?.join(format!(
        "untitled-{}.pdf",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
    ));
    telos_core::doc::create_blank(&path).map_err(|e| e.to_string())?;
    register(path, "Untitled.pdf".into(), false, false, None)
}

/// Pick images and build a one-page-per-image PDF (opens as a new document).
#[tauri::command]
async fn create_document_from_images(
    app: tauri::AppHandle,
) -> Result<Option<DocumentInfo>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter(
            "Images",
            &["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "gif"],
        )
        .blocking_pick_files();
    let Some(files) = picked else {
        return Ok(None);
    };
    let paths: Vec<PathBuf> = files
        .into_iter()
        .map(|f| f.into_path().map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;
    if paths.is_empty() {
        return Ok(None);
    }

    let out = work_dir()?.join(format!(
        "images-{}.pdf",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
    ));
    telos_core::doc::create_from_images(&paths, &out).map_err(|e| e.to_string())?;
    open_at(out, false).map(Some)
}

/// Unlock a password-protected file: decrypt into a work copy that the
/// rest of the app (rendering, edits) uses with no password anywhere.
#[tauri::command]
async fn unlock_document(path: String, password: String) -> Result<DocumentInfo, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err(format!("file not found: {path}"));
    }
    let dest = work_dir()?.join(format!(
        "unlocked-{}.pdf",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
    ));
    telos_core::doc::unlock_to(&src, &dest, &password).map_err(|e| e.to_string())?;
    let title = src
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled".into());
    register(dest, title, true, true, Some(src))
}

/// Write a password-protected (AES-128) copy to a user-chosen location.
/// The open document itself stays unlocked.
#[tauri::command]
async fn protect_document(
    app: tauri::AppHandle,
    id: u32,
    user_password: String,
    owner_password: String,
    allow_print: bool,
    allow_copy: bool,
    allow_modify: bool,
    allow_annotate: bool,
    title: String,
) -> Result<Option<String>, String> {
    if user_password.is_empty() {
        return Err("A password is required.".into());
    }
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let base = title.trim_end_matches(".pdf");
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF documents", &["pdf"])
        .set_file_name(format!("{base}-protected.pdf"))
        .blocking_save_file();
    let Some(dest) = picked else {
        return Ok(None);
    };
    let dest = dest.into_path().map_err(|e| e.to_string())?;
    telos_core::doc::protect_to(
        &work,
        &dest,
        &user_password,
        &owner_password,
        telos_core::doc::ProtectPermissions {
            print: allow_print,
            copy: allow_copy,
            modify: allow_modify,
            annotate: allow_annotate,
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompressResult {
    path: String,
    before: u64,
    after: u64,
    images_downsampled: u32,
}

/// Write a compressed copy via Save As. `target_dpi = None` is the
/// lossless/structural-only preset.
#[tauri::command]
async fn compress_document(
    app: tauri::AppHandle,
    id: u32,
    target_dpi: Option<u32>,
    title: String,
) -> Result<Option<CompressResult>, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let base = title.trim_end_matches(".pdf");
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF documents", &["pdf"])
        .set_file_name(format!("{base}-compressed.pdf"))
        .blocking_save_file();
    let Some(dest) = picked else {
        return Ok(None);
    };
    let dest = dest.into_path().map_err(|e| e.to_string())?;

    let before = std::fs::metadata(&work).map_err(|e| e.to_string())?.len();
    let mut images_downsampled = 0u32;
    let staged = work_dir()?.join(format!("compress-{id}.pdf"));
    let structural_src = if let Some(dpi) = target_dpi {
        images_downsampled = renderer()?
            .downsample_images(&work, dpi.clamp(50, 600), &staged)
            .map_err(|e| e.to_string())?;
        staged.clone()
    } else {
        work.clone()
    };
    telos_core::doc::compact_to(&structural_src, &dest).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&staged);

    // Compression is best-effort: if the pipeline grew the file (tiny or
    // already-optimal documents), fall back to a plain copy.
    let mut after = std::fs::metadata(&dest).map_err(|e| e.to_string())?.len();
    if after >= before {
        std::fs::copy(&work, &dest).map_err(|e| e.to_string())?;
        after = before;
        images_downsampled = 0;
    }
    Ok(Some(CompressResult {
        path: dest.to_string_lossy().into_owned(),
        before,
        after,
        images_downsampled,
    }))
}

/// Remove password protection, producing an unlocked working copy. Works
/// for files opened via the unlock prompt AND owner/permission-password
/// files (which open without a prompt). The document is shown unlocked and
/// marked unsaved; the title gains a `_UNLOCKED` suffix and Save As
/// (Cmd+S) defaults to the original folder.
#[tauri::command]
async fn remove_password(id: u32, title: String) -> Result<DocumentInfo, String> {
    let (work, was_protected, origin) = {
        let reg = REGISTRY.lock().unwrap();
        let entry = reg.docs.get(&id).ok_or("unknown document")?;
        (
            entry.work().clone(),
            entry.was_protected,
            entry.origin.clone(),
        )
    };

    if !was_protected {
        // Not opened via the unlock flow — check for owner/permission
        // encryption we can strip with an empty user password.
        let source = origin.clone().unwrap_or_else(|| work.clone());
        let unlocked = work_dir()?.join(format!("{id}-nopass.pdf"));
        match telos_core::doc::unlock_to(&source, &unlocked, "") {
            Ok(()) => {
                let mut reg = REGISTRY.lock().unwrap();
                let entry = reg.docs.get_mut(&id).ok_or("unknown document")?;
                entry.push_state(unlocked);
                entry.saved_pos = None;
            }
            Err(telos_core::doc::DocError::NotProtected) => {
                return Err("This document isn't password-protected.".into());
            }
            Err(e) => return Err(e.to_string()),
        }
    } else {
        // Already decrypted in the work copy — just mark unsaved.
        let mut reg = REGISTRY.lock().unwrap();
        let entry = reg.docs.get_mut(&id).ok_or("unknown document")?;
        entry.was_protected = false;
        entry.saved_pos = None;
    }

    // Suggested name: <stem>_UNLOCKED.pdf.
    let base = title
        .strip_suffix(".pdf")
        .or_else(|| title.strip_suffix(".PDF"))
        .unwrap_or(&title);
    let unlocked_title = format!("{base}_UNLOCKED.pdf");
    {
        let mut reg = REGISTRY.lock().unwrap();
        if let Some(entry) = reg.docs.get_mut(&id) {
            entry.save_path = None; // never overwrite the protected original
        }
    }
    refresh_info(id, &unlocked_title)
}

/// Save (Cmd+S): write directly to the document's file if it has one. Ok(Some)
/// = saved, Ok(None) = nothing to save (already saved), Err(NEEDS_SAVE_AS) =
/// no file yet → the frontend runs Save As.
#[tauri::command]
async fn save_document(id: u32, title: String) -> Result<Option<DocumentInfo>, String> {
    let (work, save_path, modified) = {
        let reg = REGISTRY.lock().unwrap();
        let entry = reg.docs.get(&id).ok_or("unknown document")?;
        (
            entry.work().clone(),
            entry.save_path.clone(),
            entry.modified(),
        )
    };
    let Some(dest) = save_path else {
        return Err("NEEDS_SAVE_AS".into());
    };
    if !modified {
        return Ok(None);
    }
    std::fs::copy(&work, &dest).map_err(|e| format!("could not save: {e}"))?;
    {
        let mut reg = REGISTRY.lock().unwrap();
        let entry = reg.docs.get_mut(&id).ok_or("unknown document")?;
        entry.saved_pos = Some(entry.pos);
    }
    refresh_info(id, &title).map(Some)
}

/// Save the document's current state to a user-chosen location. The entry
/// then points at the saved file, so further edits revise it.
#[tauri::command]
async fn save_document_as(
    app: tauri::AppHandle,
    id: u32,
    title: String,
) -> Result<Option<DocumentInfo>, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let suggested = if title.to_lowercase().ends_with(".pdf") {
        title.clone()
    } else {
        format!("{title}.pdf")
    };
    let origin_dir = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs
            .get(&id)
            .and_then(|e| e.origin.as_ref())
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    };
    let mut builder = app
        .dialog()
        .file()
        .add_filter("PDF documents", &["pdf"])
        .set_file_name(&suggested);
    if let Some(dir) = origin_dir {
        builder = builder.set_directory(dir);
    }
    let picked = builder.blocking_save_file();
    let Some(dest) = picked else {
        return Ok(None);
    };
    let dest = dest.into_path().map_err(|e| e.to_string())?;
    std::fs::copy(&work, &dest).map_err(|e| format!("could not save: {e}"))?;

    {
        let mut reg = REGISTRY.lock().unwrap();
        let entry = reg.docs.get_mut(&id).ok_or("unknown document")?;
        // The saved file becomes the document's new baseline; undo history
        // before the save is released (temp files only).
        let work = work_dir()?;
        for old in entry.history.drain(..) {
            if old.starts_with(&work) {
                let _ = std::fs::remove_file(old);
            }
        }
        entry.history = vec![dest.clone()];
        entry.pos = 0;
        entry.saved_pos = Some(0);
        entry.model = Model::NotLoaded;
        entry.origin = Some(dest.clone());
        entry.save_path = Some(dest);
        entry.was_protected = false;
    }
    refresh_info(id, &title).map(Some)
}

/// Move one page to a new position (Organize drag-reorder).
#[tauri::command]
async fn move_page(
    id: u32,
    from_index: u32,
    to_index: u32,
    title: String,
) -> Result<DocumentInfo, String> {
    let pages = {
        let reg = REGISTRY.lock().unwrap();
        let entry = reg.docs.get(&id).ok_or("unknown document")?;
        renderer()?
            .page_count(entry.work())
            .map_err(|e| e.to_string())?
    };
    if from_index >= pages || to_index >= pages {
        return Err("page out of range".into());
    }
    let mut order: Vec<u32> = (0..pages).collect();
    let moved = order.remove(from_index as usize);
    order.insert(to_index as usize, moved);
    mutate_rendered(id, |r, src, dest| {
        r.restructure_pages(src, &order, dest)
            .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title)
}

#[tauri::command]
async fn insert_blank_page(id: u32, at_index: u32, title: String) -> Result<DocumentInfo, String> {
    mutate_rendered(id, |r, src, dest| {
        r.insert_blank_page(src, at_index, dest)
            .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title)
}

/// Extract the selected pages (0-based) into a new document.
#[tauri::command]
async fn extract_pages(id: u32, pages: Vec<u32>) -> Result<DocumentInfo, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let out = work_dir()?.join(format!(
        "extract-{}.pdf",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
    ));
    renderer()?
        .restructure_pages(&work, &pages, &out)
        .map_err(|e| e.to_string())?;
    open_at(out, false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FormFieldEntry {
    annotation_index: u32,
    name: String,
    kind: String,
    value: Option<String>,
    checked: Option<bool>,
    options: Vec<String>,
    bounds: (f32, f32, f32, f32),
}

#[tauri::command]
async fn get_form_fields(id: u32, page_index: u32) -> Result<Vec<FormFieldEntry>, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let fields = renderer()?
        .form_fields(&work, page_index)
        .map_err(|e| e.to_string())?;
    Ok(fields
        .into_iter()
        .map(|f| FormFieldEntry {
            annotation_index: f.annotation_index,
            name: f.name,
            kind: f.kind,
            value: f.value,
            checked: f.checked,
            options: f.options,
            bounds: f.bounds,
        })
        .collect())
}

#[tauri::command]
async fn set_form_field(
    id: u32,
    page_index: u32,
    annotation_index: u32,
    value: Option<String>,
    checked: Option<bool>,
    title: String,
) -> Result<DocumentInfo, String> {
    mutate_rendered(id, |r, src, dest| {
        r.set_form_field(
            src,
            page_index,
            annotation_index,
            value.as_deref(),
            checked,
            dest,
        )
        .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title)
}

/// Place an image (base64 PNG/JPEG, e.g. a drawn signature) on a page.
#[tauri::command]
async fn place_image(
    id: u32,
    page_index: u32,
    x: f32,
    y: f32,
    width_pt: f32,
    image_base64: String,
    title: String,
) -> Result<DocumentInfo, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64.trim_start_matches("data:image/png;base64,"))
        .map_err(|e| format!("bad image data: {e}"))?;
    mutate_rendered(id, |r, src, dest| {
        r.add_image_object(src, page_index, x, y, width_pt, &bytes, dest)
            .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title)
}

/// Optional Unlimited-OCR (Baidu, 3B) model files — downloaded on demand from
/// Settings → OCR into the app data dir. (name, url, minimum plausible size).
const OCR_MODEL_FILES: &[(&str, &str, u64)] = &[
    (
        "unlimited-ocr-Q4_K_M.gguf",
        "https://huggingface.co/sabafallah/Unlimited-OCR-GGUF/resolve/main/unlimited-ocr-Q4_K_M.gguf",
        1_800_000_000,
    ),
    (
        "mmproj-unlimited-ocr-q8_0.gguf",
        "https://huggingface.co/sabafallah/Unlimited-OCR-GGUF/resolve/main/mmproj-unlimited-ocr-q8_0.gguf",
        400_000_000,
    ),
];

/// Pinned llama.cpp release providing `llama-mtmd-cli` (Unlimited-OCR
/// inference). Bump together after testing a newer build.
const LLAMA_TAG: &str = "b10092";

fn llama_asset() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("llama-b10092-bin-macos-arm64.tar.gz"),
        ("macos", _) => Ok("llama-b10092-bin-macos-x64.tar.gz"),
        ("windows", _) => Ok("llama-b10092-bin-win-cpu-x64.zip"),
        ("linux", _) => Ok("llama-b10092-bin-ubuntu-x64.tar.gz"),
        (os, arch) => Err(format!("no llama.cpp runtime published for {os}-{arch}")),
    }
}

/// Locate llama-mtmd-cli anywhere under the runtime dir (archives nest it
/// differently per platform).
fn find_mtmd(dir: &std::path::Path) -> Option<PathBuf> {
    let names = ["llama-mtmd-cli", "llama-mtmd-cli.exe"];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if names.iter().any(|n| p.file_name().is_some_and(|f| f == *n)) {
                return Some(p);
            }
        }
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OcrModelStatus {
    installed: bool,
    dir: String,
    bytes: u64,
}

fn ocr_model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models")
        .join("unlimited-ocr");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn ocr_model_state(dir: &std::path::Path) -> OcrModelStatus {
    let mut bytes = 0;
    let mut installed = true;
    for (name, _, min) in OCR_MODEL_FILES {
        match std::fs::metadata(dir.join(name)) {
            Ok(m) if m.len() >= *min => bytes += m.len(),
            _ => installed = false,
        }
    }
    // "Installed" means runnable: weights AND the inference runtime.
    if find_mtmd(&dir.join("runtime")).is_none() {
        installed = false;
    }
    OcrModelStatus {
        installed,
        dir: dir.display().to_string(),
        bytes,
    }
}

#[tauri::command]
fn ocr_model_status(app: tauri::AppHandle) -> Result<OcrModelStatus, String> {
    Ok(ocr_model_state(&ocr_model_dir(&app)?))
}

/// Kill orphaned curl writers from a previous app run before (re)starting a
/// download — children outlive the app, and two curls appending to the same
/// `.part` file corrupt it.
fn kill_stale_download(part: &std::path::Path) {
    #[cfg(unix)]
    {
        if let Some(name) = part.file_name().and_then(|n| n.to_str()) {
            let _ = std::process::Command::new("pkill").args(["-f", name]).status();
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = part;
    }
}

/// Content-Length of a remote file (final redirect target), if reported.
fn remote_size(url: &str) -> Option<u64> {
    let out = std::process::Command::new("curl")
        .args(["-sIL", url])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.to_ascii_lowercase().starts_with("content-length:"))
        .last()
        .and_then(|l| l.split(':').nth(1)?.trim().parse().ok())
}

/// Download the Unlimited-OCR weights (~2.4 GB total) with the system curl,
/// resumable via `.part` files. Runs on a blocking thread — sync commands
/// execute on the MAIN thread and would beachball the app — and emits
/// `ocr-model-progress` {downloaded, total} while curl writes.
#[tauri::command]
async fn download_ocr_model(app: tauri::AppHandle) -> Result<OcrModelStatus, String> {
    tauri::async_runtime::spawn_blocking(move || download_ocr_model_blocking(app))
        .await
        .map_err(|e| e.to_string())?
}

fn download_ocr_model_blocking(app: tauri::AppHandle) -> Result<OcrModelStatus, String> {
    use tauri::Emitter;
    let dir = ocr_model_dir(&app)?;
    let runtime_dir = dir.join("runtime");
    let runtime_asset = llama_asset()?;
    let runtime_url = format!(
        "https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/{runtime_asset}"
    );
    let runtime_total = remote_size(&runtime_url).unwrap_or(30_000_000);
    let totals: Vec<u64> = OCR_MODEL_FILES
        .iter()
        .map(|(_, url, min)| remote_size(url).unwrap_or(*min))
        .collect();
    let total: u64 = totals.iter().sum::<u64>() + runtime_total;
    let mut done_base: u64 = 0;
    for (idx, (name, url, min)) in OCR_MODEL_FILES.iter().enumerate() {
        let dest = dir.join(name);
        if std::fs::metadata(&dest).map(|m| m.len() >= *min).unwrap_or(false) {
            done_base += totals[idx];
            continue;
        }
        let part = dir.join(format!("{name}.part"));
        kill_stale_download(&part);
        let mut child = std::process::Command::new("curl")
            .args([
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--continue-at",
                "-",
                "--output",
            ])
            .arg(&part)
            .arg(*url)
            .spawn()
            .map_err(|e| format!("running curl: {e}"))?;
        loop {
            let part_len = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            let _ = app.emit(
                "ocr-model-progress",
                serde_json::json!({ "downloaded": done_base + part_len, "total": total }),
            );
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) if status.success() => break,
                Some(_) => {
                    return Err(format!(
                        "download failed for {url} — check your connection and retry (resumes where it left off)"
                    ));
                }
                None => std::thread::sleep(std::time::Duration::from_millis(300)),
            }
        }
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
        done_base += totals[idx];
    }

    // The llama.cpp runtime (llama-mtmd-cli) that actually runs the model.
    if find_mtmd(&runtime_dir).is_none() {
        std::fs::create_dir_all(&runtime_dir).map_err(|e| e.to_string())?;
        let archive = runtime_dir.join(runtime_asset);
        kill_stale_download(&archive);
        let mut child = std::process::Command::new("curl")
            .args([
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--continue-at",
                "-",
                "--output",
            ])
            .arg(&archive)
            .arg(&runtime_url)
            .spawn()
            .map_err(|e| format!("running curl: {e}"))?;
        loop {
            let len = std::fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
            let _ = app.emit(
                "ocr-model-progress",
                serde_json::json!({ "downloaded": done_base + len, "total": total }),
            );
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) if status.success() => break,
                Some(_) => return Err(format!("download failed for {runtime_url}")),
                None => std::thread::sleep(std::time::Duration::from_millis(300)),
            }
        }
        // bsdtar (macOS/Windows) reads both .tar.gz and .zip; GNU tar covers
        // the Linux .tar.gz.
        let status = std::process::Command::new("tar")
            .arg("-xf")
            .arg(&archive)
            .arg("-C")
            .arg(&runtime_dir)
            .status()
            .map_err(|e| format!("running tar: {e}"))?;
        if !status.success() {
            return Err("extracting the llama.cpp runtime failed".into());
        }
        let _ = std::fs::remove_file(&archive);
        if find_mtmd(&runtime_dir).is_none() {
            return Err("runtime archive did not contain llama-mtmd-cli".into());
        }
    }

    let _ = app.emit(
        "ocr-model-progress",
        serde_json::json!({ "downloaded": total, "total": total }),
    );
    Ok(ocr_model_state(&dir))
}

/// Locate a runnable Tesseract: the app-bundled copy first (`.ocr/<plat>`
/// next to the binary/project, or in the packaged Resources dir), then a
/// system install. Returns (binary, Some(tessdata_dir)) for the bundle, or
/// (binary, None) for a system tesseract that finds its own data.
fn resolve_tesseract() -> Option<(PathBuf, Option<PathBuf>)> {
    let runs = |bin: &std::path::Path, tessdata: Option<&std::path::Path>| -> bool {
        let mut c = std::process::Command::new(bin);
        if let Some(d) = tessdata {
            c.env("TESSDATA_PREFIX", d);
        }
        c.arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };

    let plat = telos_core::render::host_platform();
    let mut roots: Vec<PathBuf> = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR"))];
    if let Ok(exe) = std::env::current_exe() {
        roots.push(exe);
    }
    for root in roots {
        let mut cur: Option<&std::path::Path> = Some(root.as_path());
        while let Some(dir) = cur {
            for base in [dir.join(".ocr"), dir.join("Resources").join(".ocr")] {
                let bin = base.join(plat).join("bin").join("tesseract");
                let data = base.join(plat).join("tessdata");
                if bin.is_file() && runs(&bin, Some(&data)) {
                    return Some((bin, Some(data)));
                }
            }
            cur = dir.parent();
        }
    }

    for bin in [
        "/opt/homebrew/bin/tesseract",
        "/usr/local/bin/tesseract",
        "/usr/bin/tesseract",
        "tesseract",
    ] {
        let path = PathBuf::from(bin);
        if runs(&path, None) {
            return Some((path, None));
        }
    }
    None
}

/// Parse Unlimited-OCR grounding output — `<|ref|>text<|/ref|><|det|>[[x1,
/// y1, x2, y2]]<|/det|>` blocks, coordinates normalised 0–1000 with a
/// top-left origin — into PDF-point blocks (bottom-left origin). Output with
/// no grounding markers falls back to one page-sized block so the text is
/// still searchable.
fn parse_grounding(raw: &str, w_pt: f32, h_pt: f32) -> Vec<telos_core::doc::OcrBlock> {
    use telos_core::doc::OcrBlock;
    let mut blocks = Vec::new();
    let mut rest = raw;
    while let Some(s) = rest.find("<|ref|>") {
        let after = &rest[s + 7..];
        let Some(e) = after.find("<|/ref|>") else { break };
        let text = &after[..e];
        rest = &after[e + 8..];
        let Some(ds) = rest.find("<|det|>") else { continue };
        let after_det = &rest[ds + 7..];
        let Some(de) = after_det.find("<|/det|>") else { continue };
        let nums: Vec<f32> = after_det[..de]
            .split(|c: char| !c.is_ascii_digit() && c != '.')
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse().ok())
            .collect();
        if nums.len() >= 4 && !text.trim().is_empty() {
            let (x1, y1, x2, y2) = (nums[0], nums[1], nums[2], nums[3]);
            blocks.push(OcrBlock {
                text: text.to_string(),
                x: x1 / 1000.0 * w_pt,
                y: h_pt - y2 / 1000.0 * h_pt,
                w: ((x2 - x1) / 1000.0 * w_pt).max(1.0),
                h: ((y2 - y1) / 1000.0 * h_pt).max(1.0),
            });
        }
        rest = &after_det[de + 8..];
    }
    if blocks.is_empty() {
        let text = raw.trim();
        if !text.is_empty() {
            blocks.push(OcrBlock {
                text: text.to_string(),
                x: 0.0,
                y: 0.0,
                w: w_pt,
                h: h_pt,
            });
        }
    }
    blocks
}

/// Dedicated translation model (Qwen3, Apache-2.0) — the OCR model's decoder
/// hallucinates its training data when asked to translate, so Translate PDF
/// runs on this instead. Shares the llama.cpp runtime with Unlimited-OCR.
const TRANSLATE_MODEL: (&str, &str, u64) = (
    "Qwen3-1.7B-Q8_0.gguf",
    "https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf",
    1_700_000_000,
);

fn translate_model_ready(dir: &std::path::Path) -> bool {
    std::fs::metadata(dir.join(TRANSLATE_MODEL.0))
        .map(|m| m.len() >= TRANSLATE_MODEL.2)
        .unwrap_or(false)
        && find_mtmd(&dir.join("runtime")).is_some()
}

/// Target-language → Google Translate code (the dialog's fixed target list).
fn google_lang_code(language: &str) -> &'static str {
    match language {
        "Spanish" => "es",
        "French" => "fr",
        "German" => "de",
        "Italian" => "it",
        "Portuguese" => "pt",
        "Dutch" => "nl",
        "Indonesian" => "id",
        "Swahili" => "sw",
        _ => "en",
    }
}

/// Cloud path: the user's own Google Cloud Translation API key. Explicit
/// opt-in — this sends the page text to Google.
fn cloud_translate(text: &str, target: &str, key: &str) -> Result<String, String> {
    use std::io::Write;
    let body =
        serde_json::json!({ "q": text, "target": target, "format": "text" }).to_string();
    let mut child = std::process::Command::new("curl")
        .args(["-s", "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@-"])
        .arg(format!(
            "https://translation.googleapis.com/language/translate/v2?key={key}"
        ))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("running curl: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("curl stdin unavailable")?
        .write_all(body.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|_| "Google returned an unreadable response — check your connection".to_string())?;
    if let Some(msg) = v["error"]["message"].as_str() {
        return Err(format!("Google Translate: {msg}"));
    }
    v["data"]["translations"][0]["translatedText"]
        .as_str()
        .map(|t| t.to_string())
        .ok_or_else(|| "Google returned no translation".to_string())
}

#[tauri::command]
fn translate_model_status(app: tauri::AppHandle) -> Result<OcrModelStatus, String> {
    let dir = ocr_model_dir(&app)?;
    Ok(OcrModelStatus {
        installed: translate_model_ready(&dir),
        dir: dir.display().to_string(),
        bytes: std::fs::metadata(dir.join(TRANSLATE_MODEL.0)).map(|m| m.len()).unwrap_or(0),
    })
}

/// Download the translation model (and the shared llama.cpp runtime if it
/// isn't there yet), with `translate-model-progress` events.
#[tauri::command]
async fn download_translate_model(app: tauri::AppHandle) -> Result<OcrModelStatus, String> {
    tauri::async_runtime::spawn_blocking(move || download_translate_model_blocking(app))
        .await
        .map_err(|e| e.to_string())?
}

fn download_translate_model_blocking(app: tauri::AppHandle) -> Result<OcrModelStatus, String> {
    use tauri::Emitter;
    let dir = ocr_model_dir(&app)?;
    let (name, url, min) = TRANSLATE_MODEL;
    let runtime_dir = dir.join("runtime");
    let need_runtime = find_mtmd(&runtime_dir).is_none();
    let runtime_asset = llama_asset()?;
    let runtime_url = format!(
        "https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/{runtime_asset}"
    );
    let model_total = remote_size(url).unwrap_or(min);
    let total = model_total + if need_runtime { remote_size(&runtime_url).unwrap_or(30_000_000) } else { 0 };
    let mut done_base = 0u64;

    let dest = dir.join(name);
    if !std::fs::metadata(&dest).map(|m| m.len() >= min).unwrap_or(false) {
        let part = dir.join(format!("{name}.part"));
        kill_stale_download(&part);
        let mut child = std::process::Command::new("curl")
            .args(["--fail", "--location", "--silent", "--show-error", "--continue-at", "-", "--output"])
            .arg(&part)
            .arg(url)
            .spawn()
            .map_err(|e| format!("running curl: {e}"))?;
        loop {
            let len = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            let _ = app.emit(
                "translate-model-progress",
                serde_json::json!({ "downloaded": len, "total": total }),
            );
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(st) if st.success() => break,
                Some(_) => return Err(format!("download failed for {url}")),
                None => std::thread::sleep(std::time::Duration::from_millis(300)),
            }
        }
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    }
    done_base += model_total;

    if need_runtime {
        std::fs::create_dir_all(&runtime_dir).map_err(|e| e.to_string())?;
        let archive = runtime_dir.join(runtime_asset);
        kill_stale_download(&archive);
        let mut child = std::process::Command::new("curl")
            .args(["--fail", "--location", "--silent", "--show-error", "--continue-at", "-", "--output"])
            .arg(&archive)
            .arg(&runtime_url)
            .spawn()
            .map_err(|e| format!("running curl: {e}"))?;
        loop {
            let len = std::fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
            let _ = app.emit(
                "translate-model-progress",
                serde_json::json!({ "downloaded": done_base + len, "total": total }),
            );
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(st) if st.success() => break,
                Some(_) => return Err(format!("download failed for {runtime_url}")),
                None => std::thread::sleep(std::time::Duration::from_millis(300)),
            }
        }
        let status = std::process::Command::new("tar")
            .arg("-xf").arg(&archive).arg("-C").arg(&runtime_dir)
            .status()
            .map_err(|e| format!("running tar: {e}"))?;
        if !status.success() {
            return Err("extracting the llama.cpp runtime failed".into());
        }
        let _ = std::fs::remove_file(&archive);
    }
    let _ = app.emit(
        "translate-model-progress",
        serde_json::json!({ "downloaded": total, "total": total }),
    );
    translate_model_status(app)
}

/// Cooperative cancel for a running translation (checked between pages and
/// while llama-cli runs).
static TRANSLATE_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn cancel_translate() {
    TRANSLATE_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Experimental Translate PDF: extract each page's text, translate it with
/// the locally installed Unlimited-OCR language model (llama-cli), and open
/// the result as a new text PDF (one page per source page). Latin-script
/// target languages only — the output uses the built-in Helvetica font.
#[tauri::command]
async fn translate_document(
    app: tauri::AppHandle,
    id: u32,
    language: String,
    title: String,
    engine: Option<String>,
    api_key: Option<String>,
) -> Result<DocumentInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        translate_document_blocking(app, id, language, title, engine, api_key)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn translate_document_blocking(
    app: tauri::AppHandle,
    id: u32,
    language: String,
    title: String,
    engine: Option<String>,
    api_key: Option<String>,
) -> Result<DocumentInfo, String> {
    use std::sync::atomic::Ordering;
    use tauri::Emitter;
    TRANSLATE_CANCEL.store(false, Ordering::Relaxed);
    let cloud = engine.as_deref() == Some("google");
    let key = api_key.unwrap_or_default();
    if cloud && key.trim().is_empty() {
        return Err("Enter your Google Cloud Translation API key first.".into());
    }
    let dir = ocr_model_dir(&app)?;
    let mut cli = PathBuf::new();
    let mut model = PathBuf::new();
    if !cloud {
        if !translate_model_ready(&dir) {
            return Err("The translation model isn't installed yet — use the Download button in Translate PDF.".into());
        }
        let mtmd = find_mtmd(&dir.join("runtime")).ok_or("runtime missing — re-download the translation model")?;
        let cli_name = if cfg!(windows) { "llama-cli.exe" } else { "llama-cli" };
        cli = mtmd
            .parent()
            .map(|p| p.join(cli_name))
            .filter(|p| p.exists())
            .ok_or("llama-cli missing — re-download the translation model")?;
        model = dir.join(TRANSLATE_MODEL.0);
    }

    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let renderer = renderer()?;
    let sizes = renderer.page_sizes(&work).map_err(|e| e.to_string())?;

    let mut pages_text: Vec<String> = Vec::new();
    for i in 0..sizes.len() {
        let _ = app.emit(
            "translate-progress",
            serde_json::json!({ "page": i + 1, "pages": sizes.len() }),
        );
        let segs = renderer
            .text_segments(&work, i as u32)
            .map_err(|e| e.to_string())?;
        // PDFium splits styled runs oddly: a word's first letter(s) often
        // arrive as their own segment ("N" + "ame:", "Ye" + "Yes"). Repair:
        // drop a segment the next one starts with, and glue 1–2 char
        // fragments onto a lowercase/digit continuation.
        let raw: Vec<&str> = segs.iter().map(|s| s.text.trim()).filter(|t| !t.is_empty()).collect();
        let mut parts: Vec<String> = Vec::new();
        let mut i = 0;
        while i < raw.len() {
            let cur = raw[i];
            if i + 1 < raw.len() && raw[i + 1].starts_with(cur) {
                i += 1; // duplicate prefix run — keep only the full one
                continue;
            }
            if cur.chars().count() <= 2
                && i + 1 < raw.len()
                && raw[i + 1]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_lowercase() || c.is_ascii_digit())
            {
                parts.push(format!("{cur}{}", raw[i + 1]));
                i += 2;
                continue;
            }
            parts.push(cur.to_string());
            i += 1;
        }
        let text = parts.join(" ");
        if text.trim().is_empty() {
            pages_text.push(String::new());
            continue;
        }
        if cloud {
            if TRANSLATE_CANCEL.load(Ordering::Relaxed) {
                return Err("Translation cancelled.".into());
            }
            pages_text.push(cloud_translate(&text, google_lang_code(&language), key.trim())?);
            continue;
        }
        // Qwen3: `/no_think` disables the thinking preamble.
        let prompt = format!(
            "Translate the following document text into {language}. Output ONLY the translation. /no_think\n\n{text}"
        );
        let mut child = std::process::Command::new(&cli)
            .arg("-m")
            .arg(&model)
            .args(["--temp", "0.2", "--repeat-penalty", "1.15", "-n", "3072", "-c", "8192", "-ngl", "99", "--no-display-prompt", "-st", "-p"])
            .arg(&prompt)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("running llama-cli: {e}"))?;
        loop {
            if TRANSLATE_CANCEL.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Translation cancelled.".into());
            }
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(_) => break,
                None => std::thread::sleep(std::time::Duration::from_millis(200)),
            }
        }
        let out = child
            .wait_with_output()
            .map_err(|e| format!("running llama-cli: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let tail: String = err.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
            return Err(format!("translation failed on page {}: {tail}", i + 1));
        }
        let mut text_out = String::from_utf8_lossy(&out.stdout).to_string();
        // Strip a <think>…</think> preamble if the model emitted one anyway.
        if let (Some(a), Some(b)) = (text_out.find("<think>"), text_out.find("</think>")) {
            if a < b {
                text_out.replace_range(a..b + 8, "");
            }
        }
        pages_text.push(text_out.trim().to_string());
    }

    let dest = work_dir()?.join(format!("{id}-translated-{}.pdf", language.to_lowercase()));
    let page = sizes.first().copied().unwrap_or((612.0, 792.0));
    telos_core::doc::build_text_pdf(&dest, &pages_text, page).map_err(|e| e.to_string())?;
    let name = format!(
        "{} ({language}).pdf",
        title.trim_end_matches(".pdf").trim_end_matches(".PDF")
    );
    register(dest, name, true, false, None)
}

/// Scan & OCR with Unlimited-OCR: render pages, run llama-mtmd-cli per page,
/// and lay the recognised text as an invisible selectable layer OVER the
/// original pages (nothing is rasterised — vector content survives).
fn ocr_document_unlimited(
    app: &tauri::AppHandle,
    id: u32,
    title: &str,
) -> Result<DocumentInfo, String> {
    use tauri::Emitter;
    let dir = ocr_model_dir(app)?;
    let mtmd = find_mtmd(&dir.join("runtime"));
    let state = ocr_model_state(&dir);
    let (Some(mtmd), true) = (mtmd, state.installed) else {
        return Err("Unlimited-OCR isn't installed yet — download it in Settings → OCR.".into());
    };
    let model = dir.join(OCR_MODEL_FILES[0].0);
    let mmproj = dir.join(OCR_MODEL_FILES[1].0);

    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let renderer = renderer()?;
    let sizes = renderer.page_sizes(&work).map_err(|e| e.to_string())?;
    let tmp = work_dir()?.join(format!("ocr-{id}"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    let mut pages: Vec<Vec<telos_core::doc::OcrBlock>> = Vec::new();
    for (i, (w_pt, h_pt)) in sizes.iter().enumerate() {
        let _ = app.emit(
            "ocr-progress",
            serde_json::json!({ "page": i + 1, "pages": sizes.len() }),
        );
        // 200 DPI is plenty for the vision encoder and halves the tile count.
        let width = (w_pt / 72.0 * 200.0).round().max(1.0) as u32;
        let png = renderer
            .render_page_png(&work, i as u32, width, 0)
            .map_err(|e| e.to_string())?;
        let png_path = tmp.join(format!("p{i}.png"));
        std::fs::write(&png_path, png).map_err(|e| e.to_string())?;

        // --jinja: the model ships a chat template the legacy parser rejects.
        let run = |ngl: &str| {
            std::process::Command::new(&mtmd)
                .arg("-m")
                .arg(&model)
                .arg("--mmproj")
                .arg(&mmproj)
                .arg("--image")
                .arg(&png_path)
                .args(["--jinja", "-p", "<|grounding|>OCR this image.", "--temp", "0", "-n", "8192", "-c", "16384", "-ngl", ngl])
                .stdin(std::process::Stdio::null())
                .output()
                .map_err(|e| format!("running llama-mtmd-cli: {e}"))
        };
        // Metal can OOM on smaller machines — and worse, sometimes exits 0
        // with corrupted output. Detect either and redo the page on CPU.
        let mut out = run("99")?;
        let gpu_broken = {
            let err = String::from_utf8_lossy(&out.stderr);
            err.contains("Insufficient Memory")
                || (err.contains("ggml_metal") && err.contains("error"))
        };
        if !out.status.success() || gpu_broken {
            out = run("0")?;
        }
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let tail: String = err.lines().rev().take(4).collect::<Vec<_>>().join(" | ");
            return Err(format!("Unlimited-OCR failed on page {}: {tail}", i + 1));
        }
        let text = String::from_utf8_lossy(&out.stdout);
        pages.push(parse_grounding(&text, *w_pt, *h_pt));
    }
    // All pages recognised (100%); the text layer is still being written.
    let _ = app.emit(
        "ocr-progress",
        serde_json::json!({ "page": sizes.len() + 1, "pages": sizes.len() }),
    );
    let _ = std::fs::remove_dir_all(&tmp);

    let dest = work_dir()?.join(format!("{id}-ocr.pdf"));
    telos_core::doc::add_text_layer(&work, &dest, &pages).map_err(|e| e.to_string())?;

    {
        let mut reg = REGISTRY.lock().unwrap();
        let entry = reg.docs.get_mut(&id).ok_or("unknown document")?;
        entry.push_state(dest);
    }
    refresh_info(id, title)
}

/// Scan & OCR: render each page to an image, run the selected engine, and
/// produce a searchable (invisible-text-layer) PDF. Tesseract rasterizes and
/// re-assembles pages; Unlimited-OCR overlays text onto the original pages.
///
/// Honest scope: every page is OCR'd (the OCRmyPDF-style skip-pages-that-
/// already-have-text optimization is future work), so it's aimed at scans.
/// The original is untouched; the OCR'd version becomes the work copy.
#[tauri::command]
async fn ocr_document(
    app: tauri::AppHandle,
    id: u32,
    title: String,
    engine: Option<String>,
) -> Result<DocumentInfo, String> {
    if engine.as_deref() == Some("unlimited") {
        return ocr_document_unlimited(&app, id, &title);
    }
    // Prefer the Tesseract bundled with the app (zero user install); fall
    // back to a system install if present.
    let (tesseract, tessdata) = resolve_tesseract().ok_or(
        "OCR engine unavailable. The bundled Tesseract wasn't found and no system \
         install is present (macOS: `brew install tesseract`).",
    )?;

    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let renderer = renderer()?;
    let sizes = renderer.page_sizes(&work).map_err(|e| e.to_string())?;
    let tmp = work_dir()?.join(format!("ocr-{id}"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    let mut page_pdfs: Vec<PathBuf> = Vec::new();
    for (i, (w_pt, _)) in sizes.iter().enumerate() {
        // 300 DPI raster for good OCR accuracy.
        let width = (w_pt / 72.0 * 300.0).round().max(1.0) as u32;
        let png = renderer
            .render_page_png(&work, i as u32, width, 0)
            .map_err(|e| e.to_string())?;
        let png_path = tmp.join(format!("p{i}.png"));
        std::fs::write(&png_path, png).map_err(|e| e.to_string())?;

        let out_base = tmp.join(format!("p{i}"));
        let mut command = std::process::Command::new(&tesseract);
        if let Some(dir) = &tessdata {
            command.env("TESSDATA_PREFIX", dir);
        }
        let status = command
            .arg(&png_path)
            .arg(&out_base)
            .arg("pdf")
            .output()
            .map_err(|e| format!("running tesseract: {e}"))?;
        if !status.status.success() {
            return Err(format!(
                "tesseract failed: {}",
                String::from_utf8_lossy(&status.stderr)
            ));
        }
        page_pdfs.push(tmp.join(format!("p{i}.pdf")));
    }

    let dest = work_dir()?.join(format!("{id}-ocr.pdf"));
    if page_pdfs.len() == 1 {
        std::fs::copy(&page_pdfs[0], &dest).map_err(|e| e.to_string())?;
    } else {
        telos_core::doc::merge_documents(&page_pdfs, &dest).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(&tmp);

    // Adopt the OCR'd file as a new history state.
    {
        let mut reg = REGISTRY.lock().unwrap();
        let entry = reg.docs.get_mut(&id).ok_or("unknown document")?;
        entry.push_state(dest);
    }
    refresh_info(id, &title)
}

/// Paranoid-mode redaction: flatten pages with marked regions to images
/// with the regions blacked out. Regions are [page, x, y, w, h] in points.
#[tauri::command]
async fn redact_document(
    id: u32,
    regions: Vec<(u32, f32, f32, f32, f32)>,
    title: String,
) -> Result<DocumentInfo, String> {
    if regions.is_empty() {
        return Err("Mark at least one region to redact.".into());
    }
    mutate_rendered(id, |r, src, dest| {
        r.redact_pages(src, &regions, dest)
            .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title)
}

/// Colored text stamp (APPROVED, DRAFT, …) at a point on the page.
#[tauri::command]
async fn place_stamp(
    id: u32,
    page_index: u32,
    x: f32,
    y: f32,
    text: String,
    font_size: f32,
    rgb: (u8, u8, u8),
    title: String,
) -> Result<DocumentInfo, String> {
    mutate_rendered(id, |r, src, dest| {
        r.add_stamp(src, page_index, x, y, &text, font_size, rgb, dest)
            .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title)
}

/// Draw a markup shape (rect/ellipse/line/arrow) onto a page.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn add_shape(
    id: u32,
    page_index: u32,
    kind: String,
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    stroke: (u8, u8, u8),
    fill: Option<(u8, u8, u8)>,
    stroke_width: f32,
    title: String,
) -> Result<DocumentInfo, String> {
    mutate_rendered(id, |r, src, dest| {
        r.add_shape(
            src, page_index, &kind, x1, y1, x2, y2, stroke, fill, stroke_width, dest,
        )
        .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title)
}

/// Draw freehand ink (one or more polylines) onto a page.
#[tauri::command]
async fn add_ink(
    id: u32,
    page_index: u32,
    paths: Vec<Vec<(f32, f32)>>,
    rgb: (u8, u8, u8),
    stroke_width: f32,
    title: String,
) -> Result<DocumentInfo, String> {
    mutate_rendered(id, |r, src, dest| {
        r.add_ink(src, page_index, &paths, rgb, stroke_width, dest)
            .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title)
}

/// Place a free text box (with bold/italic/strike styling) onto a page.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn add_text_box(
    id: u32,
    page_index: u32,
    x: f32,
    y: f32,
    text: String,
    font_size: f32,
    rgb: (u8, u8, u8),
    bold: bool,
    italic: bool,
    strike: bool,
    title: String,
) -> Result<DocumentInfo, String> {
    mutate_rendered(id, |r, src, dest| {
        r.add_text_box(
            src, page_index, x, y, &text, font_size, rgb, bold, italic, strike, dest,
        )
        .map_err(|e| e.to_string())
    })?;
    refresh_info(id, &title)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffLine {
    /// "same" | "add" | "remove"
    tag: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompareResult {
    other_name: String,
    added: usize,
    removed: usize,
    lines: Vec<DiffLine>,
}

/// Two files under visual comparison, keyed by a compare-session id.
static COMPARE: LazyLock<Mutex<HashMap<u32, (PathBuf, PathBuf)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_COMPARE: LazyLock<Mutex<u32>> = LazyLock::new(|| Mutex::new(1));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompareSession {
    id: u32,
    name_a: String,
    name_b: String,
    pages: u32,
}

/// Pick two PDFs (old, then new) and start a visual comparison — neither is
/// opened as a normal document. Returns a session for the Compare tab.
#[tauri::command]
async fn start_compare(app: tauri::AppHandle) -> Result<Option<CompareSession>, String> {
    let pick = |title: &str| {
        app.dialog()
            .file()
            .add_filter("PDF documents", &["pdf"])
            .set_title(title)
            .blocking_pick_file()
    };
    let Some(a) = pick("Compare — pick the ORIGINAL PDF") else {
        return Ok(None);
    };
    let Some(b) = pick("Compare — pick the CHANGED PDF") else {
        return Ok(None);
    };
    let a = a.into_path().map_err(|e| e.to_string())?;
    let b = b.into_path().map_err(|e| e.to_string())?;
    let renderer = renderer()?;
    let pages = renderer
        .quick_page_count(&a)
        .unwrap_or(0)
        .max(renderer.quick_page_count(&b).unwrap_or(0));
    if pages == 0 {
        return Err("Could not read the selected PDFs.".into());
    }
    let name = |p: &std::path::Path| {
        p.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let session = {
        let mut next = NEXT_COMPARE.lock().unwrap();
        let id = *next;
        *next += 1;
        CompareSession {
            id,
            name_a: name(&a),
            name_b: name(&b),
            pages,
        }
    };
    COMPARE.lock().unwrap().insert(session.id, (a, b));
    Ok(Some(session))
}

#[tauri::command]
async fn close_compare(id: u32) -> Result<(), String> {
    COMPARE.lock().unwrap().remove(&id);
    Ok(())
}

/// Compare the open document's text against another PDF the user picks.
#[tauri::command]
async fn compare_documents(
    app: tauri::AppHandle,
    id: u32,
) -> Result<Option<CompareResult>, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF documents", &["pdf"])
        .blocking_pick_file();
    let Some(other) = picked else {
        return Ok(None);
    };
    let other = other.into_path().map_err(|e| e.to_string())?;
    let renderer = renderer()?;
    let a = renderer.extract_text(&work).map_err(|e| e.to_string())?;
    let b = renderer.extract_text(&other).map_err(|e| e.to_string())?;

    // Line-level diff (this doc = old, picked = new).
    let diff = similar::TextDiff::from_lines(&a, &b);
    let mut lines = Vec::new();
    let (mut added, mut removed) = (0usize, 0usize);
    for change in diff.iter_all_changes() {
        let tag = match change.tag() {
            similar::ChangeTag::Delete => {
                removed += 1;
                "remove"
            }
            similar::ChangeTag::Insert => {
                added += 1;
                "add"
            }
            similar::ChangeTag::Equal => "same",
        };
        lines.push(DiffLine {
            tag: tag.into(),
            text: change.value().trim_end().to_string(),
        });
    }
    Ok(Some(CompareResult {
        other_name: other
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        added,
        removed,
        lines,
    }))
}

/// Resolve a CUPS tool: prefer /usr/bin (GUI apps don't inherit the shell
/// PATH), fall back to the bare name.
#[cfg(not(target_os = "windows"))]
fn cups_bin(name: &str) -> String {
    let abs = format!("/usr/bin/{name}");
    if std::path::Path::new(&abs).exists() {
        abs
    } else {
        name.to_string()
    }
}

/// Available printers and the default (from CUPS `lpstat`). On Windows the
/// list is empty and we print via the shell "print" verb instead.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrinterList {
    printers: Vec<String>,
    default: Option<String>,
}

#[tauri::command]
fn list_printers() -> PrinterList {
    #[cfg(not(target_os = "windows"))]
    {
        let printers = std::process::Command::new(cups_bin("lpstat"))
            .arg("-a")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .filter_map(|l| l.split_whitespace().next().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let default = std::process::Command::new(cups_bin("lpstat"))
            .arg("-d")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .rsplit(':')
                    .next()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            });
        PrinterList { printers, default }
    }
    #[cfg(target_os = "windows")]
    {
        PrinterList {
            printers: Vec::new(),
            default: None,
        }
    }
}

/// Print the document's current PDF. `printer = None` uses the default.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrintOptions {
    printer: Option<String>,
    copies: u32,
    /// Custom page range like "1-3,5" (empty = all).
    pages: Option<String>,
    /// "all" | "odd" | "even"
    page_set: String,
    /// "one-sided" | "two-sided-long-edge" | "two-sided-short-edge"
    sides: String,
    reverse: bool,
}

#[tauri::command]
async fn print_document(id: u32, options: PrintOptions) -> Result<(), String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let copies = options.copies.clamp(1, 99);

    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = std::process::Command::new(cups_bin("lp"));
        cmd.arg("-n").arg(copies.to_string());
        if let Some(name) = options.printer.as_deref().filter(|p| !p.is_empty()) {
            cmd.arg("-d").arg(name);
        }
        if let Some(range) = options
            .pages
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            cmd.arg("-P").arg(range);
        }
        // Manual-duplex helper: print only odd or only even sheets.
        if options.page_set == "odd" || options.page_set == "even" {
            cmd.arg("-o").arg(format!("page-set={}", options.page_set));
        }
        // sides= only matters on duplex-capable printers; harmless otherwise.
        let sides = match options.sides.as_str() {
            "two-sided-long-edge" => "two-sided-long-edge",
            "two-sided-short-edge" => "two-sided-short-edge",
            _ => "one-sided",
        };
        cmd.arg("-o").arg(format!("sides={sides}"));
        if options.reverse {
            cmd.arg("-o").arg("outputorder=reverse");
        }
        cmd.arg(&work);
        let out = cmd.output().map_err(|e| format!("could not run lp: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "printing failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        let _ = options;
        let status = std::process::Command::new("cmd")
            .args(["/C", "start", "/min", ""])
            .arg("/print")
            .arg(&work)
            .status()
            .map_err(|e| format!("could not print: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err("printing failed".into())
        }
    }
}

/// Cancel a queued print job by its CUPS id (e.g. "Canon_LBP2900-42").
#[tauri::command]
fn cancel_print_job(job_id: String) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let out = std::process::Command::new(cups_bin("cancel"))
            .arg(&job_id)
            .output()
            .map_err(|e| format!("could not cancel: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).into_owned())
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = job_id;
        Err("Cancel from the Windows print queue.".into())
    }
}

/// One job in the system print queue (from CUPS `lpstat -o`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrintJob {
    id: String,
    printer: String,
    size: String,
    when: String,
}

/// The current system print queue — jobs from this app and anywhere else,
/// still pending on the spooler.
#[tauri::command]
fn print_queue() -> Vec<PrintJob> {
    #[cfg(not(target_os = "windows"))]
    {
        let text = std::process::Command::new(cups_bin("lpstat"))
            .arg("-o")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        text.lines()
            .filter_map(|line| {
                let mut parts = line.split_whitespace();
                let id = parts.next()?.to_string();
                let printer = id
                    .rsplit_once('-')
                    .map(|(p, _)| p.replace('_', " "))
                    .unwrap_or_else(|| id.clone());
                let _user = parts.next();
                let size = parts.next().unwrap_or("").to_string();
                let when = parts.collect::<Vec<_>>().join(" ");
                Some(PrintJob {
                    id,
                    printer,
                    size,
                    when,
                })
            })
            .collect()
    }
    #[cfg(target_os = "windows")]
    {
        Vec::new()
    }
}

#[tauri::command]
async fn undo(id: u32, title: String) -> Result<DocumentInfo, String> {
    {
        let mut reg = REGISTRY.lock().unwrap();
        let entry = reg.docs.get_mut(&id).ok_or("unknown document")?;
        if entry.pos == 0 {
            return Err("Nothing to undo.".into());
        }
        entry.pos -= 1;
        entry.rev += 1;
        entry.model = Model::NotLoaded;
    }
    refresh_info(id, &title)
}

#[tauri::command]
async fn redo(id: u32, title: String) -> Result<DocumentInfo, String> {
    {
        let mut reg = REGISTRY.lock().unwrap();
        let entry = reg.docs.get_mut(&id).ok_or("unknown document")?;
        if entry.pos + 1 >= entry.history.len() {
            return Err("Nothing to redo.".into());
        }
        entry.pos += 1;
        entry.rev += 1;
        entry.model = Model::NotLoaded;
    }
    refresh_info(id, &title)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchHitEntry {
    page_index: u32,
    rects: Vec<(f32, f32, f32, f32)>,
}

#[tauri::command]
async fn search_document(
    id: u32,
    query: String,
    match_case: bool,
) -> Result<Vec<SearchHitEntry>, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let hits = renderer()?
        .search(&work, &query, match_case)
        .map_err(|e| e.to_string())?;
    Ok(hits
        .into_iter()
        .map(|h| SearchHitEntry {
            page_index: h.page_index,
            rects: h.rects,
        })
        .collect())
}

#[tauri::command]
async fn close_document(id: u32) -> Result<(), String> {
    let entry = REGISTRY.lock().unwrap().docs.remove(&id);
    if let (Some(entry), Ok(work)) = (entry, work_dir()) {
        for path in entry.history {
            if path.starts_with(&work) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn rotate_page(
    id: u32,
    page_index: u32,
    clockwise: bool,
    title: String,
) -> Result<DocumentInfo, String> {
    mutate(id, |doc| doc.rotate_page(page_index + 1, clockwise))?;
    refresh_info(id, &title)
}

#[tauri::command]
async fn delete_page(id: u32, page_index: u32, title: String) -> Result<DocumentInfo, String> {
    mutate(id, |doc| doc.delete_page(page_index + 1))?;
    refresh_info(id, &title)
}

#[tauri::command]
async fn get_outline(id: u32) -> Result<Vec<OutlineEntry>, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let items = renderer()?.outline(&work).map_err(|e| e.to_string())?;
    Ok(items
        .into_iter()
        .map(|i| OutlineEntry {
            title: i.title,
            page_index: i.page_index,
            depth: i.depth,
        })
        .collect())
}

#[tauri::command]
async fn get_annotations(id: u32) -> Result<Vec<AnnotationEntry>, String> {
    let work = {
        let reg = REGISTRY.lock().unwrap();
        reg.docs.get(&id).ok_or("unknown document")?.work().clone()
    };
    let items = renderer()?.annotations(&work).map_err(|e| e.to_string())?;
    Ok(items
        .into_iter()
        .map(|i| AnnotationEntry {
            page_index: i.page_index,
            kind: i.kind,
            contents: i.contents,
            author: i.author,
        })
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommentEntry {
    /// Present when the document is editable; absent = read-only listing.
    id: Option<(u32, u16)>,
    page_index: u32,
    author: String,
    contents: String,
    modified: String,
    reply_to: Option<(u32, u16)>,
    /// (x, y, w, h) in PDF points, bottom-left origin; zeros when unknown.
    bounds: (f32, f32, f32, f32),
    /// Whether a shared edit code can unlock editing on another device.
    has_edit_code: bool,
    /// Note colour (r, g, b), if the comment carries one.
    color: Option<(u8, u8, u8)>,
}

/// The local identity used as comment author (account-free app: the OS user).
/// Every name this device's user is known by: unix login and (macOS) the
/// account full name — other apps author annotations with either.
fn user_identities() -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(login) = std::env::var("USER").or_else(|_| std::env::var("USERNAME")) {
        names.push(login);
    }
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("id").arg("-F").output()
        && out.status.success()
        && let Ok(full) = String::from_utf8(out.stdout)
    {
        let full = full.trim().to_string();
        if !full.is_empty() && !names.contains(&full) {
            names.push(full);
        }
    }
    if names.is_empty() {
        names.push("You".into());
    }
    names
}

/// Display/authoring name: prefer the human-readable full name.
fn user_name() -> String {
    user_identities().pop().unwrap_or_else(|| "You".into())
}

#[tauri::command]
fn current_user() -> String {
    user_name()
}

/// All identities, for the frontend's "is this mine?" check.
#[tauri::command]
fn current_user_names() -> Vec<String> {
    user_identities()
}

#[tauri::command]
async fn get_comments(id: u32) -> Result<Vec<CommentEntry>, String> {
    let (comments, work) = {
        let mut reg = REGISTRY.lock().unwrap();
        let entry = reg.docs.get_mut(&id).ok_or("unknown document")?;
        match entry.ensure_model() {
            Ok(doc) => (Some(doc.comments()), PathBuf::new()),
            Err(_) => (None, entry.work().clone()),
        }
    };
    match comments {
        Some(list) => Ok(list
            .into_iter()
            .map(|c| CommentEntry {
                id: Some(c.id),
                page_index: c.page_index,
                author: c.author,
                contents: c.contents,
                modified: c.modified,
                reply_to: c.reply_to,
                bounds: c.rect,
                has_edit_code: c.has_edit_code,
                color: c.color,
            })
            .collect()),
        // lopdf couldn't parse this file: fall back to PDFium's read-only view.
        None => {
            let items = renderer()?.annotations(&work).map_err(|e| e.to_string())?;
            Ok(items
                .into_iter()
                .map(|i| CommentEntry {
                    id: None,
                    page_index: i.page_index,
                    author: i.author,
                    contents: i.contents,
                    modified: String::new(),
                    reply_to: None,
                    bounds: (0.0, 0.0, 0.0, 0.0),
                    has_edit_code: false,
                    color: None,
                })
                .collect())
        }
    }
}

#[tauri::command]
async fn add_comment(
    id: u32,
    page_index: u32,
    contents: String,
    reply_to: Option<(u32, u16)>,
    edit_code: Option<String>,
    color: Option<(u8, u8, u8)>,
    title: String,
) -> Result<DocumentInfo, String> {
    let author = user_name();
    mutate(id, |doc| {
        doc.add_comment(
            page_index,
            &contents,
            &author,
            reply_to,
            edit_code.as_deref(),
            color,
        )
        .map(|_| ())
    })?;
    refresh_info(id, &title)
}

#[tauri::command]
async fn edit_comment(
    id: u32,
    comment_id: (u32, u16),
    contents: String,
    code: Option<String>,
    set_code: Option<String>,
    title: String,
) -> Result<DocumentInfo, String> {
    let identities = user_identities();
    mutate(id, |doc| {
        doc.edit_comment(
            comment_id,
            &contents,
            &identities,
            code.as_deref(),
            set_code.as_deref(),
        )
    })?;
    refresh_info(id, &title)
}

#[tauri::command]
async fn delete_comment(
    id: u32,
    comment_id: (u32, u16),
    title: String,
) -> Result<DocumentInfo, String> {
    mutate(id, |doc| doc.delete_comment(comment_id))?;
    refresh_info(id, &title)
}

/// `telos://localhost/page/{doc}/{page}?width={px}&rot={deg}&rev={n}` → PNG.
fn handle_telos_request(
    uri: &tauri::http::Uri,
) -> Result<(Vec<u8>, &'static str), (StatusCode, String)> {
    let segments: Vec<&str> = uri.path().trim_matches('/').split('/').collect();
    match segments.as_slice() {
        ["page", doc_id, page_index] => {
            let doc_id: u32 = doc_id
                .parse()
                .map_err(|_| (StatusCode::BAD_REQUEST, "bad doc id".into()))?;
            let page_index: u32 = page_index
                .parse()
                .map_err(|_| (StatusCode::BAD_REQUEST, "bad page index".into()))?;
            let query_param = |name: &str| -> Option<u32> {
                uri.query().and_then(|q| {
                    q.split('&')
                        .find_map(|kv| kv.strip_prefix(name).and_then(|v| v.strip_prefix('=')))
                        .and_then(|v| v.parse().ok())
                })
            };
            let width = query_param("width").unwrap_or(800);
            let rotation = query_param("rot").unwrap_or(0) % 360;

            let path = {
                let reg = REGISTRY.lock().unwrap();
                reg.docs
                    .get(&doc_id)
                    .map(|e| e.work().clone())
                    .ok_or((StatusCode::NOT_FOUND, format!("unknown document {doc_id}")))?
            };

            let renderer = renderer().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
            let png = renderer
                .render_page_png(&path, page_index, width.clamp(16, 4096), rotation)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok((png, "image/png"))
        }
        ["compare", compare_id, page_index] => {
            let compare_id: u32 = compare_id
                .parse()
                .map_err(|_| (StatusCode::BAD_REQUEST, "bad compare id".into()))?;
            let page_index: u32 = page_index
                .parse()
                .map_err(|_| (StatusCode::BAD_REQUEST, "bad page index".into()))?;
            let qp = |name: &str| -> Option<String> {
                uri.query().and_then(|q| {
                    q.split('&')
                        .find_map(|kv| kv.strip_prefix(name).and_then(|v| v.strip_prefix('=')))
                        .map(|v| v.to_string())
                })
            };
            let width: u32 = qp("width").and_then(|v| v.parse().ok()).unwrap_or(800);
            let mode = qp("side").unwrap_or_else(|| "diff".into());
            let (a, b) = {
                let reg = COMPARE.lock().unwrap();
                reg.get(&compare_id)
                    .cloned()
                    .ok_or((StatusCode::NOT_FOUND, "unknown compare session".into()))?
            };
            let renderer = renderer().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
            let png = renderer
                .compare_page_png(&a, &b, page_index, width.clamp(16, 4096), &mode)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok((png, "image/png"))
        }
        _ => Err((StatusCode::NOT_FOUND, "unknown telos:// route".into())),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // ASYNC protocol: rendering must never run on the main event loop —
        // a synchronous handler beachballs the whole app (zoom, resize,
        // menus) for every page render.
        .register_asynchronous_uri_scheme_protocol("telos", |_ctx, request, responder| {
            let uri = request.uri().clone();
            std::thread::spawn(move || {
                let response = match handle_telos_request(&uri) {
                    Ok((body, mime)) => Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, mime)
                        // URLs are revision-keyed (?rev=), so aggressive
                        // caching is safe: a mutation changes the URL.
                        .header(header::CACHE_CONTROL, "private, max-age=3600")
                        .body(body)
                        .unwrap(),
                    Err((status, msg)) => Response::builder()
                        .status(status)
                        .header(header::CONTENT_TYPE, "text/plain")
                        .body(msg.into_bytes())
                        .unwrap(),
                };
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![
            open_document,
            open_document_path,
            create_document_from_images,
            current_user,
            current_user_names,
            get_comments,
            add_comment,
            edit_comment,
            delete_comment,
            get_page_objects,
            edit_text_object,
            delete_page_object,
            add_text_object,
            move_page_object,
            replace_image_object,
            export_text,
            export_images,
            export_html,
            export_docx,
            office_available,
            create_from_office,
            export_office,
            get_text_segments,
            combine_documents,
            save_document,
            save_document_as,
            frontend_ready,
            is_default_pdf_handler,
            set_default_pdf_handler,
            undo,
            redo,
            search_document,
            move_page,
            insert_blank_page,
            extract_pages,
            get_form_fields,
            set_form_field,
            place_image,
            place_stamp,
            add_shape,
            add_ink,
            add_text_box,
            redact_document,
            ocr_document,
            ocr_model_status,
            translate_document,
            cancel_translate,
            translate_model_status,
            download_translate_model,
            download_ocr_model,
            compare_documents,
            start_compare,
            close_compare,
            list_printers,
            print_document,
            print_queue,
            cancel_print_job,
            unlock_document,
            protect_document,
            remove_password,
            compress_document,
            create_document,
            close_document,
            rotate_page,
            delete_page,
            get_outline,
            get_annotations
        ])
        .setup(|app| {
            // Windows/Linux (and dev): associated files arrive as argv.
            let handle = app.handle().clone();
            for arg in std::env::args().skip(1) {
                open_external(&handle, PathBuf::from(arg));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building TelosPDF")
        .run(|app, event| {
            // macOS: Finder / "Open With" delivers files as an Opened event.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        open_external(app, path);
                    }
                }
            }
            let _ = (app, &event);
        });
}
