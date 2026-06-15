//! Rendering service for TelosPDF, backed by PDFium.
//!
//! Architectural rule (PLAN.md §3): the webview never touches PDF bytes —
//! this crate rasterizes pages/tiles in Rust and hands encoded images to the
//! host. PDFium's C API is not thread-safe; the `thread_safe` feature of
//! `pdfium-render` serializes calls for M0. The dedicated render thread with
//! a priority queue replaces that in M1.
//!
//! PDFium is loaded dynamically from (in order):
//! 1. `TELOS_PDFIUM_PATH` env var (directory containing the library), or
//! 2. `<workspace>/.pdfium/<platform>/lib/`, populated by
//!    `cargo xtask fetch-pdfium`, or
//! 3. the system library path.

use std::path::PathBuf;

use pdfium_render::prelude::*;

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error(
        "could not bind to PDFium. Run `cargo xtask fetch-pdfium` first, or set \
         TELOS_PDFIUM_PATH to a directory containing the pdfium library. ({0})"
    )]
    Bind(String),
    #[error("pdfium error: {0}")]
    Pdfium(#[from] PdfiumError),
    #[error("image encode error: {0}")]
    Encode(#[from] image::ImageError),
    #[error("that object is not a text object")]
    NotATextObject,
    #[error("that object is not an image object")]
    NotAnImageObject,
    #[error("no pages selected")]
    EmptyPageSelection,
    #[error("that annotation is not a fillable form field")]
    NotAFormField,
}

/// The bblanchon/pdfium-binaries platform string for the host.
pub fn host_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "mac-arm64",
        ("macos", "x86_64") => "mac-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", _) => "linux-x64",
        ("windows", _) => "win-x64",
        ("android", _) => "android-arm64",
        (os, arch) => panic!("unsupported host platform: {os}-{arch}"),
    }
}

/// Directories searched for the PDFium dynamic library.
fn candidate_lib_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = std::env::var("TELOS_PDFIUM_PATH") {
        dirs.push(PathBuf::from(dir));
    }
    // Walk up from this crate (dev/test) and from the current exe (packaged)
    // looking for the workspace-level .pdfium directory.
    let mut roots = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR"))];
    if let Ok(exe) = std::env::current_exe() {
        roots.push(exe);
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    for root in roots {
        let mut cur: Option<&std::path::Path> = Some(root.as_path());
        while let Some(dir) = cur {
            // Project/dev layout and the packaged macOS Resources layout.
            for base in [dir.join(".pdfium"), dir.join("Resources").join(".pdfium")] {
                let plat = base.join(host_platform());
                // Prebuilt layout differs per OS: the dylib/so lives in lib/,
                // but the Windows pdfium.dll ships in bin/.
                for candidate in [plat.join("lib"), plat.join("bin")] {
                    if candidate.is_dir() {
                        dirs.push(candidate);
                    }
                }
            }
            cur = dir.parent();
        }
    }
    dirs
}

/// One page object (text run, image, path…) for the Edit-PDF overlay.
#[derive(Debug, Clone)]
pub struct PageObjectInfo {
    /// Index within the page's object list — valid until the next mutation.
    pub index: u32,
    /// "text" | "image" | "path" | "shading" | "form" | "unknown"
    pub kind: String,
    /// (x, y, width, height) in PDF points, origin bottom-left.
    pub bounds: (f32, f32, f32, f32),
    /// Text content for text objects.
    pub text: Option<String>,
}

/// One positioned text run for the selectable text layer.
#[derive(Debug, Clone)]
pub struct TextSegmentInfo {
    /// (x, y, width, height) in PDF points, origin bottom-left.
    pub bounds: (f32, f32, f32, f32),
    pub text: String,
}

/// One interactive form field (Fill & Sign overlay).
#[derive(Debug, Clone)]
pub struct FormFieldInfo {
    /// Index in the page's annotation list — valid until the next mutation.
    pub annotation_index: u32,
    pub name: String,
    /// "text" | "checkbox" | "radio" | "combo" | "list" | "signature" | "button" | "unknown"
    pub kind: String,
    pub value: Option<String>,
    pub checked: Option<bool>,
    pub options: Vec<String>,
    /// (x, y, w, h) in PDF points, bottom-left origin.
    pub bounds: (f32, f32, f32, f32),
}

/// One search hit: rectangles (PDF points, bottom-left origin) on a page.
#[derive(Debug, Clone)]
pub struct SearchHit {
    pub page_index: u32,
    /// A hit wrapping across lines produces one rect per line segment.
    pub rects: Vec<(f32, f32, f32, f32)>,
}

/// One outline (bookmark) entry, flattened in document order.
#[derive(Debug, Clone)]
pub struct OutlineItem {
    pub title: String,
    pub page_index: Option<u32>,
    pub depth: u32,
}

/// One annotation with text content.
#[derive(Debug, Clone)]
pub struct AnnotationItem {
    pub page_index: u32,
    pub kind: String,
    pub contents: String,
    pub author: String,
}

/// A handle to the PDFium engine.
///
/// One per process. PDFium's C API is single-threaded: `pdfium-render`'s
/// `thread_safe` feature serializes individual FFI calls, but PDFium's
/// global state (the FreeType font cache in particular) is NOT safe against
/// two threads interleaving whole operations on different documents — that
/// crashes inside `CFX_Face` teardown. So every public method here holds an
/// operation-level lock for its full duration. The dedicated render thread
/// with a priority queue (M1) replaces this.
pub struct Renderer {
    /// Leaked on purpose: exactly one PDFium instance exists per process and
    /// lives for its entire lifetime — the 'static borrow lets the document
    /// cache hold open documents.
    pdfium: &'static Pdfium,
    op_lock: std::sync::Mutex<()>,
    /// MRU cache of open documents. Re-parsing the whole file on every page
    /// render is the difference between instant and laggy scrolling. Safe to
    /// key by path: every mutation writes a NEW work file, so a path's
    /// content never changes while cached (mutations also evict `src`).
    doc_cache: std::sync::Mutex<Vec<(PathBuf, PdfDocument<'static>)>>,
    /// LRU cache of already-rendered page PNGs, keyed by
    /// (path, page, width, rotation). Scrolling back or re-viewing a page is
    /// then instant instead of re-rasterizing. Work-file paths are
    /// content-immutable, so cached bytes never go stale; mutations evict.
    render_cache: std::sync::Mutex<Vec<(String, Vec<u8>)>>,
}

const DOC_CACHE_CAPACITY: usize = 6;
const RENDER_CACHE_CAPACITY: usize = 48;

impl Renderer {
    pub fn new() -> Result<Self, RenderError> {
        let mut last_err = String::from("no candidate directories found");
        for dir in candidate_lib_dirs() {
            match Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&dir)) {
                Ok(bindings) => return Ok(Self::from_pdfium(Pdfium::new(bindings))),
                Err(e) => last_err = format!("{}: {e}", dir.display()),
            }
        }
        match Pdfium::bind_to_system_library() {
            Ok(bindings) => Ok(Self::from_pdfium(Pdfium::new(bindings))),
            Err(_) => Err(RenderError::Bind(last_err)),
        }
    }

    fn from_pdfium(pdfium: Pdfium) -> Self {
        Self {
            pdfium: Box::leak(Box::new(pdfium)),
            op_lock: std::sync::Mutex::new(()),
            doc_cache: std::sync::Mutex::new(Vec::new()),
            render_cache: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        // A poisoned lock only means another operation panicked; PDFium
        // state is per-operation, so continuing is safe.
        self.op_lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Run `f` against the cached open document for `path`, opening (and
    /// caching, MRU) if needed. Caller must hold the op lock.
    fn with_doc<R>(
        &self,
        path: &std::path::Path,
        f: impl FnOnce(&mut PdfDocument<'static>) -> Result<R, RenderError>,
    ) -> Result<R, RenderError> {
        let mut cache = self.doc_cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pos) = cache.iter().position(|(p, _)| p == path) {
            let entry = cache.remove(pos);
            cache.insert(0, entry);
        } else {
            let doc = self.pdfium.load_pdf_from_file(path, None)?;
            cache.insert(0, (path.to_path_buf(), doc));
            cache.truncate(DOC_CACHE_CAPACITY);
        }
        f(&mut cache[0].1)
    }

    /// Drop a path from the caches (mutations invalidate their source file).
    fn evict(&self, path: &std::path::Path) {
        let mut cache = self.doc_cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.retain(|(p, _)| p != path);
        let prefix = format!("{}|", path.display());
        let mut renders = self.render_cache.lock().unwrap_or_else(|e| e.into_inner());
        renders.retain(|(k, _)| !k.starts_with(&prefix));
    }

    /// Page count without rendering (PDFium view; `telos-doc` is the
    /// structural source of truth).
    pub fn page_count(&self, pdf_path: &std::path::Path) -> Result<u32, RenderError> {
        let _guard = self.lock();
        self.with_doc(pdf_path, |doc| Ok(doc.pages().len().max(0) as u32))
    }

    /// Render one page to a PNG at the given pixel width (aspect preserved),
    /// optionally rotated by a view rotation (0/90/180/270°, clockwise).
    ///
    /// View rotation is applied to the output image (non-destructive); page
    /// `/Rotate` mutations live in `telos-doc`. M0 whole-page rendering; the
    /// 256–512 px tile pipeline with priority queue replaces this in M1.
    pub fn render_page_png(
        &self,
        pdf_path: &std::path::Path,
        page_index: u32,
        width: u32,
        view_rotation: u32,
    ) -> Result<Vec<u8>, RenderError> {
        let key = format!(
            "{}|{page_index}|{width}|{view_rotation}",
            pdf_path.display()
        );
        // Cache hit → skip PDFium entirely (and the op lock).
        {
            let mut cache = self.render_cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(pos) = cache.iter().position(|(k, _)| *k == key) {
                let entry = cache.remove(pos);
                let bytes = entry.1.clone();
                cache.push(entry);
                return Ok(bytes);
            }
        }
        let _guard = self.lock();
        let png = self.with_doc(pdf_path, |doc| {
            let page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            let config = PdfRenderConfig::new()
                .set_target_width(width.min(8192) as i32)
                .render_form_data(true);
            let bitmap = page.render_with_config(&config)?;
            // Flatten onto white: PDFium renders transparent areas with a
            // zero-alpha (→ black once alpha is dropped) background, so pages
            // without an opaque background came out solid black. Compositing
            // over white fixes that and yields smaller alpha-free PNGs.
            let rgba = bitmap.as_image()?.into_rgba8();
            let (w, h) = rgba.dimensions();
            let mut rgb = image::RgbImage::new(w, h);
            for (dst, src) in rgb.pixels_mut().zip(rgba.pixels()) {
                let a = src[3] as u32;
                let blend = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
                *dst = image::Rgb([blend(src[0]), blend(src[1]), blend(src[2])]);
            }
            let mut dynamic = image::DynamicImage::ImageRgb8(rgb);
            dynamic = match view_rotation % 360 {
                90 => dynamic.rotate90(),
                180 => dynamic.rotate180(),
                270 => dynamic.rotate270(),
                _ => dynamic,
            };
            let mut out = Vec::new();
            dynamic.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)?;
            Ok(out)
        })?;
        {
            let mut cache = self.render_cache.lock().unwrap_or_else(|e| e.into_inner());
            cache.push((key, png.clone()));
            if cache.len() > RENDER_CACHE_CAPACITY {
                cache.remove(0);
            }
        }
        Ok(png)
    }

    /// Flattened outline (bookmarks): document order with nesting depth.
    pub fn outline(&self, pdf_path: &std::path::Path) -> Result<Vec<OutlineItem>, RenderError> {
        fn walk(node: PdfBookmark<'_>, depth: u32, items: &mut Vec<OutlineItem>) {
            // Cap pathological nesting; real outlines are a few levels deep.
            if depth > 64 {
                return;
            }
            let title = node.title().unwrap_or_default();
            if !title.is_empty() {
                let page_index = node
                    .destination()
                    .and_then(|d| d.page_index().ok())
                    .map(|i| i.max(0) as u32);
                items.push(OutlineItem {
                    title,
                    page_index,
                    depth,
                });
            }
            if let Some(child) = node.first_child() {
                walk(child, depth + 1, items);
            }
            if let Some(sibling) = node.next_sibling() {
                walk(sibling, depth, items);
            }
        }

        let _guard = self.lock();
        self.with_doc(pdf_path, |doc| {
            let mut items = Vec::new();
            if let Some(root) = doc.bookmarks().root() {
                walk(root, 0, &mut items);
            }
            Ok(items)
        })
    }

    /// All annotations that carry text content, page by page.
    pub fn annotations(
        &self,
        pdf_path: &std::path::Path,
    ) -> Result<Vec<AnnotationItem>, RenderError> {
        let _guard = self.lock();
        self.with_doc(pdf_path, |doc| {
            let mut items = Vec::new();
            for (page_index, page) in doc.pages().iter().enumerate() {
                for annotation in page.annotations().iter() {
                    let contents = annotation.contents().unwrap_or_default();
                    if contents.trim().is_empty() {
                        continue;
                    }
                    items.push(AnnotationItem {
                        page_index: page_index as u32,
                        kind: format!("{:?}", annotation.annotation_type()),
                        contents,
                        author: annotation.creator().unwrap_or_default(),
                    });
                }
            }
            Ok(items)
        })
    }

    /// Enumerate the page objects of one page (Edit-PDF overlay).
    pub fn page_objects(
        &self,
        pdf_path: &std::path::Path,
        page_index: u32,
    ) -> Result<Vec<PageObjectInfo>, RenderError> {
        let _guard = self.lock();
        self.with_doc(pdf_path, |doc| {
            let page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            let mut out = Vec::new();
            for (i, object) in page.objects().iter().enumerate() {
                let Ok(bounds) = object.bounds() else {
                    continue;
                };
                let (kind, text) = match &object {
                    PdfPageObject::Text(t) => ("text", Some(t.text())),
                    PdfPageObject::Image(_) => ("image", None),
                    PdfPageObject::Path(_) => ("path", None),
                    PdfPageObject::Shading(_) => ("shading", None),
                    PdfPageObject::XObjectForm(_) => ("form", None),
                    _ => ("unknown", None),
                };
                let left = bounds.left().value;
                let bottom = bounds.bottom().value;
                out.push(PageObjectInfo {
                    index: i as u32,
                    kind: kind.into(),
                    bounds: (
                        left,
                        bottom,
                        bounds.right().value - left,
                        bounds.top().value - bottom,
                    ),
                    text,
                });
            }
            Ok(out)
        })
    }

    /// Replace the text of a text object, writing the result to `dest`.
    ///
    /// M0/v1 slice: single-run replacement using the object's existing font.
    /// If the embedded subset lacks glyphs for the new text they will render
    /// as blanks — font substitution and re-subsetting arrive with the full
    /// Edit engine (PLAN.md §6.1).
    pub fn edit_text_object(
        &self,
        src: &std::path::Path,
        page_index: u32,
        object_index: u32,
        new_text: &str,
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        let _guard = self.lock();
        self.with_doc(src, |doc| {
            let mut page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;

            // A PDF text run has no newline concept — a raw \n byte renders as a
            // junk glyph. Line 1 replaces the object's text; each further line
            // becomes its own text object, stacked below with the same font.
            let text = new_text.replace('\r', "");
            let mut lines = text.split('\n').map(str::trim_end);
            let first_line = lines.next().unwrap_or_default();
            let rest: Vec<&str> = lines.collect();

            let (font_token, font_size, base_x, base_y) = {
                let objects = page.objects_mut();
                let mut object = objects
                    .get(object_index as usize)
                    .map_err(RenderError::Pdfium)?;
                match &mut object {
                    PdfPageObject::Text(t) => {
                        let bounds = t.bounds()?;
                        let size = t.unscaled_font_size();
                        let token = t.font().token();
                        t.set_text(first_line)?;
                        (token, size, bounds.left().value, bounds.bottom().value)
                    }
                    _ => return Err(RenderError::NotATextObject),
                }
            };

            let line_height = if font_size.value > 1.0 {
                font_size.value * 1.25
            } else {
                14.0
            };
            for (i, line) in rest.iter().enumerate() {
                if line.is_empty() {
                    continue;
                }
                let mut new_object = PdfPageTextObject::new(&doc, *line, font_token, font_size)?;
                new_object.translate(
                    PdfPoints::new(base_x),
                    PdfPoints::new(base_y - line_height * (i + 1) as f32),
                )?;
                page.objects_mut().add_text_object(new_object)?;
            }

            page.regenerate_content()?;
            doc.save_to_file(dest)?;
            Ok(())
        })?;
        self.evict(src);
        Ok(())
    }

    /// Delete one page object, writing the result to `dest`.
    pub fn delete_page_object(
        &self,
        src: &std::path::Path,
        page_index: u32,
        object_index: u32,
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        let _guard = self.lock();
        self.with_doc(src, |doc| {
            let mut page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
            let removed = page
                .objects_mut()
                .remove_object_at_index(object_index as usize)?;
            page.regenerate_content()?;
            doc.save_to_file(dest)?;
            // Dropping the removed object calls FPDFPageObj_Destroy, which
            // segfaults on this PDFium build (mac-arm64, chromium/7763) — the
            // handle appears to be freed during content regeneration already.
            // Leak the tiny wrapper instead; the document closes right after.
            // TODO: report upstream to pdfium-render / recheck on newer builds.
            std::mem::forget(removed);
            Ok(())
        })?;
        self.evict(src);
        Ok(())
    }

    /// Add a new text object (Helvetica) at (x, y) in PDF points, writing the
    /// result to `dest`.
    pub fn add_text_object(
        &self,
        src: &std::path::Path,
        page_index: u32,
        x: f32,
        y: f32,
        text: &str,
        font_size: f32,
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        let _guard = self.lock();
        self.with_doc(src, |doc| {
            let font = doc.fonts_mut().helvetica();
            let mut page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            let size = font_size.clamp(4.0, 144.0);
            let cleaned = text.replace('\r', "");
            for (i, line) in cleaned.split('\n').map(str::trim_end).enumerate() {
                if line.is_empty() {
                    continue;
                }
                let mut object = PdfPageTextObject::new(&doc, line, font, PdfPoints::new(size))?;
                object.translate(
                    PdfPoints::new(x),
                    PdfPoints::new(y - size * 1.25 * i as f32),
                )?;
                page.objects_mut().add_text_object(object)?;
            }
            page.regenerate_content()?;
            doc.save_to_file(dest)?;
            Ok(())
        })?;
        self.evict(src);
        Ok(())
    }

    /// Positioned text runs for one page (the selectable text layer).
    pub fn text_segments(
        &self,
        pdf_path: &std::path::Path,
        page_index: u32,
    ) -> Result<Vec<TextSegmentInfo>, RenderError> {
        let _guard = self.lock();
        self.with_doc(pdf_path, |doc| {
            let page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            let text = page.text()?;
            let mut out = Vec::new();
            for segment in text.segments().iter() {
                let bounds = segment.bounds();
                let left = bounds.left().value;
                let bottom = bounds.bottom().value;
                let content = segment.text();
                if content.trim().is_empty() {
                    continue;
                }
                out.push(TextSegmentInfo {
                    bounds: (
                        left,
                        bottom,
                        bounds.right().value - left,
                        bounds.top().value - bottom,
                    ),
                    text: content,
                });
            }
            Ok(out)
        })
    }

    /// Search the whole document. Case-insensitive unless `match_case`;
    /// capped at 2000 hits to bound worst-case documents.
    pub fn search(
        &self,
        pdf_path: &std::path::Path,
        query: &str,
        match_case: bool,
    ) -> Result<Vec<SearchHit>, RenderError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let _guard = self.lock();
        self.with_doc(pdf_path, |doc| {
            let options = PdfSearchOptions::new().match_case(match_case);
            let mut hits = Vec::new();
            'pages: for (page_index, page) in doc.pages().iter().enumerate() {
                let text = page.text()?;
                let search = text.search(query, &options)?;
                while let Some(segments) = search.find_next() {
                    let mut rects = Vec::new();
                    for segment in segments.iter() {
                        let b = segment.bounds();
                        let left = b.left().value;
                        let bottom = b.bottom().value;
                        rects.push((left, bottom, b.right().value - left, b.top().value - bottom));
                    }
                    if !rects.is_empty() {
                        hits.push(SearchHit {
                            page_index: page_index as u32,
                            rects,
                        });
                    }
                    if hits.len() >= 2000 {
                        break 'pages;
                    }
                }
            }
            Ok(hits)
        })
    }

    /// Rebuild the document with pages in `order` (0-based indices into the
    /// current page sequence; subsets extract, repeats duplicate). Import
    /// into a fresh document flattens inherited attributes correctly.
    pub fn restructure_pages(
        &self,
        src: &std::path::Path,
        order: &[u32],
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        if order.is_empty() {
            return Err(RenderError::EmptyPageSelection);
        }
        let _guard = self.lock();
        let src_doc = self.pdfium.load_pdf_from_file(src, None)?;
        let mut new_doc = self.pdfium.create_new_pdf()?;
        let range = order
            .iter()
            .map(|i| (i + 1).to_string())
            .collect::<Vec<_>>()
            .join(",");
        new_doc
            .pages_mut()
            .copy_pages_from_document(&src_doc, &range, 0)?;
        new_doc.save_to_file(dest)?;
        self.evict(src);
        Ok(())
    }

    /// Insert a blank page at `at_index`, sized like the page currently at
    /// that position (or the last page when appending).
    pub fn insert_blank_page(
        &self,
        src: &std::path::Path,
        at_index: u32,
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        let _guard = self.lock();
        let mut doc = self.pdfium.load_pdf_from_file(src, None)?;
        let count = doc.pages().len() as u32;
        let template = at_index.min(count.saturating_sub(1));
        let size = doc
            .pages()
            .page_size(template.min(i32::MAX as u32) as i32)
            .map(|r| PdfPagePaperSize::Custom(r.width(), r.height()))
            .unwrap_or(PdfPagePaperSize::a4());
        doc.pages_mut()
            .create_page_at_index(size, at_index.min(count) as i32)?;
        doc.save_to_file(dest)?;
        self.evict(src);
        Ok(())
    }

    /// Downsample oversized images in place (PDFium pass of Compress).
    /// Images whose pixel density exceeds `target_dpi` for their displayed
    /// size are resized. Returns how many images were downsampled.
    pub fn downsample_images(
        &self,
        src: &std::path::Path,
        target_dpi: u32,
        dest: &std::path::Path,
    ) -> Result<u32, RenderError> {
        let _guard = self.lock();
        let doc = self.pdfium.load_pdf_from_file(src, None)?;
        let mut changed = 0u32;
        for mut page in doc.pages().iter() {
            let mut any = false;
            let objects = page.objects_mut();
            for index in 0..objects.len() {
                let Ok(mut object) = objects.get(index) else {
                    continue;
                };
                let PdfPageObject::Image(image_object) = &mut object else {
                    continue;
                };
                let Ok(bounds) = image_object.bounds() else {
                    continue;
                };
                // Displayed size in points → pixel budget at target DPI.
                let width_pt = bounds.right().value - bounds.left().value;
                let height_pt = bounds.top().value - bounds.bottom().value;
                if width_pt <= 1.0 || height_pt <= 1.0 {
                    continue;
                }
                let budget_w = (width_pt / 72.0 * target_dpi as f32).ceil() as u32;
                let budget_h = (height_pt / 72.0 * target_dpi as f32).ceil() as u32;
                let Ok(raw) = image_object.get_raw_image() else {
                    continue;
                };
                // Only shrink when clearly oversized (30% headroom avoids
                // requality churn for marginal wins).
                if raw.width() * 10 <= budget_w * 13 || raw.height() * 10 <= budget_h * 13 {
                    continue;
                }
                let resized = raw.thumbnail(budget_w.max(1), budget_h.max(1));
                if image_object.set_image(&resized).is_ok() {
                    changed += 1;
                    any = true;
                }
            }
            if any {
                page.regenerate_content()?;
            }
        }
        doc.save_to_file(dest)?;
        self.evict(src);
        Ok(changed)
    }

    /// Form fields on one page (Fill & Sign overlay).
    pub fn form_fields(
        &self,
        pdf_path: &std::path::Path,
        page_index: u32,
    ) -> Result<Vec<FormFieldInfo>, RenderError> {
        let _guard = self.lock();
        self.with_doc(pdf_path, |doc| {
            let page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            let mut out = Vec::new();
            for (i, annotation) in page.annotations().iter().enumerate() {
                let Some(field) = annotation.as_form_field() else {
                    continue;
                };
                let bounds = annotation.bounds()?;
                let left = bounds.left().value;
                let bottom = bounds.bottom().value;
                let (kind, value, checked, options) = if let Some(t) = field.as_text_field() {
                    ("text", t.value(), None, Vec::new())
                } else if let Some(c) = field.as_checkbox_field() {
                    ("checkbox", None, c.is_checked().ok(), Vec::new())
                } else if let Some(r) = field.as_radio_button_field() {
                    ("radio", r.group_value(), r.is_checked().ok(), Vec::new())
                } else if let Some(c) = field.as_combo_box_field() {
                    (
                        "combo",
                        c.value(),
                        None,
                        c.options()
                            .iter()
                            .filter_map(|o| o.label().cloned())
                            .collect(),
                    )
                } else {
                    (
                        match field.field_type() {
                            PdfFormFieldType::Signature => "signature",
                            PdfFormFieldType::ListBox => "list",
                            PdfFormFieldType::PushButton => "button",
                            _ => "unknown",
                        },
                        None,
                        None,
                        Vec::new(),
                    )
                };
                out.push(FormFieldInfo {
                    annotation_index: i as u32,
                    name: field.name().unwrap_or_default(),
                    kind: kind.into(),
                    value,
                    checked,
                    options,
                    bounds: (
                        left,
                        bottom,
                        bounds.right().value - left,
                        bounds.top().value - bottom,
                    ),
                });
            }
            Ok(out)
        })
    }

    /// Set a form field value (text or checked state), writing to `dest`.
    pub fn set_form_field(
        &self,
        src: &std::path::Path,
        page_index: u32,
        annotation_index: u32,
        value: Option<&str>,
        checked: Option<bool>,
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        let _guard = self.lock();
        self.with_doc(src, |doc| {
            let mut page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            let annotations = page.annotations_mut();
            let mut annotation = annotations
                .get(annotation_index as usize)
                .map_err(RenderError::Pdfium)?;
            let Some(field) = annotation.as_form_field_mut() else {
                return Err(RenderError::NotAFormField);
            };
            if let Some(text) = value
                && let Some(t) = field.as_text_field_mut()
            {
                t.set_value(text)?;
            } else if let Some(state) = checked {
                if let Some(c) = field.as_checkbox_field_mut() {
                    c.set_checked(state)?;
                } else if let Some(r) = field.as_radio_button_field_mut() {
                    if state {
                        r.set_checked()?;
                    }
                } else {
                    return Err(RenderError::NotAFormField);
                }
            } else {
                return Err(RenderError::NotAFormField);
            }
            doc.save_to_file(dest)?;
            Ok(())
        })?;
        self.evict(src);
        Ok(())
    }

    /// Place an image (PNG/JPEG bytes) on a page — signatures & stamps.
    /// (x, y) is the bottom-left target in points; width in points, aspect
    /// preserved.
    pub fn add_image_object(
        &self,
        src: &std::path::Path,
        page_index: u32,
        x: f32,
        y: f32,
        width_pt: f32,
        image_bytes: &[u8],
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        let decoded = image::load_from_memory(image_bytes)?;
        let aspect = decoded.height() as f32 / decoded.width() as f32;
        let _guard = self.lock();
        self.with_doc(src, |doc| {
            let mut page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            let mut object = PdfPageImageObject::new(doc, &decoded)?;
            // A fresh image object is 1x1pt; scale to the target box.
            object.scale(width_pt.max(8.0), (width_pt * aspect).max(8.0))?;
            object.translate(PdfPoints::new(x), PdfPoints::new(y))?;
            page.objects_mut().add_image_object(object)?;
            page.regenerate_content()?;
            doc.save_to_file(dest)?;
            Ok(())
        })?;
        self.evict(src);
        Ok(())
    }

    /// Place a colored text stamp (e.g. APPROVED) at (x, y) points.
    pub fn add_stamp(
        &self,
        src: &std::path::Path,
        page_index: u32,
        x: f32,
        y: f32,
        text: &str,
        font_size: f32,
        rgb: (u8, u8, u8),
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        let _guard = self.lock();
        self.with_doc(src, |doc| {
            let font = doc.fonts_mut().helvetica_bold();
            let mut page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            let mut object = PdfPageTextObject::new(
                doc,
                text,
                font,
                PdfPoints::new(font_size.clamp(8.0, 96.0)),
            )?;
            object.set_fill_color(PdfColor::new(rgb.0, rgb.1, rgb.2, 255))?;
            object.translate(PdfPoints::new(x), PdfPoints::new(y))?;
            page.objects_mut().add_text_object(object)?;
            page.regenerate_content()?;
            doc.save_to_file(dest)?;
            Ok(())
        })?;
        self.evict(src);
        Ok(())
    }

    /// Draw a vector markup shape onto a page as a path object.
    /// `kind`: "rect" | "ellipse" | "line" | "arrow". Coordinates are PDF
    /// points (bottom-left origin). `fill_rgb` fills rect/ellipse interiors.
    #[allow(clippy::too_many_arguments)]
    pub fn add_shape(
        &self,
        src: &std::path::Path,
        page_index: u32,
        kind: &str,
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        stroke_rgb: (u8, u8, u8),
        fill_rgb: Option<(u8, u8, u8)>,
        stroke_width: f32,
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        let _guard = self.lock();
        self.with_doc(src, |doc| {
            let stroke = PdfColor::new(stroke_rgb.0, stroke_rgb.1, stroke_rgb.2, 255);
            let width = PdfPoints::new(stroke_width.clamp(0.5, 40.0));
            // Semi-transparent fill so a filled rect/ellipse reads as a
            // highlight rather than hiding the content beneath it.
            let fill = fill_rgb.map(|(r, g, b)| PdfColor::new(r, g, b, 90));
            let mut page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            let object = match kind {
                "rect" | "ellipse" => {
                    let rect = PdfRect::new_from_values(
                        y1.min(y2),
                        x1.min(x2),
                        y1.max(y2),
                        x1.max(x2),
                    );
                    if kind == "rect" {
                        PdfPagePathObject::new_rect(doc, rect, Some(stroke), Some(width), fill)?
                    } else {
                        PdfPagePathObject::new_ellipse(doc, rect, Some(stroke), Some(width), fill)?
                    }
                }
                "arrow" => {
                    let mut path = PdfPagePathObject::new_line(
                        doc,
                        PdfPoints::new(x1),
                        PdfPoints::new(y1),
                        PdfPoints::new(x2),
                        PdfPoints::new(y2),
                        stroke,
                        width,
                    )?;
                    // Two barbs swept back from the tip.
                    let ang = (y2 - y1).atan2(x2 - x1);
                    let len = (stroke_width * 4.0).max(10.0);
                    let barb = 0.5_f32; // ≈ 28°
                    let lx = x2 - len * (ang - barb).cos();
                    let ly = y2 - len * (ang - barb).sin();
                    let rx = x2 - len * (ang + barb).cos();
                    let ry = y2 - len * (ang + barb).sin();
                    path.line_to(PdfPoints::new(lx), PdfPoints::new(ly))?;
                    path.move_to(PdfPoints::new(x2), PdfPoints::new(y2))?;
                    path.line_to(PdfPoints::new(rx), PdfPoints::new(ry))?;
                    path
                }
                _ => PdfPagePathObject::new_line(
                    doc,
                    PdfPoints::new(x1),
                    PdfPoints::new(y1),
                    PdfPoints::new(x2),
                    PdfPoints::new(y2),
                    stroke,
                    width,
                )?,
            };
            page.objects_mut().add_path_object(object)?;
            page.regenerate_content()?;
            doc.save_to_file(dest)?;
            Ok(())
        })?;
        self.evict(src);
        Ok(())
    }

    /// Draw freehand ink: each sub-path is a polyline in PDF points.
    pub fn add_ink(
        &self,
        src: &std::path::Path,
        page_index: u32,
        paths: &[Vec<(f32, f32)>],
        rgb: (u8, u8, u8),
        stroke_width: f32,
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        let _guard = self.lock();
        self.with_doc(src, |doc| {
            let stroke = PdfColor::new(rgb.0, rgb.1, rgb.2, 255);
            let width = PdfPoints::new(stroke_width.clamp(0.5, 40.0));
            let mut page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            for pts in paths {
                let mut it = pts.iter();
                let Some(&(x0, y0)) = it.next() else { continue };
                // A single tap becomes a tiny dab so it leaves a mark.
                let (x1, y1) = it.next().copied().unwrap_or((x0 + 0.4, y0 + 0.4));
                let mut path = PdfPagePathObject::new_line(
                    doc,
                    PdfPoints::new(x0),
                    PdfPoints::new(y0),
                    PdfPoints::new(x1),
                    PdfPoints::new(y1),
                    stroke,
                    width,
                )?;
                for &(x, y) in it {
                    path.line_to(PdfPoints::new(x), PdfPoints::new(y))?;
                }
                page.objects_mut().add_path_object(path)?;
            }
            page.regenerate_content()?;
            doc.save_to_file(dest)?;
            Ok(())
        })?;
        self.evict(src);
        Ok(())
    }

    /// Place a free text box. `(x, y)` is the top-left baseline in PDF points;
    /// lines flow downward. Bold/italic pick a Helvetica variant; `strike`
    /// overlays a line through each rendered line of text.
    #[allow(clippy::too_many_arguments)]
    pub fn add_text_box(
        &self,
        src: &std::path::Path,
        page_index: u32,
        x: f32,
        y: f32,
        text: &str,
        font_size: f32,
        rgb: (u8, u8, u8),
        bold: bool,
        italic: bool,
        strike: bool,
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        let _guard = self.lock();
        self.with_doc(src, |doc| {
            let font = match (bold, italic) {
                (true, true) => doc.fonts_mut().helvetica_bold_oblique(),
                (true, false) => doc.fonts_mut().helvetica_bold(),
                (false, true) => doc.fonts_mut().helvetica_oblique(),
                (false, false) => doc.fonts_mut().helvetica(),
            };
            let size = font_size.clamp(6.0, 96.0);
            let color = PdfColor::new(rgb.0, rgb.1, rgb.2, 255);
            let line_h = size * 1.35;
            let mut page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            for (i, line) in text.replace('\r', "").split('\n').enumerate() {
                if line.is_empty() {
                    continue;
                }
                let ly = y - i as f32 * line_h;
                let mut object = PdfPageTextObject::new(doc, line, font, PdfPoints::new(size))?;
                object.set_fill_color(color)?;
                object.translate(PdfPoints::new(x), PdfPoints::new(ly))?;
                page.objects_mut().add_text_object(object)?;
                if strike {
                    // Approximate width (Helvetica averages ~0.5em/char).
                    let w = line.chars().count() as f32 * size * 0.5;
                    let sy = ly + size * 0.32;
                    let sline = PdfPagePathObject::new_line(
                        doc,
                        PdfPoints::new(x),
                        PdfPoints::new(sy),
                        PdfPoints::new(x + w),
                        PdfPoints::new(sy),
                        color,
                        PdfPoints::new((size * 0.06).max(0.6)),
                    )?;
                    page.objects_mut().add_path_object(sline)?;
                }
            }
            page.regenerate_content()?;
            doc.save_to_file(dest)?;
            Ok(())
        })?;
        self.evict(src);
        Ok(())
    }

    /// Paranoid-mode redaction: for each page with regions, rasterize the
    /// page, paint the regions solid black, and replace the page content
    /// with that flattened image — the underlying text/vectors are truly
    /// gone (not merely covered). Regions are (page_index, x, y, w, h) in
    /// PDF points, bottom-left origin. Clean pages are untouched.
    pub fn redact_pages(
        &self,
        src: &std::path::Path,
        regions: &[(u32, f32, f32, f32, f32)],
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        use image::{Rgba, RgbaImage};
        use std::collections::BTreeMap;

        // Group regions by page.
        let mut by_page: BTreeMap<u32, Vec<(f32, f32, f32, f32)>> = BTreeMap::new();
        for &(page, x, y, w, h) in regions {
            by_page.entry(page).or_default().push((x, y, w, h));
        }
        if by_page.is_empty() {
            return Err(RenderError::EmptyPageSelection);
        }

        const DPI: f32 = 150.0;
        let _guard = self.lock();
        let doc = self.pdfium.load_pdf_from_file(src, None)?;

        for (&page_index, rects) in &by_page {
            let mut page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            let width_pt = page.width().value;
            let height_pt = page.height().value;
            let scale = DPI / 72.0;
            let px_w = (width_pt * scale).round().max(1.0) as u32;
            let px_h = (height_pt * scale).round().max(1.0) as u32;

            // Render the page to an image (scoped so the bitmap's borrow of
            // `page` ends before we mutate the page's objects).
            let mut img: RgbaImage = {
                let config = PdfRenderConfig::new().set_target_width(px_w as i32);
                page.render_with_config(&config)?.as_image()?.into_rgba8()
            };

            // Paint each region solid black (PDF y is bottom-up).
            for &(x, y, w, h) in rects {
                let x0 = ((x * scale).floor() as i64).clamp(0, px_w as i64) as u32;
                let x1 = (((x + w) * scale).ceil() as i64).clamp(0, px_w as i64) as u32;
                let top = height_pt - (y + h);
                let y0 = ((top * scale).floor() as i64).clamp(0, px_h as i64) as u32;
                let y1 = (((top + h) * scale).ceil() as i64).clamp(0, px_h as i64) as u32;
                for py in y0..y1 {
                    for px in x0..x1 {
                        img.put_pixel(px, py, Rgba([0, 0, 0, 255]));
                    }
                }
            }

            // Replace all page content with the flattened image.
            let object_count = page.objects().len();
            page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
            for _ in 0..object_count {
                let removed = page.objects_mut().remove_object_at_index(0);
                if let Ok(obj) = removed {
                    std::mem::forget(obj); // FPDFPageObj_Destroy segfaults on this build
                } else {
                    break;
                }
            }
            let dynamic = image::DynamicImage::ImageRgba8(img);
            let mut image_object = PdfPageImageObject::new(&doc, &dynamic)?;
            image_object.scale(width_pt, height_pt)?;
            image_object.translate(PdfPoints::new(0.0), PdfPoints::new(0.0))?;
            page.objects_mut().add_image_object(image_object)?;
            page.regenerate_content()?;
        }

        doc.save_to_file(dest)?;
        self.evict(src);
        Ok(())
    }

    /// Render a visual diff of one page of two documents: base is the
    /// "new" page (b), with regions that differ from the "old" page (a)
    /// tinted red. Both are rendered at `width`; the taller determines the
    /// canvas. Returns a PNG. Pages beyond a document's length are treated
    /// as blank (so added/removed pages show fully highlighted).
    pub fn compare_page_png(
        &self,
        path_a: &std::path::Path,
        path_b: &std::path::Path,
        page_index: u32,
        width: u32,
        mode: &str,
    ) -> Result<Vec<u8>, RenderError> {
        let _guard = self.lock();
        // "a" / "b" render a single side; "diff" overlays changes in red.
        if mode == "a" || mode == "b" {
            let path = if mode == "a" { path_a } else { path_b };
            let img = self.render_flat(path, page_index, width)?;
            let mut bytes = Vec::new();
            image::DynamicImage::ImageRgb8(img).write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )?;
            return Ok(bytes);
        }
        let render_one = |path: &std::path::Path| -> Option<image::RgbImage> {
            self.render_flat(path, page_index, width).ok()
        };
        let a = render_one(path_a);
        let b = render_one(path_b);

        let (w, h) = match (&a, &b) {
            (Some(a), Some(b)) => (a.width().max(b.width()), a.height().max(b.height())),
            (Some(a), None) => a.dimensions(),
            (None, Some(b)) => b.dimensions(),
            (None, None) => return Err(RenderError::EmptyPageSelection),
        };

        let white = image::Rgb([255u8, 255, 255]);
        let at = |img: &Option<image::RgbImage>, x: u32, y: u32| -> image::Rgb<u8> {
            match img {
                Some(im) if x < im.width() && y < im.height() => *im.get_pixel(x, y),
                _ => white,
            }
        };

        let mut out = image::RgbImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let pa = at(&a, x, y);
                let pb = at(&b, x, y);
                let diff = (pa[0] as i32 - pb[0] as i32).unsigned_abs()
                    + (pa[1] as i32 - pb[1] as i32).unsigned_abs()
                    + (pa[2] as i32 - pb[2] as i32).unsigned_abs();
                // Show the new page; tint changed pixels red.
                let px = if diff > 40 {
                    let base = pb;
                    image::Rgb([
                        (base[0] as u32 / 3 + 255 * 2 / 3) as u8,
                        (base[1] as u32 / 3) as u8,
                        (base[2] as u32 / 3) as u8,
                    ])
                } else {
                    pb
                };
                out.put_pixel(x, y, px);
            }
        }
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(out).write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )?;
        Ok(bytes)
    }

    /// Render a page flattened onto white RGB (helper for compare). Assumes
    /// the op lock is already held by the caller.
    fn render_flat(
        &self,
        path: &std::path::Path,
        page_index: u32,
        width: u32,
    ) -> Result<image::RgbImage, RenderError> {
        self.with_doc(path, |doc| {
            let page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            let config = PdfRenderConfig::new()
                .set_target_width(width.min(4096) as i32)
                .render_form_data(true);
            let rgba = page.render_with_config(&config)?.as_image()?.into_rgba8();
            let (w, h) = rgba.dimensions();
            let mut rgb = image::RgbImage::new(w, h);
            for (dst, src) in rgb.pixels_mut().zip(rgba.pixels()) {
                let al = src[3] as u32;
                let blend = |c: u8| ((c as u32 * al + 255 * (255 - al)) / 255) as u8;
                *dst = image::Rgb([blend(src[0]), blend(src[1]), blend(src[2])]);
            }
            Ok(rgb)
        })
    }

    /// Page count of a document (compare needs the max of two).
    pub fn quick_page_count(&self, path: &std::path::Path) -> Result<u32, RenderError> {
        self.page_count(path)
    }

    /// Whether the file requires a password to open.
    pub fn needs_password(&self, pdf_path: &std::path::Path) -> Result<bool, RenderError> {
        let _guard = self.lock();
        match self.pdfium.load_pdf_from_file(pdf_path, None) {
            Ok(_) => Ok(false),
            Err(PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError)) => {
                Ok(true)
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Document title from metadata, if present and non-empty.
    pub fn title(&self, pdf_path: &std::path::Path) -> Result<Option<String>, RenderError> {
        let _guard = self.lock();
        self.with_doc(pdf_path, |doc| {
            Ok(doc
                .metadata()
                .get(PdfDocumentMetadataTagType::Title)
                .map(|tag| tag.value().trim().to_string())
                .filter(|t| !t.is_empty()))
        })
    }

    /// Extract all text, page by page (form-feed separated).
    pub fn extract_text(&self, pdf_path: &std::path::Path) -> Result<String, RenderError> {
        let _guard = self.lock();
        self.with_doc(pdf_path, |doc| {
            let mut out = String::new();
            for page in doc.pages().iter() {
                if !out.is_empty() {
                    out.push('\u{c}');
                    out.push('\n');
                }
                out.push_str(&page.text()?.all());
            }
            Ok(out)
        })
    }

    /// Move a page object by (dx, dy) PDF points, writing the result to
    /// `dest`.
    pub fn translate_page_object(
        &self,
        src: &std::path::Path,
        page_index: u32,
        object_index: u32,
        dx: f32,
        dy: f32,
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        let _guard = self.lock();
        self.with_doc(src, |doc| {
            let mut page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            let objects = page.objects_mut();
            let mut object = objects
                .get(object_index as usize)
                .map_err(RenderError::Pdfium)?;
            object.translate(PdfPoints::new(dx), PdfPoints::new(dy))?;
            page.regenerate_content()?;
            doc.save_to_file(dest)?;
            Ok(())
        })?;
        self.evict(src);
        Ok(())
    }

    /// Replace an image object's bitmap with an image file, writing the
    /// result to `dest`. The object keeps its position and size.
    pub fn replace_image_object(
        &self,
        src: &std::path::Path,
        page_index: u32,
        object_index: u32,
        image_path: &std::path::Path,
        dest: &std::path::Path,
    ) -> Result<(), RenderError> {
        let replacement = image::open(image_path)?;
        let _guard = self.lock();
        self.with_doc(src, |doc| {
            let mut page = doc.pages().get(page_index.min(i32::MAX as u32) as i32)?;
            let objects = page.objects_mut();
            let mut object = objects
                .get(object_index as usize)
                .map_err(RenderError::Pdfium)?;
            match &mut object {
                PdfPageObject::Image(img) => img.set_image(&replacement)?,
                _ => return Err(RenderError::NotAnImageObject),
            }
            page.regenerate_content()?;
            doc.save_to_file(dest)?;
            Ok(())
        })?;
        self.evict(src);
        Ok(())
    }

    /// Page size in PDF points (1/72 in), for layout placeholders.
    pub fn page_sizes(&self, pdf_path: &std::path::Path) -> Result<Vec<(f32, f32)>, RenderError> {
        let _guard = self.lock();
        self.with_doc(pdf_path, |doc| {
            // By-index sizes (FPDF_GetPageSizeByIndexF) — never loads page
            // objects; the difference between instant and multi-second opens
            // on 1000-page documents.
            Ok(doc
                .pages()
                .page_sizes()?
                .into_iter()
                .map(|r| (r.width().value, r.height().value))
                .collect())
        })
    }
}
