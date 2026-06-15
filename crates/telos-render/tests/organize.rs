//! Organize regression: reorder/extract via restructure_pages and blank
//! insertion. Requires `cargo xtask fetch-pdfium`.

use pdf_writer::{Finish, Pdf, Rect, Ref};
use telos_render::Renderer;

/// Three pages with distinct widths (100/200/300 pt) to track identity.
fn fixture(dir: &std::path::Path) -> std::path::PathBuf {
    let catalog = Ref::new(1);
    let tree = Ref::new(2);
    let ids: Vec<Ref> = (0..3).map(|i| Ref::new(3 + i)).collect();
    let mut pdf = Pdf::new();
    pdf.catalog(catalog).pages(tree);
    pdf.pages(tree).kids(ids.iter().copied()).count(3);
    for (i, &id) in ids.iter().enumerate() {
        let mut page = pdf.page(id);
        page.media_box(Rect::new(0.0, 0.0, 100.0 * (i as f32 + 1.0), 400.0));
        page.parent(tree);
        page.finish();
    }
    let path = dir.join("organize-fixture.pdf");
    std::fs::write(&path, pdf.finish()).unwrap();
    path
}

#[test]
fn reorders_extracts_and_inserts() {
    let dir = std::env::temp_dir().join("telos-organize");
    std::fs::create_dir_all(&dir).unwrap();
    let src = fixture(&dir);
    let renderer = Renderer::new().expect("run `cargo xtask fetch-pdfium`");

    // Reorder: [3rd, 1st, 2nd]
    let reordered = dir.join("reordered.pdf");
    renderer
        .restructure_pages(&src, &[2, 0, 1], &reordered)
        .unwrap();
    let sizes = renderer.page_sizes(&reordered).unwrap();
    assert_eq!(sizes.len(), 3);
    assert!((sizes[0].0 - 300.0).abs() < 1.0, "{sizes:?}");
    assert!((sizes[1].0 - 100.0).abs() < 1.0, "{sizes:?}");

    // Extract: pages 1 and 3 only.
    let extracted = dir.join("extracted.pdf");
    renderer
        .restructure_pages(&src, &[0, 2], &extracted)
        .unwrap();
    let sizes = renderer.page_sizes(&extracted).unwrap();
    assert_eq!(sizes.len(), 2);
    assert!((sizes[1].0 - 300.0).abs() < 1.0, "{sizes:?}");

    // Insert blank at index 1, sized like the page at that spot (200pt).
    let inserted = dir.join("inserted.pdf");
    renderer.insert_blank_page(&src, 1, &inserted).unwrap();
    let sizes = renderer.page_sizes(&inserted).unwrap();
    assert_eq!(sizes.len(), 4);
    assert!((sizes[1].0 - 200.0).abs() < 1.0, "{sizes:?}");
}
