//! Redaction removes underlying text: after redacting the region over some
//! text, the page's extractable text no longer contains it. Requires
//! `cargo xtask fetch-pdfium`.

use pdf_writer::{Content, Finish, Name, Pdf, Rect, Ref, Str};
use telos_render::Renderer;

fn text_fixture(dir: &std::path::Path) -> std::path::PathBuf {
    let catalog = Ref::new(1);
    let tree = Ref::new(2);
    let page = Ref::new(3);
    let content = Ref::new(4);
    let font = Ref::new(5);

    let mut c = Content::new();
    c.begin_text()
        .set_font(Name(b"F0"), 24.0)
        .next_line(72.0, 700.0)
        .show(Str(b"SECRETWORD"))
        .end_text();
    let data = c.finish();

    let mut pdf = Pdf::new();
    pdf.catalog(catalog).pages(tree);
    pdf.pages(tree).kids([page]).count(1);
    {
        let mut p = pdf.page(page);
        p.media_box(Rect::new(0.0, 0.0, 595.0, 842.0));
        p.parent(tree);
        p.contents(content);
        p.resources().fonts().pair(Name(b"F0"), font);
        p.finish();
    }
    pdf.type1_font(font).base_font(Name(b"Helvetica"));
    pdf.stream(content, &data);
    let path = dir.join("redact-fixture.pdf");
    std::fs::write(&path, pdf.finish()).unwrap();
    path
}

#[test]
fn redaction_removes_underlying_text() {
    let dir = std::env::temp_dir().join("telos-redact");
    std::fs::create_dir_all(&dir).unwrap();
    let src = text_fixture(&dir);
    let renderer = Renderer::new().expect("run `cargo xtask fetch-pdfium`");

    assert!(renderer.extract_text(&src).unwrap().contains("SECRETWORD"));

    // Cover the text region (~72..260 x, ~695..725 y in points).
    let out = dir.join("redacted.pdf");
    renderer
        .redact_pages(&src, &[(0, 60.0, 690.0, 220.0, 40.0)], &out)
        .unwrap();

    let after = renderer.extract_text(&out).unwrap();
    assert!(
        !after.contains("SECRETWORD"),
        "redacted text still extractable: {after:?}"
    );
    assert_eq!(renderer.page_count(&out).unwrap(), 1);
}
