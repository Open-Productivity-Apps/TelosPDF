//! Compress regression: the compressed copy must look like the original.
//! Requires `cargo xtask fetch-pdfium`.

use std::sync::OnceLock;

use image::{DynamicImage, Rgb, RgbImage};
use lopdf::{Document, Object, Stream, dictionary};
use telos_doc::{ImageCompression, compress_to};
use telos_render::Renderer;

/// PDFium binds once per process, so tests in this binary share it.
fn renderer() -> &'static Renderer {
    static RENDERER: OnceLock<Renderer> = OnceLock::new();
    RENDERER.get_or_init(|| Renderer::new().expect("run `cargo xtask fetch-pdfium`"))
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("telos-compress");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

fn gradient(size: u32) -> RgbImage {
    RgbImage::from_fn(size, size, |x, y| {
        let shade = |v: u32| (v * 255 / size) as u8;
        Rgb([shade(x), shade(y), shade((x + y) / 2)])
    })
}

fn pixels(path: &std::path::Path) -> RgbImage {
    let png = renderer().render_page_png(path, 0, 300, 0).unwrap();
    image::load_from_memory(&png).unwrap().to_rgb8()
}

fn mean_difference(a: &RgbImage, b: &RgbImage) -> f64 {
    assert_eq!(a.dimensions(), b.dimensions());
    let total: u64 = a
        .as_raw()
        .iter()
        .zip(b.as_raw())
        .map(|(x, y)| u64::from(x.abs_diff(*y)))
        .sum();
    total as f64 / a.as_raw().len() as f64
}

#[test]
fn compressed_copy_is_smaller_and_looks_the_same() {
    let image_path = temp("big.png");
    DynamicImage::ImageRgb8(gradient(1600))
        .save(&image_path)
        .unwrap();
    let src = temp("fixture.pdf");
    telos_doc::create_from_images(&[image_path], &src).unwrap();
    let dest = temp("compressed.pdf");

    // create_from_images displays at 96 DPI, so use a budget below that.
    let preset = ImageCompression {
        target_dpi: 50,
        jpeg_quality: 70,
    };
    assert_eq!(compress_to(&src, &dest, Some(preset)).unwrap(), 1);

    assert!(std::fs::metadata(&dest).unwrap().len() < std::fs::metadata(&src).unwrap().len());
    assert_eq!(renderer().page_count(&dest).unwrap(), 1);
    let difference = mean_difference(&pixels(&src), &pixels(&dest));
    assert!(difference < 3.0, "mean pixel difference {difference}");
}

#[test]
fn transparency_still_shows_the_page_behind_an_image() {
    // PDFium's image setter dropped /SMask, turning transparent areas into
    // an opaque box. Red page, black image, right half masked out.
    let size = 1200usize;
    let mut alpha = vec![255u8; size * size];
    for row in alpha.chunks_mut(size) {
        row[size / 2..].fill(0);
    }
    let mut mask = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => size as i64,
            "Height" => size as i64,
            "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 8,
        },
        alpha,
    );
    mask.compress().unwrap();

    let mut doc = Document::with_version("1.7");
    let mask = doc.add_object(mask);
    let mut black = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => size as i64,
            "Height" => size as i64,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
            "SMask" => mask,
        },
        vec![0u8; size * size * 3],
    );
    black.compress().unwrap();
    let image = doc.add_object(black);
    let contents = doc.add_object(Stream::new(
        dictionary! {},
        b"1 0 0 rg 0 0 200 200 re f q 200 0 0 200 0 0 cm /Im0 Do Q".to_vec(),
    ));
    let pages = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
        "Contents" => contents,
        "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } },
    });
    doc.objects.insert(
        pages,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page.into()],
            "Count" => 1,
        }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    doc.trailer.set("Root", catalog);
    let src = temp("mask.pdf");
    doc.save(&src).unwrap();
    let dest = temp("mask-compressed.pdf");

    let preset = ImageCompression {
        target_dpi: 100,
        jpeg_quality: 70,
    };
    compress_to(&src, &dest, Some(preset)).unwrap();

    let after = pixels(&dest);
    let (width, height) = after.dimensions();
    let left = after.get_pixel(width / 4, height / 2);
    let right = after.get_pixel(width * 3 / 4, height / 2);
    assert!(left[0] < 40, "masked-in half stays black: {left:?}");
    assert!(
        right[0] > 200 && right[1] < 40,
        "masked-out half shows the page: {right:?}"
    );
}
