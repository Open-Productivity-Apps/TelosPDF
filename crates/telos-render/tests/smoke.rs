//! M0 smoke test: generate a PDF with pdf-writer, render page 1 with PDFium,
//! and verify the pixels. Requires the PDFium library — run
//! `cargo xtask fetch-pdfium` once before `cargo test`.

use image::GenericImageView;
use pdf_writer::{Content, Finish, Pdf, Rect, Ref};
use telos_render::Renderer;

/// A4 page with a filled red rectangle in the lower-left quadrant.
fn fixture_pdf() -> Vec<u8> {
    let catalog_id = Ref::new(1);
    let page_tree_id = Ref::new(2);
    let page_id = Ref::new(3);
    let content_id = Ref::new(4);

    let mut content = Content::new();
    content
        .set_fill_rgb(1.0, 0.0, 0.0)
        .rect(50.0, 50.0, 200.0, 200.0)
        .fill_nonzero();
    let content_data = content.finish();

    let mut pdf = Pdf::new();
    pdf.catalog(catalog_id).pages(page_tree_id);
    pdf.pages(page_tree_id).kids([page_id]).count(1);
    {
        let mut page = pdf.page(page_id);
        page.media_box(Rect::new(0.0, 0.0, 595.0, 842.0));
        page.parent(page_tree_id);
        page.contents(content_id);
        page.finish();
    }
    pdf.stream(content_id, &content_data);
    pdf.finish()
}

#[test]
fn renders_generated_pdf_page_to_png() {
    let dir = std::env::temp_dir().join("telos-render-smoke");
    std::fs::create_dir_all(&dir).unwrap();
    let pdf_path = dir.join("fixture.pdf");
    std::fs::write(&pdf_path, fixture_pdf()).unwrap();

    let renderer = Renderer::new()
        .expect("PDFium not found — run `cargo xtask fetch-pdfium` before `cargo test`");

    assert_eq!(renderer.page_count(&pdf_path).unwrap(), 1);

    let sizes = renderer.page_sizes(&pdf_path).unwrap();
    assert_eq!(sizes.len(), 1);
    assert!((sizes[0].0 - 595.0).abs() < 1.0, "width {}", sizes[0].0);
    assert!((sizes[0].1 - 842.0).abs() < 1.0, "height {}", sizes[0].1);

    let png = renderer.render_page_png(&pdf_path, 0, 595, 0).unwrap();
    let img = image::load_from_memory(&png).expect("output is a decodable PNG");
    assert_eq!(img.width(), 595);

    // PDF y-axis is bottom-up, images are top-down: the rectangle at
    // (50..250, 50..250) in PDF space lands near the image bottom.
    let inside = img.get_pixel(150, img.height() - 150);
    let outside = img.get_pixel(450, 100);
    assert!(
        inside[0] > 200 && inside[1] < 60 && inside[2] < 60,
        "expected red inside the rectangle, got {inside:?}"
    );
    assert!(
        outside[0] > 200 && outside[1] > 200 && outside[2] > 200,
        "expected white page background, got {outside:?}"
    );
}
