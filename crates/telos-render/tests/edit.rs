//! Edit-PDF pipeline test: enumerate page objects, add text, edit it,
//! delete objects — through the same PDFium ops the app uses.
//! Requires `cargo xtask fetch-pdfium`.

use pdf_writer::{Content, Finish, Pdf, Rect, Ref};
use telos_render::Renderer;

fn fixture_pdf() -> Vec<u8> {
    let catalog_id = Ref::new(1);
    let page_tree_id = Ref::new(2);
    let page_id = Ref::new(3);
    let content_id = Ref::new(4);

    let mut content = Content::new();
    content
        .set_fill_rgb(0.0, 0.3, 1.0)
        .rect(100.0, 100.0, 150.0, 80.0)
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
fn edit_pipeline_add_edit_delete() {
    let dir = std::env::temp_dir().join("telos-render-edit");
    std::fs::create_dir_all(&dir).unwrap();
    let v0 = dir.join("v0.pdf");
    std::fs::write(&v0, fixture_pdf()).unwrap();

    let renderer = Renderer::new().expect("run `cargo xtask fetch-pdfium` first");

    // Fixture has exactly one path object.
    let objects = renderer.page_objects(&v0, 0).unwrap();
    assert_eq!(objects.len(), 1, "{objects:?}");
    assert_eq!(objects[0].kind, "path");

    // Add a text object.
    let v1 = dir.join("v1.pdf");
    renderer
        .add_text_object(&v0, 0, 72.0, 700.0, "Hello TelosPDF", 14.0, &v1)
        .unwrap();
    let objects = renderer.page_objects(&v1, 0).unwrap();
    let text: Vec<_> = objects.iter().filter(|o| o.kind == "text").collect();
    assert_eq!(text.len(), 1, "{objects:?}");
    assert_eq!(text[0].text.as_deref(), Some("Hello TelosPDF"));

    // Edit the text in place.
    let v2 = dir.join("v2.pdf");
    renderer
        .edit_text_object(&v1, 0, text[0].index, "Edited!", &v2)
        .unwrap();
    let objects = renderer.page_objects(&v2, 0).unwrap();
    let edited: Vec<_> = objects.iter().filter(|o| o.kind == "text").collect();
    assert_eq!(edited[0].text.as_deref(), Some("Edited!"));

    // Delete the original path object; only the text should remain.
    let path_index = objects.iter().find(|o| o.kind == "path").unwrap().index;
    let v3 = dir.join("v3.pdf");
    renderer
        .delete_page_object(&v2, 0, path_index, &v3)
        .unwrap();
    let objects = renderer.page_objects(&v3, 0).unwrap();
    assert_eq!(objects.len(), 1, "{objects:?}");
    assert_eq!(objects[0].kind, "text");

    // The final document still renders.
    let png = renderer.render_page_png(&v3, 0, 400, 0).unwrap();
    assert!(png.len() > 100);
}
