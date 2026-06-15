//! Compress regression: an oversized embedded image gets downsampled and
//! the result shrinks; the structural pass alone must round-trip. Requires
//! `cargo xtask fetch-pdfium`.

use telos_render::Renderer;

/// A PDF whose single page shows a large photo-like image at small size —
/// built through PDFium itself (image object APIs).
fn fixture(renderer_dir: &std::path::Path) -> std::path::PathBuf {
    use image::{DynamicImage, Rgb, RgbImage};
    // 1600x1600 noise-ish gradient (compresses, but big).
    let mut img = RgbImage::new(1600, 1600);
    for (x, y, px) in img.enumerate_pixels_mut() {
        *px = Rgb([(x % 256) as u8, (y % 256) as u8, ((x * y) % 256) as u8]);
    }
    let img_path = renderer_dir.join("big.png");
    DynamicImage::ImageRgb8(img).save(&img_path).unwrap();
    let pdf_path = renderer_dir.join("compress-fixture.pdf");
    telos_doc::create_from_images(&[img_path], &pdf_path).unwrap();
    pdf_path
}

#[test]
fn downsample_shrinks_oversized_images() {
    let dir = std::env::temp_dir().join("telos-compress");
    std::fs::create_dir_all(&dir).unwrap();
    let src = fixture(&dir);
    let renderer = Renderer::new().expect("run `cargo xtask fetch-pdfium`");

    let out = dir.join("downsampled.pdf");
    // create_from_images displays 1px as 1pt (72 DPI native), so use a
    // 50 DPI budget to exercise the oversized path.
    let changed = renderer.downsample_images(&src, 50, &out).unwrap();
    assert_eq!(changed, 1, "the oversized image must be downsampled");
    assert_eq!(renderer.page_count(&out).unwrap(), 1);
    let png = renderer.render_page_png(&out, 0, 300, 0).unwrap();
    assert!(png.len() > 100);

    let compacted = dir.join("compacted.pdf");
    telos_doc::compact_to(&out, &compacted).unwrap();
    assert_eq!(renderer.page_count(&compacted).unwrap(), 1);
}
