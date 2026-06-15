//! Document model for TelosPDF.
//!
//! Wraps `lopdf` for structural access (object graph, incremental updates,
//! revisions, tag tree). Rendering and text geometry live in `telos-render`;
//! this crate owns everything about the file's byte-level structure.
//!
//! M0 scope: open a document, expose basic metadata. The revision tracker,
//! incremental-update writer, and tag-tree access land in M1/M2.

use std::path::{Path, PathBuf};

use lopdf::Document;

#[derive(Debug, thiserror::Error)]
pub enum DocError {
    #[error("failed to load PDF: {0}")]
    Load(#[from] lopdf::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("page {0} does not exist")]
    PageOutOfRange(u32),
    #[error("a document must keep at least one page")]
    LastPage,
    #[error("no images given")]
    NoImages,
    #[error("could not read image {0}: {1}")]
    Image(String, String),
    #[error("comment not found")]
    CommentNotFound,
    #[error("only the comment's author can change it")]
    NotCommentAuthor,
    #[error("wrong edit code for this comment")]
    WrongEditCode,
    #[error("wrong password")]
    WrongPassword,
    #[error("this document is not password-protected")]
    NotProtected,
    #[error("combining needs at least two PDFs")]
    NeedTwoDocuments,
    #[error("no page tree found in the input documents")]
    NoPagesTree,
}

/// A text (sticky-note) annotation, listed for the Comments panel.
#[derive(Debug, Clone)]
pub struct Comment {
    /// lopdf object id — stable within a revision, used for edit/delete.
    pub id: (u32, u16),
    /// 0-based page index.
    pub page_index: u32,
    pub author: String,
    pub contents: String,
    /// PDF date string (D:YYYYMMDDHHMMSS…), raw.
    pub modified: String,
    /// Object id of the comment this replies to (`/IRT`), if any.
    pub reply_to: Option<(u32, u16)>,
    /// Annotation rectangle (x, y, w, h) in PDF points, bottom-left origin.
    pub rect: (f32, f32, f32, f32),
    /// An access code is set — anyone the author shares it with can edit
    /// this comment from another device (cooperative, honest-viewer check).
    pub has_edit_code: bool,
    /// Note-icon colour from `/C`, if the annotation carries one.
    pub color: Option<(u8, u8, u8)>,
}

/// An open PDF document (structural view).
pub struct TelosDocument {
    path: PathBuf,
    inner: Document,
}

impl TelosDocument {
    /// Open a PDF from disk.
    ///
    /// Encrypted documents open if lopdf can decrypt them with an empty
    /// password; password prompting is wired up in M3 (Protect).
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DocError> {
        let path = path.as_ref().to_path_buf();
        let inner = Document::load(&path)?;
        Ok(Self { path, inner })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn page_count(&self) -> usize {
        self.inner.get_pages().len()
    }

    /// PDF version header (e.g. "1.7").
    pub fn version(&self) -> String {
        self.inner.version.clone()
    }

    /// Document title from the Info dictionary, if present.
    ///
    /// Lossy UTF-8 decode for M0; proper PDFDocEncoding/UTF-16 handling
    /// arrives with the metadata editor.
    pub fn title(&self) -> Option<String> {
        let info_ref = self.inner.trailer.get(b"Info").ok()?.as_reference().ok()?;
        let info = self.inner.get_dictionary(info_ref).ok()?;
        let bytes = info.get(b"Title").ok()?.as_str().ok()?;
        Some(String::from_utf8_lossy(bytes).into_owned())
    }

    /// Rotate one page (1-based) by ±90°, adjusting its `/Rotate` entry.
    ///
    /// M0 sets the page-local key only; inherited `/Rotate` from the page
    /// tree is handled with the full document model in M1.
    pub fn rotate_page(&mut self, page_no: u32, clockwise: bool) -> Result<(), DocError> {
        let &page_id = self
            .inner
            .get_pages()
            .get(&page_no)
            .ok_or(DocError::PageOutOfRange(page_no))?;
        let current = self
            .inner
            .get_dictionary(page_id)
            .ok()
            .and_then(|d| d.get(b"Rotate").ok())
            .and_then(|o| o.as_i64().ok())
            .unwrap_or(0);
        let delta = if clockwise { 90 } else { -90 };
        let dict = self.inner.get_object_mut(page_id)?.as_dict_mut()?;
        dict.set("Rotate", (current + delta).rem_euclid(360));
        Ok(())
    }

    /// Delete one page (1-based). Refuses to delete the final page.
    pub fn delete_page(&mut self, page_no: u32) -> Result<(), DocError> {
        let pages = self.inner.get_pages();
        if !pages.contains_key(&page_no) {
            return Err(DocError::PageOutOfRange(page_no));
        }
        if pages.len() <= 1 {
            return Err(DocError::LastPage);
        }
        self.inner.delete_pages(&[page_no]);
        Ok(())
    }

    /// Write the current state to `path` (full rewrite; incremental updates
    /// arrive in M1 with the revision tracker).
    pub fn save_to(&mut self, path: impl AsRef<Path>) -> Result<(), DocError> {
        self.inner.save(path.as_ref())?;
        Ok(())
    }

    /// All text (sticky-note) annotations in the document, page order.
    pub fn comments(&self) -> Vec<Comment> {
        let mut out = Vec::new();
        for (page_no, page_id) in self.inner.get_pages() {
            let Ok(annot_ids) = self.annotation_ids(page_id) else {
                continue;
            };
            for annot_id in annot_ids {
                let Ok(dict) = self.inner.get_dictionary(annot_id) else {
                    continue;
                };
                let is_text = dict
                    .get(b"Subtype")
                    .ok()
                    .and_then(|o| o.as_name().ok())
                    .is_some_and(|n| n == b"Text");
                if !is_text {
                    continue;
                }
                let text_of = |key: &[u8]| -> String {
                    dict.get(key)
                        .ok()
                        .and_then(|o| o.as_str().ok())
                        .map(|b| String::from_utf8_lossy(b).into_owned())
                        .unwrap_or_default()
                };
                let rect = dict
                    .get(b"Rect")
                    .ok()
                    .and_then(|o| o.as_array().ok())
                    .map(|arr| {
                        let n = |i: usize| -> f32 {
                            arr.get(i)
                                .map(|o| match o {
                                    lopdf::Object::Integer(v) => *v as f32,
                                    lopdf::Object::Real(v) => *v,
                                    _ => 0.0,
                                })
                                .unwrap_or(0.0)
                        };
                        let (x1, y1, x2, y2) = (n(0), n(1), n(2), n(3));
                        (x1.min(x2), y1.min(y2), (x2 - x1).abs(), (y2 - y1).abs())
                    })
                    .unwrap_or((0.0, 0.0, 0.0, 0.0));
                let color = dict
                    .get(b"C")
                    .ok()
                    .and_then(|o| o.as_array().ok())
                    .filter(|arr| arr.len() >= 3)
                    .map(|arr| {
                        let ch = |i: usize| -> u8 {
                            let v = arr
                                .get(i)
                                .map(|o| match o {
                                    lopdf::Object::Integer(v) => *v as f32,
                                    lopdf::Object::Real(v) => *v,
                                    _ => 0.0,
                                })
                                .unwrap_or(0.0);
                            (v.clamp(0.0, 1.0) * 255.0).round() as u8
                        };
                        (ch(0), ch(1), ch(2))
                    });
                out.push(Comment {
                    id: annot_id,
                    page_index: page_no - 1,
                    author: text_of(b"T"),
                    contents: text_of(b"Contents"),
                    modified: text_of(b"M"),
                    reply_to: dict.get(b"IRT").ok().and_then(|o| o.as_reference().ok()),
                    rect,
                    has_edit_code: dict.get(b"TelosEditCode").is_ok(),
                    color,
                });
            }
        }
        out
    }

    /// Add a sticky-note comment to a page (0-based index). Replies pass the
    /// parent comment's id as `reply_to` (`/IRT`).
    pub fn add_comment(
        &mut self,
        page_index: u32,
        contents: &str,
        author: &str,
        reply_to: Option<(u32, u16)>,
        edit_code: Option<&str>,
        color: Option<(u8, u8, u8)>,
    ) -> Result<(u32, u16), DocError> {
        use lopdf::{Dictionary, Object};

        let page_no = page_index + 1;
        let &page_id = self
            .inner
            .get_pages()
            .get(&page_no)
            .ok_or(DocError::PageOutOfRange(page_no))?;

        let mut dict = Dictionary::new();
        dict.set("Type", Object::Name(b"Annot".to_vec()));
        dict.set("Subtype", Object::Name(b"Text".to_vec()));
        // Note icon near the top-left corner; proper placement UX is M2.
        dict.set(
            "Rect",
            Object::Array(vec![40.into(), 780.into(), 62.into(), 802.into()]),
        );
        dict.set("Contents", Object::string_literal(contents));
        dict.set("T", Object::string_literal(author));
        dict.set("M", Object::string_literal(pdf_now()));
        dict.set("Name", Object::Name(b"Comment".to_vec()));
        dict.set("F", Object::Integer(4)); // print flag
        if let Some((r, g, b)) = color {
            // /C is an RGB array in 0..1.
            dict.set(
                "C",
                Object::Array(vec![
                    Object::Real(r as f32 / 255.0),
                    Object::Real(g as f32 / 255.0),
                    Object::Real(b as f32 / 255.0),
                ]),
            );
        }
        if let Some(parent) = reply_to {
            dict.set("IRT", Object::Reference(parent));
        }
        if let Some(code) = edit_code.filter(|c| !c.trim().is_empty()) {
            dict.set(
                "TelosEditCode",
                Object::string_literal(hash_edit_code(code)),
            );
        }
        let annot_id = self.inner.add_object(dict);

        // Append to the page /Annots (creating it if missing; the array may
        // itself live behind a reference).
        let page_dict = self.inner.get_object_mut(page_id)?.as_dict_mut()?;
        match page_dict.get_mut(b"Annots") {
            Ok(Object::Array(arr)) => arr.push(Object::Reference(annot_id)),
            Ok(Object::Reference(r)) => {
                let r = *r;
                self.inner
                    .get_object_mut(r)?
                    .as_array_mut()?
                    .push(Object::Reference(annot_id));
            }
            _ => {
                page_dict.set("Annots", Object::Array(vec![Object::Reference(annot_id)]));
            }
        }
        Ok(annot_id)
    }

    /// Edit a comment's text. Only the original author may edit.
    pub fn edit_comment(
        &mut self,
        id: (u32, u16),
        contents: &str,
        identities: &[String],
        code: Option<&str>,
        set_code: Option<&str>,
    ) -> Result<(), DocError> {
        use lopdf::Object;
        let is_author = self.assert_comment_access(id, identities, code)?;
        let dict = self.inner.get_object_mut(id)?.as_dict_mut()?;
        dict.set("Contents", Object::string_literal(contents));
        dict.set("M", Object::string_literal(pdf_now()));
        // Only the author may attach/replace the shared edit code.
        if is_author && let Some(new_code) = set_code.filter(|c| !c.trim().is_empty()) {
            dict.set(
                "TelosEditCode",
                Object::string_literal(hash_edit_code(new_code)),
            );
        }
        Ok(())
    }

    /// Delete a comment (and its replies). Only the original author may
    /// delete.
    /// Delete a comment (and its replies). Deletion is intentionally open to
    /// anyone — a reviewer must be able to clear a thread. (Editing another
    /// person's wording stays gated by author/edit-code.)
    pub fn delete_comment(&mut self, id: (u32, u16)) -> Result<(), DocError> {
        // Cascade: replies (and replies-to-replies) go with their parent.
        let mut doomed = vec![id];
        loop {
            let more: Vec<(u32, u16)> = self
                .comments()
                .iter()
                .filter(|c| c.reply_to.is_some_and(|p| doomed.contains(&p)))
                .map(|c| c.id)
                .filter(|i| !doomed.contains(i))
                .collect();
            if more.is_empty() {
                break;
            }
            doomed.extend(more);
        }

        // Drop references from every page's /Annots, then the objects.
        let page_ids: Vec<_> = self.inner.get_pages().values().copied().collect();
        for page_id in page_ids {
            let Ok(annot_ids) = self.annotation_ids(page_id) else {
                continue;
            };
            if !annot_ids.iter().any(|a| doomed.contains(a)) {
                continue;
            }
            self.remove_annot_refs(page_id, &doomed)?;
        }
        for id in doomed {
            self.inner.objects.remove(&id);
        }
        Ok(())
    }

    /// Access check: the author edits freely; anyone else needs the shared
    /// edit code (compared by SHA-256 hash). Returns whether the caller is
    /// the author.
    fn assert_comment_access(
        &self,
        id: (u32, u16),
        identities: &[String],
        code: Option<&str>,
    ) -> Result<bool, DocError> {
        let dict = self
            .inner
            .get_dictionary(id)
            .map_err(|_| DocError::CommentNotFound)?;
        let is_text = dict
            .get(b"Subtype")
            .ok()
            .and_then(|o| o.as_name().ok())
            .is_some_and(|n| n == b"Text");
        if !is_text {
            return Err(DocError::CommentNotFound);
        }
        let owner = dict
            .get(b"T")
            .ok()
            .and_then(|o| o.as_str().ok())
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .unwrap_or_default();
        // The same person shows up under different names across apps
        // (unix login vs macOS full name — Preview writes the latter), so
        // ownership matches any known identity, case-insensitively.
        let owner_norm = owner.trim().to_lowercase();
        if identities
            .iter()
            .any(|i| i.trim().to_lowercase() == owner_norm)
        {
            return Ok(true);
        }
        let stored = dict
            .get(b"TelosEditCode")
            .ok()
            .and_then(|o| o.as_str().ok())
            .map(|b| String::from_utf8_lossy(b).into_owned());
        match (stored, code) {
            (Some(hash), Some(code)) if hash == hash_edit_code(code) => Ok(false),
            (Some(_), Some(_)) => Err(DocError::WrongEditCode),
            (Some(_), None) => Err(DocError::WrongEditCode),
            (None, _) => Err(DocError::NotCommentAuthor),
        }
    }

    /// Resolved annotation object ids for a page (handles /Annots behind a
    /// reference; ignores inline annotation dicts, which we never write).
    fn annotation_ids(&self, page_id: (u32, u16)) -> Result<Vec<(u32, u16)>, DocError> {
        let page = self.inner.get_dictionary(page_id)?;
        let Ok(annots) = page.get(b"Annots") else {
            return Ok(Vec::new());
        };
        let arr = match annots {
            lopdf::Object::Array(arr) => arr.clone(),
            lopdf::Object::Reference(r) => self.inner.get_object(*r)?.as_array()?.clone(),
            _ => return Ok(Vec::new()),
        };
        Ok(arr.iter().filter_map(|o| o.as_reference().ok()).collect())
    }

    fn remove_annot_refs(
        &mut self,
        page_id: (u32, u16),
        doomed: &[(u32, u16)],
    ) -> Result<(), DocError> {
        use lopdf::Object;
        let keep = |arr: &mut Vec<Object>| {
            arr.retain(|o| o.as_reference().ok().is_none_or(|r| !doomed.contains(&r)));
        };
        let page_dict = self.inner.get_object_mut(page_id)?.as_dict_mut()?;
        match page_dict.get_mut(b"Annots") {
            Ok(Object::Array(arr)) => keep(arr),
            Ok(Object::Reference(r)) => {
                let r = *r;
                keep(self.inner.get_object_mut(r)?.as_array_mut()?);
            }
            _ => {}
        }
        Ok(())
    }

    /// Escape hatch for lower layers while the façade API grows.
    pub fn raw(&self) -> &Document {
        &self.inner
    }
}

/// Whether a file is encrypted (needs a password / has permissions). Best
/// effort: returns false if the file can't be parsed at all.
pub fn is_encrypted(path: impl AsRef<Path>) -> bool {
    Document::load(path.as_ref())
        .map(|d| d.is_encrypted())
        .unwrap_or(false)
}

/// Decrypt `src` with `password` and write the unlocked document to
/// `dest`. Fails with [DocError::WrongPassword] on a bad password.
pub fn unlock_to(
    src: impl AsRef<Path>,
    dest: impl AsRef<Path>,
    password: &str,
) -> Result<(), DocError> {
    // Plain load parses only the Encrypt dict of a protected file — use it
    // as the protection probe, then reload with the password (lopdf's
    // supported decryption path).
    let probe = Document::load(src.as_ref())?;
    if !probe.is_encrypted() {
        return Err(DocError::NotProtected);
    }
    drop(probe);
    let mut doc = Document::load_with_password(src.as_ref(), password)
        .map_err(|_| DocError::WrongPassword)?;
    // Belt and braces: never carry encryption into the unlocked copy.
    let _ = doc.trailer.remove(b"Encrypt");
    doc.encryption_state = None;
    doc.save(dest.as_ref())?;
    Ok(())
}

/// Permission choices for [protect_to] (true = allowed for the user).
#[derive(Debug, Clone, Copy)]
pub struct ProtectPermissions {
    pub print: bool,
    pub copy: bool,
    pub modify: bool,
    pub annotate: bool,
}

/// Write a password-protected (AES-128, V4) copy of `src` to `dest`.
///
/// AES-256 (R6) requires the qpdf integration (PLAN.md); lopdf tops out at
/// V4 today. The UI labels the level honestly.
pub fn protect_to(
    src: impl AsRef<Path>,
    dest: impl AsRef<Path>,
    user_password: &str,
    owner_password: &str,
    perms: ProtectPermissions,
) -> Result<(), DocError> {
    use lopdf::encryption::crypt_filters::{Aes128CryptFilter, CryptFilter};
    use lopdf::{EncryptionState, EncryptionVersion, Permissions};
    use std::collections::BTreeMap;
    use std::sync::Arc;

    let mut doc = Document::load(src.as_ref())?;

    // Key derivation needs the trailer /ID; files we generate (and plenty
    // in the wild) lack one. Derive deterministically from content + time.
    if doc.trailer.get(b"ID").is_err() {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(std::fs::read(src.as_ref())?);
        hasher.update(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos().to_le_bytes())
                .unwrap_or_default(),
        );
        let digest = hasher.finalize();
        let id = lopdf::Object::String(digest[..16].to_vec(), lopdf::StringFormat::Hexadecimal);
        let id2 = lopdf::Object::String(digest[16..].to_vec(), lopdf::StringFormat::Hexadecimal);
        doc.trailer.set("ID", lopdf::Object::Array(vec![id, id2]));
    }

    let mut permissions = Permissions::empty();
    // Accessibility extraction stays on — never lock out screen readers.
    permissions.insert(Permissions::COPYABLE_FOR_ACCESSIBILITY);
    if perms.print {
        permissions.insert(Permissions::PRINTABLE | Permissions::PRINTABLE_IN_HIGH_QUALITY);
    }
    if perms.copy {
        permissions.insert(Permissions::COPYABLE);
    }
    if perms.modify {
        permissions.insert(Permissions::MODIFIABLE | Permissions::ASSEMBLABLE);
    }
    if perms.annotate {
        permissions.insert(Permissions::ANNOTABLE | Permissions::FILLABLE);
    }

    let mut crypt_filters: BTreeMap<Vec<u8>, Arc<dyn CryptFilter>> = BTreeMap::new();
    crypt_filters.insert(b"StdCF".to_vec(), Arc::new(Aes128CryptFilter));

    let owner = if owner_password.is_empty() {
        user_password
    } else {
        owner_password
    };
    let version = EncryptionVersion::V4 {
        document: &doc,
        encrypt_metadata: true,
        crypt_filters,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: owner,
        user_password,
        permissions,
    };
    let state = EncryptionState::try_from(version)?;
    doc.encrypt(&state)?;

    // lopdf writes /O and /U as literal strings; their raw binary doesn't
    // survive its own re-parse. Hex string format is always round-trip safe.
    if let Ok(encrypt_id) = doc.trailer.get(b"Encrypt").and_then(|o| o.as_reference())
        && let Ok(dict) = doc.get_object_mut(encrypt_id).and_then(|o| o.as_dict_mut())
    {
        for key in [b"O".as_slice(), b"U".as_slice()] {
            if let Ok(lopdf::Object::String(bytes, format)) = dict.get_mut(key) {
                let bytes = bytes.clone();
                let _ = std::mem::replace(format, lopdf::StringFormat::Hexadecimal);
                dict.set(
                    key,
                    lopdf::Object::String(bytes, lopdf::StringFormat::Hexadecimal),
                );
            }
        }
    }
    doc.save(dest.as_ref())?;
    Ok(())
}

/// Structural compression pass: deflate uncompressed streams, drop
/// unreferenced objects, and save with object/xref streams.
pub fn compact_to(src: impl AsRef<Path>, dest: impl AsRef<Path>) -> Result<(), DocError> {
    let mut doc = Document::load(src.as_ref())?;
    doc.compress();
    doc.prune_objects();
    let mut file = std::fs::File::create(dest.as_ref())?;
    doc.save_modern(&mut file)?;
    Ok(())
}

/// One OCR-recognised text block, in PDF points (origin bottom-left).
#[derive(Debug, Clone)]
pub struct OcrBlock {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Tesseract's glyphless font (Apache-2.0): every CID renders as an empty
/// glyph, so text laid with it is inherently invisible yet fully selectable,
/// searchable, and copyable — including CJK — via the Identity ToUnicode map.
const GLYPHLESS_TTF: &[u8] = include_bytes!("../assets/glyphless.ttf");

const IDENTITY_TOUNICODE: &str = "/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfrange
<0000> <FFFF> <0000>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end
";

/// Add an invisible, searchable text layer (OCR result) over each page.
/// `pages[i]` holds the blocks for page i; pages with no blocks are left
/// untouched. The original page content — vector or scanned — is preserved
/// byte-for-byte; only a text overlay in rendering mode 3 (no paint) is added.
pub fn add_text_layer(
    src: impl AsRef<Path>,
    out: impl AsRef<Path>,
    pages: &[Vec<OcrBlock>],
) -> Result<(), DocError> {
    use lopdf::{Dictionary, Object, Stream, dictionary};

    let mut doc = Document::load(src.as_ref())?;

    // Shared font machinery, added once.
    let font_file = doc.add_object(Stream::new(
        dictionary! { "Length1" => GLYPHLESS_TTF.len() as i64 },
        GLYPHLESS_TTF.to_vec(),
    ));
    let descriptor = doc.add_object(dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => "GlyphLessFont",
        "Flags" => 4,
        "FontBBox" => vec![0.into(), (-1).into(), 500.into(), 1000.into()],
        "ItalicAngle" => 0,
        "Ascent" => 1000,
        "Descent" => (-1),
        "CapHeight" => 1000,
        "StemV" => 80,
        "FontFile2" => font_file,
    });
    // All 65536 CIDs map to glyph 0 (the blank glyph).
    let cid_to_gid = doc.add_object(Stream::new(Dictionary::new(), vec![0u8; 131072]));
    let descendant = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType2",
        "BaseFont" => "GlyphLessFont",
        "CIDSystemInfo" => dictionary! {
            "Registry" => Object::string_literal("Adobe"),
            "Ordering" => Object::string_literal("Identity"),
            "Supplement" => 0,
        },
        "FontDescriptor" => descriptor,
        "DW" => 500,
        "CIDToGIDMap" => cid_to_gid,
    });
    let to_unicode = doc.add_object(Stream::new(
        Dictionary::new(),
        IDENTITY_TOUNICODE.as_bytes().to_vec(),
    ));
    let font = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => "GlyphLessFont",
        "Encoding" => "Identity-H",
        "DescendantFonts" => vec![descendant.into()],
        "ToUnicode" => to_unicode,
    });

    let page_ids: Vec<_> = doc.get_pages().values().copied().collect();
    for (idx, page_id) in page_ids.into_iter().enumerate() {
        let Some(blocks) = pages.get(idx) else { break };
        if blocks.is_empty() {
            continue;
        }

        // Build the overlay content stream: one BT/ET per line, rendering
        // mode 3, horizontally scaled so the advance roughly spans the box
        // (selection geometry then matches what the eye sees underneath).
        let mut content = String::from("q\n");
        for b in blocks {
            let lines: Vec<&str> = b.text.lines().filter(|l| !l.trim().is_empty()).collect();
            if lines.is_empty() {
                continue;
            }
            let size = (b.h / lines.len() as f32).clamp(3.0, 72.0);
            for (li, line) in lines.iter().enumerate() {
                let n = line.chars().count().max(1) as f32;
                // DW 500/1000 → each CID advances half the font size.
                let natural = 0.5 * size * n;
                let tz = ((b.w / natural) * 100.0).clamp(5.0, 1000.0);
                let baseline = b.y + b.h - size * (li as f32 + 0.8);
                let hex: String = line
                    .encode_utf16()
                    .map(|u| format!("{u:04X}"))
                    .collect();
                content.push_str(&format!(
                    "BT\n3 Tr\n/GlyphLess {size:.2} Tf\n{tz:.1} Tz\n1 0 0 1 {x:.2} {baseline:.2} Tm\n<{hex}> Tj\nET\n",
                    x = b.x,
                ));
            }
        }
        content.push_str("Q\n");
        let overlay = doc.add_object(Stream::new(Dictionary::new(), content.into_bytes()));

        // Page resources: materialise (possibly inherited/shared) resources
        // into a page-local dict so adding our font can't leak elsewhere.
        let mut resources = match doc
            .get_object(page_id)
            .ok()
            .and_then(|p| p.as_dict().ok())
            .and_then(|p| p.get(b"Resources").ok())
        {
            Some(Object::Dictionary(d)) => d.clone(),
            Some(Object::Reference(r)) => doc
                .get_object(*r)
                .ok()
                .and_then(|o| o.as_dict().ok())
                .cloned()
                .unwrap_or_default(),
            _ => {
                // Inherited via the page tree (or absent) — collect it.
                doc.get_page_resources(page_id)
                    .map(|(inherited, _)| inherited.cloned())
                    .ok()
                    .flatten()
                    .unwrap_or_default()
            }
        };
        let mut fonts = match resources.get(b"Font") {
            Ok(Object::Dictionary(d)) => d.clone(),
            Ok(Object::Reference(r)) => doc
                .get_object(*r)
                .ok()
                .and_then(|o| o.as_dict().ok())
                .cloned()
                .unwrap_or_default(),
            _ => Dictionary::new(),
        };
        fonts.set("GlyphLess", font);
        resources.set("Font", fonts);

        let page = doc
            .get_object_mut(page_id)
            .ok()
            .and_then(|p| p.as_dict_mut().ok())
            .ok_or(DocError::PageOutOfRange(idx as u32))?;
        page.set("Resources", resources);

        // Contents: normalise to an array and append the overlay.
        let contents = match page.get(b"Contents") {
            Ok(Object::Array(a)) => {
                let mut a = a.clone();
                a.push(overlay.into());
                a
            }
            Ok(other) => vec![other.clone(), overlay.into()],
            Err(_) => vec![overlay.into()],
        };
        page.set("Contents", contents);
    }

    doc.compress();
    let mut file = std::fs::File::create(out.as_ref())?;
    doc.save_modern(&mut file)?;
    Ok(())
}

/// Build a simple text PDF — one page per entry, Helvetica, wrapped lines.
/// Used by Translate PDF: visible output with the built-in base-14 font, so
/// Latin-script targets only (unencodable characters degrade to '?').
pub fn build_text_pdf(
    out: impl AsRef<Path>,
    pages: &[String],
    page_size: (f32, f32),
) -> Result<(), DocError> {
    use lopdf::{Object, Stream, dictionary};

    let (w, h) = page_size;
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let font = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
        "Encoding" => "WinAnsiEncoding",
    });

    let size = 11.0f32;
    let leading = 15.0f32;
    let margin = 54.0f32;
    let max_chars = (((w - margin * 2.0) / (size * 0.5)) as usize).max(20);

    let mut kids: Vec<Object> = Vec::new();
    for text in pages {
        // Wrap on spaces to the page width; hard-break monster words.
        let mut lines: Vec<String> = Vec::new();
        for raw in text.lines() {
            let mut line = String::new();
            for word in raw.split_whitespace() {
                if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > max_chars {
                    lines.push(std::mem::take(&mut line));
                }
                if !line.is_empty() {
                    line.push(' ');
                }
                line.push_str(word);
                while line.chars().count() > max_chars {
                    let head: String = line.chars().take(max_chars).collect();
                    let rest: String = line.chars().skip(max_chars).collect();
                    lines.push(head);
                    line = rest;
                }
            }
            lines.push(line);
        }

        let mut content = format!("BT\n/F1 {size} Tf\n{leading} TL\n1 0 0 1 {margin} {y:.1} Tm\n", y = h - margin);
        let per_page = (((h - margin * 2.0) / leading) as usize).max(1);
        for line in lines.iter().take(per_page * 4) {
            // Latin-1 with PDF string escaping; anything wider degrades.
            let esc: String = line
                .chars()
                .map(|c| {
                    let b = if (c as u32) < 256 { c } else { '?' };
                    match b {
                        '(' => "\\(".to_string(),
                        ')' => "\\)".to_string(),
                        '\\' => "\\\\".to_string(),
                        _ => b.to_string(),
                    }
                })
                .collect();
            content.push_str(&format!("({esc}) '\n"));
        }
        content.push_str("ET\n");

        let stream = doc.add_object(Stream::new(Dictionary::new(), content.into_bytes()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), w.into(), h.into()],
            "Contents" => stream,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });
        kids.push(page_id.into());
    }

    let count = kids.len() as i64;
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    let mut file = std::fs::File::create(out.as_ref())?;
    doc.save_modern(&mut file)?;
    Ok(())
}

use lopdf::Dictionary;

/// Merge multiple PDFs into one, in order. Adapted from lopdf's canonical
/// merge algorithm. Outlines/bookmarks are not carried over yet (v1 work);
/// pages, resources, and annotations survive.
pub fn merge_documents(paths: &[PathBuf], out: impl AsRef<Path>) -> Result<(), DocError> {
    use lopdf::{Dictionary, Object, ObjectId};
    use std::collections::BTreeMap;

    if paths.len() < 2 {
        return Err(DocError::NeedTwoDocuments);
    }

    let mut max_id = 1u32;
    let mut documents_pages: Vec<(ObjectId, Object)> = Vec::new();
    let mut documents_objects: BTreeMap<ObjectId, Object> = BTreeMap::new();

    for path in paths {
        let mut doc = Document::load(path)?;
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;
        for (_, object_id) in doc.get_pages() {
            documents_pages.push((object_id, doc.get_object(object_id)?.clone()));
        }
        documents_objects.append(&mut doc.objects);
    }

    let mut merged = Document::with_version("1.7");
    let mut pages_root: Option<(ObjectId, Dictionary)> = None;

    // Copy everything except catalogs and page-tree nodes (rebuilt below).
    for (object_id, object) in documents_objects {
        match object.type_name().unwrap_or(b"") {
            b"Catalog" => {}
            b"Pages" => {
                if let Ok(dict) = object.as_dict() {
                    let mut dict = dict.clone();
                    dict.remove(b"Kids");
                    dict.remove(b"Count");
                    match &mut pages_root {
                        Some((_, root)) => root.extend(&dict),
                        None => pages_root = Some((object_id, dict)),
                    }
                }
            }
            b"Page" => {} // inserted below with fixed parents
            _ => {
                merged.objects.insert(object_id, object);
            }
        }
    }

    let (pages_id, mut pages_dict) = pages_root.ok_or(DocError::NoPagesTree)?;

    for (page_id, page_object) in &documents_pages {
        if let Ok(dict) = page_object.as_dict() {
            let mut dict = dict.clone();
            dict.set("Parent", Object::Reference(pages_id));
            merged.objects.insert(*page_id, Object::Dictionary(dict));
        }
    }

    pages_dict.set("Type", Object::Name(b"Pages".to_vec()));
    pages_dict.set("Count", documents_pages.len() as i64);
    pages_dict.set(
        "Kids",
        Object::Array(
            documents_pages
                .iter()
                .map(|(id, _)| Object::Reference(*id))
                .collect(),
        ),
    );
    merged
        .objects
        .insert(pages_id, Object::Dictionary(pages_dict));

    let catalog_id = (max_id, 0);
    let mut catalog = Dictionary::new();
    catalog.set("Type", Object::Name(b"Catalog".to_vec()));
    catalog.set("Pages", Object::Reference(pages_id));
    merged
        .objects
        .insert(catalog_id, Object::Dictionary(catalog));
    merged.trailer.set("Root", Object::Reference(catalog_id));
    merged.max_id = merged.objects.keys().map(|(n, _)| *n).max().unwrap_or(1);

    merged.renumber_objects();
    merged.compress();
    merged.save(out.as_ref())?;
    Ok(())
}

/// Hex SHA-256 of an edit code — the annotation stores only the hash
/// (Kerckhoffs: the mechanism is public, the code is the secret). This is
/// cooperative protection enforced by honest viewers, not cryptography
/// binding the PDF itself.
fn hash_edit_code(code: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(code.trim().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Current time as a PDF date string (`D:YYYYMMDDHHMMSS`), local time.
fn pdf_now() -> String {
    chrono::Local::now().format("D:%Y%m%d%H%M%S").to_string()
}

/// Create a blank single-page A4 PDF at `path`.
///
/// M0 helper for "Create new PDF" (moves to `telos-convert`/krilla with
/// proper templates later).
pub fn create_blank(path: impl AsRef<Path>) -> Result<(), DocError> {
    use pdf_writer::{Pdf, Rect, Ref};

    let catalog_id = Ref::new(1);
    let page_tree_id = Ref::new(2);
    let page_id = Ref::new(3);

    let mut pdf = Pdf::new();
    pdf.catalog(catalog_id).pages(page_tree_id);
    pdf.pages(page_tree_id).kids([page_id]).count(1);
    pdf.page(page_id)
        .media_box(Rect::new(0.0, 0.0, 595.0, 842.0))
        .parent(page_tree_id);
    std::fs::write(path, pdf.finish())?;
    Ok(())
}

/// Create a PDF from images — one page per image, page sized to the image
/// (96 px = 72 pt). Accepts every format the `image` crate decodes (JPEG,
/// PNG, WebP, BMP, TIFF, GIF, …); pixels are embedded as JPEG (DCTDecode).
///
/// Moves to `telos-convert`/krilla in M2 with quality options.
pub fn create_from_images(
    image_paths: &[PathBuf],
    out_path: impl AsRef<Path>,
) -> Result<(), DocError> {
    use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect, Ref};

    if image_paths.is_empty() {
        return Err(DocError::NoImages);
    }

    let n = image_paths.len();
    let catalog_id = Ref::new(1);
    let tree_id = Ref::new(2);
    // Layout: pages at 3..3+n, contents at 3+n.., xobjects at 3+2n..
    let page_id = |i: usize| Ref::new((3 + i) as i32);
    let content_id = |i: usize| Ref::new((3 + n + i) as i32);
    let xobject_id = |i: usize| Ref::new((3 + 2 * n + i) as i32);

    let mut pdf = Pdf::new();
    pdf.catalog(catalog_id).pages(tree_id);
    pdf.pages(tree_id).kids((0..n).map(page_id)).count(n as i32);

    for (i, image_path) in image_paths.iter().enumerate() {
        let decoded = image::open(image_path)
            .map_err(|e| DocError::Image(image_path.display().to_string(), e.to_string()))?
            .to_rgb8();
        let (px_w, px_h) = decoded.dimensions();
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
            .encode_image(&decoded)
            .map_err(|e| DocError::Image(image_path.display().to_string(), e.to_string()))?;

        let pt_w = px_w as f32 * 72.0 / 96.0;
        let pt_h = px_h as f32 * 72.0 / 96.0;

        let mut page = pdf.page(page_id(i));
        page.media_box(Rect::new(0.0, 0.0, pt_w, pt_h));
        page.parent(tree_id);
        page.contents(content_id(i));
        page.resources()
            .x_objects()
            .pair(Name(b"Im0"), xobject_id(i));
        page.finish();

        let mut xobject = pdf.image_xobject(xobject_id(i), &jpeg);
        xobject.filter(Filter::DctDecode);
        xobject.width(px_w as i32);
        xobject.height(px_h as i32);
        xobject.color_space().device_rgb();
        xobject.bits_per_component(8);
        xobject.finish();

        let mut content = Content::new();
        content
            .transform([pt_w, 0.0, 0.0, pt_h, 0.0, 0.0])
            .x_object(Name(b"Im0"));
        pdf.stream(content_id(i), &content.finish());
    }

    std::fs::write(out_path, pdf.finish())?;
    Ok(())
}
