//! Compress regressions that need no rendering: what happens to the image
//! objects themselves.

use image::{DynamicImage, Rgb, RgbImage};
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};
use telos_doc::{ImageCompression, ProtectPermissions, compress_to, protect_to};

const BALANCED: ImageCompression = ImageCompression {
    target_dpi: 150,
    jpeg_quality: 72,
};

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("telos-doc-compress");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

/// Photo-like pixels: smooth colour plus enough grain that JPEG works hard.
fn photo(width: u32, height: u32) -> RgbImage {
    let mut seed = 0x2545_F491u32;
    RgbImage::from_fn(width, height, |x, y| {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let grain = (seed >> 27) as i32 - 16;
        let wave = |v: u32, p: f32| ((v as f32 / p).sin() * 90.0 + 128.0) as i32;
        let shade = |v: i32| (v + grain).clamp(0, 255) as u8;
        Rgb([
            shade(wave(x, 37.0)),
            shade(wave(y, 53.0)),
            shade(wave(x + y, 71.0)),
        ])
    })
}

fn jpeg_stream(image: &RgbImage) -> Stream {
    let mut bytes = Vec::new();
    DynamicImage::ImageRgb8(image.clone())
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut bytes, 92,
        ))
        .unwrap();
    Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => image.width() as i64,
            "Height" => image.height() as i64,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
            "Filter" => "DCTDecode",
        },
        bytes,
    )
    .with_compression(false)
}

fn flate_stream(dict: Dictionary, samples: &[u8]) -> Stream {
    let mut stream = Stream::new(dict, samples.to_vec());
    stream.compress().unwrap();
    stream
}

fn draw(name: &str, size_pt: f32) -> Vec<Operation> {
    vec![
        Operation::new("q", vec![]),
        Operation::new(
            "cm",
            vec![
                size_pt.into(),
                0.into(),
                0.into(),
                size_pt.into(),
                0.into(),
                0.into(),
            ],
        ),
        Operation::new("Do", vec![Object::Name(name.as_bytes().to_vec())]),
        Operation::new("Q", vec![]),
    ]
}

/// One page drawing `operations` against `xobjects`.
fn one_page(doc: &mut Document, operations: Vec<Operation>, xobjects: Dictionary) {
    let content = Content { operations }.encode().unwrap();
    let contents = doc.add_object(Stream::new(dictionary! {}, content));
    let pages = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages,
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Contents" => contents,
        "Resources" => dictionary! { "XObject" => xobjects },
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
}

fn save(mut doc: Document, name: &str) -> std::path::PathBuf {
    let path = temp(name);
    doc.save(&path).unwrap();
    path
}

fn images(path: &std::path::Path) -> Vec<(ObjectId, Stream)> {
    let doc = Document::load(path).unwrap();
    doc.objects
        .iter()
        .filter_map(|(id, object)| {
            let stream = object.as_stream().ok()?;
            let is_image = stream.dict.get(b"Subtype").and_then(Object::as_name).ok()?;
            (is_image == b"Image").then(|| (*id, stream.clone()))
        })
        .collect()
}

fn dimension(stream: &Stream, key: &[u8]) -> i64 {
    stream.dict.get(key).unwrap().as_i64().unwrap()
}

#[test]
fn oversized_jpeg_shrinks_instead_of_growing() {
    // The regression: PDFium stored the resampled JPEG as raw pixels, the
    // result outgrew the source, and Compress quietly copied it unchanged.
    let mut doc = Document::with_version("1.7");
    let image = doc.add_object(jpeg_stream(&photo(2000, 2000)));
    one_page(&mut doc, draw("Im0", 400.0), dictionary! { "Im0" => image });
    let src = save(doc, "jpeg-src.pdf");
    let dest = temp("jpeg-out.pdf");

    assert_eq!(compress_to(&src, &dest, Some(BALANCED)).unwrap(), 1);

    let before = std::fs::metadata(&src).unwrap().len();
    let after = std::fs::metadata(&dest).unwrap().len();
    assert!(
        after * 2 < before,
        "expected at least half the size: {before} -> {after}"
    );
    let found = images(&dest);
    let (_, stream) = &found[0];
    // 400pt at 150 DPI is 833px.
    assert_eq!(dimension(stream, b"Width"), 833);
    assert_eq!(dimension(stream, b"Height"), 833);
}

#[test]
fn placement_is_measured_through_nested_forms() {
    let mut doc = Document::with_version("1.7");
    let image = doc.add_object(jpeg_stream(&photo(1600, 1600)));
    let inner = Content {
        operations: draw("Im0", 1.0),
    }
    .encode()
    .unwrap();
    let form = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } },
        },
        inner,
    ));
    one_page(&mut doc, draw("Fm0", 288.0), dictionary! { "Fm0" => form });
    let src = save(doc, "form-src.pdf");
    let dest = temp("form-out.pdf");

    compress_to(&src, &dest, Some(BALANCED)).unwrap();

    // 288pt is 4in, so 600px at 150 DPI.
    assert_eq!(dimension(&images(&dest)[0].1, b"Width"), 600);
}

#[test]
fn shared_image_keeps_detail_for_its_largest_use() {
    let mut doc = Document::with_version("1.7");
    let image = doc.add_object(jpeg_stream(&photo(1600, 1600)));
    let mut operations = draw("Im0", 72.0);
    operations.extend(draw("Im0", 288.0));
    one_page(&mut doc, operations, dictionary! { "Im0" => image });
    let src = save(doc, "shared-src.pdf");
    let dest = temp("shared-out.pdf");

    compress_to(&src, &dest, Some(BALANCED)).unwrap();

    assert_eq!(dimension(&images(&dest)[0].1, b"Width"), 600);
}

#[test]
fn soft_mask_survives_and_stays_lossless() {
    // Grainy, so Flate can't pack it and downsampling is what pays off.
    let alpha: Vec<u8> = photo(1200, 400).into_raw();
    let mut doc = Document::with_version("1.7");
    let mask = doc.add_object(flate_stream(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 1200,
            "Height" => 1200,
            "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 8,
        },
        &alpha,
    ));
    let mut base = jpeg_stream(&photo(1200, 1200));
    base.dict.set("SMask", mask);
    let image = doc.add_object(base);
    one_page(&mut doc, draw("Im0", 144.0), dictionary! { "Im0" => image });
    let src = save(doc, "mask-src.pdf");
    let dest = temp("mask-out.pdf");

    // The mask isn't counted: users think in images, not image parts.
    assert_eq!(compress_to(&src, &dest, Some(BALANCED)).unwrap(), 1);

    let found = images(&dest);
    let (_, base) = found
        .iter()
        .find(|(_, s)| s.dict.has(b"SMask"))
        .expect("the image must keep its soft mask");
    assert_eq!(dimension(base, b"Width"), 300);
    let (_, mask) = found
        .iter()
        .find(|(_, s)| !s.dict.has(b"SMask"))
        .expect("the mask image must survive");
    assert_eq!(dimension(mask, b"Width"), 300);
    assert_eq!(
        mask.dict.get(b"Filter").unwrap().as_name().unwrap(),
        b"FlateDecode"
    );
}

#[test]
fn matted_mask_pair_is_left_exactly_as_it_was() {
    let alpha = vec![128u8; 1000 * 1000];
    let mut doc = Document::with_version("1.7");
    let mask = doc.add_object(flate_stream(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 1000,
            "Height" => 1000,
            "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 8,
            "Matte" => vec![0.into(), 0.into(), 0.into()],
        },
        &alpha,
    ));
    let mut base = jpeg_stream(&photo(1000, 1000));
    base.dict.set("SMask", mask);
    let image = doc.add_object(base);
    one_page(&mut doc, draw("Im0", 72.0), dictionary! { "Im0" => image });
    let src = save(doc, "matte-src.pdf");
    let dest = temp("matte-out.pdf");

    assert_eq!(compress_to(&src, &dest, Some(BALANCED)).unwrap(), 0);

    for (_, stream) in images(&dest) {
        assert_eq!(dimension(&stream, b"Width"), 1000);
    }
}

#[test]
fn images_we_cannot_represent_are_untouched() {
    let cmyk = vec![90u8; 800 * 800 * 4];
    let mut doc = Document::with_version("1.7");
    let image = doc.add_object(flate_stream(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 800,
            "Height" => 800,
            "ColorSpace" => "DeviceCMYK",
            "BitsPerComponent" => 8,
        },
        &cmyk,
    ));
    one_page(&mut doc, draw("Im0", 72.0), dictionary! { "Im0" => image });
    let src = save(doc, "cmyk-src.pdf");
    let dest = temp("cmyk-out.pdf");

    assert_eq!(compress_to(&src, &dest, Some(BALANCED)).unwrap(), 0);
    assert_eq!(dimension(&images(&dest)[0].1, b"Width"), 800);
}

#[test]
fn flat_graphics_stay_flate_rather_than_turning_into_jpeg() {
    let mut pixels = vec![255u8; 1000 * 1000 * 3];
    pixels[..3000].fill(0);
    let mut doc = Document::with_version("1.7");
    let image = doc.add_object(flate_stream(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 1000,
            "Height" => 1000,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
        },
        &pixels,
    ));
    one_page(&mut doc, draw("Im0", 72.0), dictionary! { "Im0" => image });
    let src = save(doc, "flat-src.pdf");
    let dest = temp("flat-out.pdf");

    compress_to(&src, &dest, Some(BALANCED)).unwrap();

    let found = images(&dest);
    assert_eq!(
        found[0].1.dict.get(b"Filter").unwrap().as_name().unwrap(),
        b"FlateDecode"
    );
}

#[test]
fn lossless_pass_leaves_images_alone() {
    let mut doc = Document::with_version("1.7");
    let image = doc.add_object(jpeg_stream(&photo(800, 800)));
    one_page(&mut doc, draw("Im0", 72.0), dictionary! { "Im0" => image });
    let src = save(doc, "lossless-src.pdf");
    let dest = temp("lossless-out.pdf");
    let original = images(&src)[0].1.content.clone();

    assert_eq!(compress_to(&src, &dest, None).unwrap(), 0);

    assert_eq!(images(&dest)[0].1.content, original);
}

#[test]
fn owner_restricted_file_compresses_without_a_password() {
    let mut doc = Document::with_version("1.7");
    let image = doc.add_object(jpeg_stream(&photo(1600, 1600)));
    one_page(&mut doc, draw("Im0", 288.0), dictionary! { "Im0" => image });
    let plain = save(doc, "owner-plain.pdf");
    let src = temp("owner-src.pdf");
    protect_to(
        &plain,
        &src,
        "",
        "owner-secret",
        ProtectPermissions {
            print: true,
            copy: false,
            modify: false,
            annotate: false,
        },
    )
    .unwrap();
    let dest = temp("owner-out.pdf");

    assert_eq!(compress_to(&src, &dest, Some(BALANCED)).unwrap(), 1);

    assert!(!Document::load(&dest).unwrap().is_encrypted());
    assert_eq!(dimension(&images(&dest)[0].1, b"Width"), 600);
}
