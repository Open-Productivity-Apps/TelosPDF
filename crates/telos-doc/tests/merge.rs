//! Combine-PDF regression: merge blanks, verify structure and that the
//! result renders through PDFium. Requires `cargo xtask fetch-pdfium`.

use telos_doc::{TelosDocument, create_blank, merge_documents};

#[test]
fn merges_two_documents() {
    let dir = std::env::temp_dir().join("telos-doc-merge");
    std::fs::create_dir_all(&dir).unwrap();
    let a = dir.join("a.pdf");
    let b = dir.join("b.pdf");
    let out = dir.join("merged.pdf");
    create_blank(&a).unwrap();
    create_blank(&b).unwrap();

    merge_documents(&[a, b], &out).unwrap();

    let doc = TelosDocument::open(&out).expect("merged file parses");
    assert_eq!(doc.page_count(), 2);

    let renderer = telos_render::Renderer::new().expect("run `cargo xtask fetch-pdfium`");
    assert_eq!(renderer.page_count(&out).unwrap(), 2);
    let png = renderer.render_page_png(&out, 1, 300, 0).unwrap();
    assert!(png.len() > 100);
}
