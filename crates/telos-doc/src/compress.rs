//! Compress PDF: shrink images to what the page actually shows, then pack
//! the file structure.
//!
//! Images are rewritten here rather than through PDFium: its image setter
//! stores raw pixels, so a downsampled JPEG came back larger than the
//! original, and it rebuilds the image dictionary, which drops soft masks.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use flate2::Compression;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use image::codecs::jpeg::JpegEncoder;
use image::{ColorType, DynamicImage, GrayImage, ImageFormat, RgbImage};
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};

use crate::DocError;

/// Lossy settings for a Compress preset.
#[derive(Debug, Clone, Copy)]
pub struct ImageCompression {
    /// Images denser than this on the page are resampled down to it.
    pub target_dpi: u32,
    /// JPEG quality (1–100) for re-encoded images.
    pub jpeg_quality: u8,
}

/// Images within this factor of the target aren't worth resampling.
const RESAMPLE_HEADROOM: f32 = 1.1;
/// A re-encoded image must save at least this much to replace the original.
const MIN_SAVING_PERCENT: usize = 5;
/// Form XObjects nest; bound the walk against reference cycles.
const MAX_FORM_DEPTH: u32 = 12;
/// Decoded images are large, so cap how many are in memory at once.
const MAX_WORKERS: usize = 4;

/// Write a compressed copy of `src` to `dest`. With `images`, oversized
/// images are downsampled and re-encoded (lossy); without it the result is
/// pixel-identical. Returns how many images were re-encoded.
pub fn compress_to(
    src: impl AsRef<Path>,
    dest: impl AsRef<Path>,
    images: Option<ImageCompression>,
) -> Result<u32, DocError> {
    let mut doc = Document::load(src.as_ref())?;
    if doc.is_encrypted() {
        // Owner-restricted files open without a prompt, but their streams
        // still have to be decrypted before anything here can read them.
        doc =
            Document::load_with_password(src.as_ref(), "").map_err(|_| DocError::WrongPassword)?;
        let _ = doc.trailer.remove(b"Encrypt");
        doc.encryption_state = None;
    }
    let recompressed = images.map_or(0, |preset| recompress_images(&mut doc, preset));
    redeflate_streams(&mut doc);
    doc.compress();
    doc.prune_objects();
    let mut file = std::fs::File::create(dest.as_ref())?;
    doc.save_modern(&mut file)?;
    Ok(recompressed)
}

/// The largest size an image is drawn at, in points.
#[derive(Debug, Clone, Copy, Default)]
struct Placement {
    width: f32,
    height: f32,
}

impl Placement {
    /// Drawn somewhere we couldn't measure: never resample it.
    const UNMEASURED: Self = Self {
        width: f32::INFINITY,
        height: f32::INFINITY,
    };

    fn grow(&mut self, other: Placement) {
        self.width = self.width.max(other.width);
        self.height = self.height.max(other.height);
    }
}

/// The scale/skew part of a transform (translation can't change a size).
type Matrix = [f32; 4];

/// `first` applied, then `then`.
fn concat(first: Matrix, then: Matrix) -> Matrix {
    [
        first[0] * then[0] + first[1] * then[2],
        first[0] * then[1] + first[1] * then[3],
        first[2] * then[0] + first[3] * then[2],
        first[2] * then[1] + first[3] * then[3],
    ]
}

fn matrix_from(numbers: &[Object]) -> Option<Matrix> {
    let mut m = [0.0; 4];
    for (slot, number) in m.iter_mut().zip(numbers) {
        *slot = number.as_float().ok()?;
    }
    (numbers.len() >= 4).then_some(m)
}

fn add_xobjects(doc: &Document, resources: &Dictionary, names: &mut HashMap<Vec<u8>, ObjectId>) {
    let Ok(object) = resources.get(b"XObject") else {
        return;
    };
    let Ok((_, Object::Dictionary(xobjects))) = doc.dereference(object) else {
        return;
    };
    for (name, value) in xobjects.iter() {
        if let Object::Reference(id) = value {
            names.entry(name.clone()).or_insert(*id);
        }
    }
}

fn page_xobjects(doc: &Document, page_id: ObjectId) -> HashMap<Vec<u8>, ObjectId> {
    let mut names = HashMap::new();
    let Ok((direct, inherited)) = doc.get_page_resources(page_id) else {
        return names;
    };
    if let Some(resources) = direct {
        add_xobjects(doc, resources, &mut names);
    }
    for id in inherited {
        if let Ok(resources) = doc.get_dictionary(id) {
            add_xobjects(doc, resources, &mut names);
        }
    }
    names
}

fn mark_unmeasured(
    names: &HashMap<Vec<u8>, ObjectId>,
    placements: &mut HashMap<ObjectId, Placement>,
) {
    for id in names.values() {
        placements.insert(*id, Placement::UNMEASURED);
    }
}

/// Follow the graphics state through a content stream, recording how large
/// each image is drawn.
fn walk_content(
    doc: &Document,
    operations: &[Operation],
    names: &HashMap<Vec<u8>, ObjectId>,
    base: Matrix,
    placements: &mut HashMap<ObjectId, Placement>,
    depth: u32,
) {
    let mut ctm = base;
    let mut saved = Vec::new();
    for op in operations {
        match op.operator.as_str() {
            "q" => saved.push(ctm),
            "Q" => ctm = saved.pop().unwrap_or(ctm),
            "cm" => {
                if let Some(m) = matrix_from(&op.operands) {
                    ctm = concat(m, ctm);
                }
            }
            "Do" => {
                let Some(id) = op
                    .operands
                    .first()
                    .and_then(|name| name.as_name().ok())
                    .and_then(|name| names.get(name))
                else {
                    continue;
                };
                let Ok(xobject) = doc.get_object(*id).and_then(Object::as_stream) else {
                    continue;
                };
                match xobject.dict.get(b"Subtype").and_then(Object::as_name) {
                    Ok(b"Image") => placements.entry(*id).or_default().grow(Placement {
                        width: ctm[0].hypot(ctm[1]),
                        height: ctm[2].hypot(ctm[3]),
                    }),
                    Ok(b"Form") => walk_form(doc, xobject, names, ctm, placements, depth + 1),
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

fn walk_form(
    doc: &Document,
    form: &Stream,
    parent_names: &HashMap<Vec<u8>, ObjectId>,
    ctm: Matrix,
    placements: &mut HashMap<ObjectId, Placement>,
    depth: u32,
) {
    // A form without its own /Resources uses its parent's.
    let mut names = HashMap::new();
    match form.dict.get(b"Resources").map(|r| doc.dereference(r)) {
        Ok(Ok((_, Object::Dictionary(resources)))) => add_xobjects(doc, resources, &mut names),
        _ => names.clone_from(parent_names),
    }
    if depth > MAX_FORM_DEPTH {
        mark_unmeasured(&names, placements);
        return;
    }
    let ctm = form
        .dict
        .get(b"Matrix")
        .and_then(Object::as_array)
        .ok()
        .and_then(|m| matrix_from(m))
        .map_or(ctm, |m| concat(m, ctm));
    match form
        .decompressed_content()
        .and_then(|content| Content::decode(&content))
    {
        Ok(content) => walk_content(doc, &content.operations, &names, ctm, placements, depth),
        Err(_) => mark_unmeasured(&names, placements),
    }
}

fn image_placements(doc: &Document) -> HashMap<ObjectId, Placement> {
    let mut placements = HashMap::new();
    for page_id in doc.get_pages().into_values() {
        let names = page_xobjects(doc, page_id);
        match doc.get_and_decode_page_content(page_id) {
            Ok(content) => walk_content(
                doc,
                &content.operations,
                &names,
                [1.0, 0.0, 0.0, 1.0],
                &mut placements,
                0,
            ),
            // Anything this page draws might be drawn large.
            Err(_) => mark_unmeasured(&names, &mut placements),
        }
    }
    placements
}

/// Samples per pixel for the colour spaces whose samples we can carry over
/// unchanged. Anything else (CMYK, Indexed, Separation…) is left alone.
fn components(doc: &Document, dict: &Dictionary) -> Option<usize> {
    let space = dict.get(b"ColorSpace").ok()?;
    let (_, space) = doc.dereference(space).ok()?;
    match space {
        Object::Name(name) => match name.as_slice() {
            b"DeviceGray" | b"CalGray" => Some(1),
            b"DeviceRGB" | b"CalRGB" => Some(3),
            _ => None,
        },
        Object::Array(items) => match items.first()?.as_name().ok()? {
            b"CalGray" => Some(1),
            b"CalRGB" => Some(3),
            b"ICCBased" => {
                let (_, profile) = doc.dereference(items.get(1)?).ok()?;
                let n = profile
                    .as_stream()
                    .ok()?
                    .dict
                    .get(b"N")
                    .ok()?
                    .as_i64()
                    .ok()?;
                matches!(n, 1 | 3).then_some(n as usize)
            }
            _ => None,
        },
        _ => None,
    }
}

/// Decode an image to pixels, or `None` if it isn't safe to rewrite.
fn decode_pixels(doc: &Document, stream: &Stream) -> Option<DynamicImage> {
    let dict = &stream.dict;
    // /Decode remaps samples and a colour-key /Mask matches exact values —
    // neither survives resampling.
    let keyed = matches!(dict.get(b"Mask"), Ok(Object::Array(_)));
    if keyed || dict.has(b"Decode") {
        return None;
    }
    let width = u32::try_from(dict.get(b"Width").ok()?.as_i64().ok()?).ok()?;
    let height = u32::try_from(dict.get(b"Height").ok()?.as_i64().ok()?).ok()?;
    let samples = components(doc, dict)?;
    let filters = stream.filters().unwrap_or_default();

    if filters.as_slice() == [b"DCTDecode".as_slice()] {
        if dict.has(b"DecodeParms") {
            return None;
        }
        let decoded =
            image::load_from_memory_with_format(&stream.content, ImageFormat::Jpeg).ok()?;
        let matches_space = matches!(
            (samples, decoded.color()),
            (1, ColorType::L8) | (3, ColorType::Rgb8)
        );
        return matches_space.then_some(decoded);
    }

    if dict.get(b"BitsPerComponent").ok()?.as_i64().ok()? != 8 {
        return None;
    }
    // lopdf applies /DecodeParms only as a direct dictionary, and only PNG
    // predictors; anything else would come back as garbage pixels.
    if let Ok(params) = dict.get(b"DecodeParms") {
        let predictor = params.as_dict().ok()?.get(b"Predictor");
        let predictor = predictor.map_or(Some(1), |p| p.as_i64().ok())?;
        if predictor != 1 && !(10..=15).contains(&predictor) {
            return None;
        }
    }
    // Errors here also cover JPX, JBIG2 and CCITT, which stay as they are.
    let mut raw = stream.decompressed_content().ok()?;
    let expected = width as usize * height as usize * samples;
    if raw.len() < expected || raw.len() > expected + 2 {
        return None;
    }
    raw.truncate(expected);
    match samples {
        1 => GrayImage::from_raw(width, height, raw).map(DynamicImage::ImageLuma8),
        _ => RgbImage::from_raw(width, height, raw).map(DynamicImage::ImageRgb8),
    }
}

/// Pixel size that brings an image down to `target_dpi` where it's drawn.
fn target_size(width: u32, height: u32, placement: Placement, target_dpi: u32) -> (u32, u32) {
    let fit = |pixels: u32, points: f32| {
        // Degenerate placements give no usable density.
        if points < 1.0 || !points.is_finite() {
            return pixels;
        }
        let density = pixels as f32 / (points / 72.0);
        if density <= target_dpi as f32 * RESAMPLE_HEADROOM {
            return pixels;
        }
        ((pixels as f32 * target_dpi as f32 / density).round() as u32).max(1)
    };
    (fit(width, placement.width), fit(height, placement.height))
}

fn deflate(data: &[u8], level: Compression) -> Option<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), level);
    encoder.write_all(data).ok()?;
    encoder.finish().ok()
}

fn jpeg(image: &DynamicImage, quality: u8) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    image
        .write_with_encoder(JpegEncoder::new_with_quality(&mut out, quality))
        .ok()?;
    Some(out)
}

/// One image to rewrite.
struct ImageJob {
    id: ObjectId,
    placement: Placement,
    /// Soft masks stay lossless: JPEG ringing shows up as halos on edges.
    is_mask: bool,
}

fn reencode(doc: &Document, job: &ImageJob, preset: ImageCompression) -> Option<Stream> {
    let stream = doc.get_object(job.id).and_then(Object::as_stream).ok()?;
    let decoded = decode_pixels(doc, stream)?;
    let (width, height) = (decoded.width(), decoded.height());
    let (new_width, new_height) = target_size(width, height, job.placement, preset.target_dpi);
    let resized = if (new_width, new_height) == (width, height) {
        decoded
    } else {
        decoded.thumbnail_exact(new_width, new_height)
    };

    let flate: &[u8] = b"FlateDecode";
    let dct: &[u8] = b"DCTDecode";
    let (content, filter) = if job.is_mask {
        (deflate(resized.as_bytes(), Compression::default())?, flate)
    } else {
        let lossy = jpeg(&resized, preset.jpeg_quality)?;
        let source_is_jpeg = stream.filters().is_ok_and(|f| f.contains(&dct));
        // Flat-colour graphics beat JPEG with Flate, and stay sharp.
        match (!source_is_jpeg)
            .then(|| deflate(resized.as_bytes(), Compression::default()))
            .flatten()
        {
            Some(lossless) if lossless.len() <= lossy.len() => (lossless, flate),
            _ => (lossy, dct),
        }
    };
    if content.len() * 100 >= stream.content.len() * (100 - MIN_SAVING_PERCENT) {
        return None;
    }

    let mut dict = stream.dict.clone();
    dict.set("Width", i64::from(new_width));
    dict.set("Height", i64::from(new_height));
    dict.set("BitsPerComponent", 8);
    dict.set("Filter", Object::Name(filter.to_vec()));
    dict.remove(b"DecodeParms");
    Some(Stream::new(dict, content).with_compression(false))
}

/// Run `f` over `items` on a few threads, keeping the `Some` results.
fn parallel_filter_map<T: Sync, R: Send>(
    items: &[T],
    f: impl Fn(&T) -> Option<R> + Sync,
) -> Vec<R> {
    let workers = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .min(MAX_WORKERS)
        .min(items.len());
    let next = AtomicUsize::new(0);
    let results = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                while let Some(item) = items.get(next.fetch_add(1, Ordering::Relaxed)) {
                    if let Some(result) = f(item) {
                        results
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .push(result);
                    }
                }
            });
        }
    });
    results.into_inner().unwrap_or_else(|e| e.into_inner())
}

fn recompress_images(doc: &mut Document, preset: ImageCompression) -> u32 {
    let mut placements = image_placements(doc);

    // Soft masks are sized by the images they mask. A /Matte mask is
    // pre-blended into its image, so the pair has to stay exactly as it is.
    let mut masks = HashSet::new();
    let mut matted = HashSet::new();
    for (id, placement) in placements.clone() {
        let Ok(image) = doc.get_object(id).and_then(Object::as_stream) else {
            continue;
        };
        let Ok(mask_id) = image.dict.get(b"SMask").and_then(Object::as_reference) else {
            continue;
        };
        let Ok(mask) = doc.get_object(mask_id).and_then(Object::as_stream) else {
            continue;
        };
        if mask.dict.has(b"Matte") {
            matted.insert(id);
            matted.insert(mask_id);
        } else {
            masks.insert(mask_id);
            placements.entry(mask_id).or_default().grow(placement);
        }
    }

    let jobs: Vec<ImageJob> = placements
        .into_iter()
        .filter(|(id, _)| !matted.contains(id))
        .map(|(id, placement)| ImageJob {
            id,
            placement,
            is_mask: masks.contains(&id),
        })
        .collect();
    let shared: &Document = doc;
    let rewritten = parallel_filter_map(&jobs, |job| {
        reencode(shared, job, preset).map(|stream| (job.id, job.is_mask, stream))
    });

    let mut count = 0;
    for (id, is_mask, stream) in rewritten {
        doc.objects.insert(id, Object::Stream(stream));
        count += u32::from(!is_mask);
    }
    count
}

/// Re-pack Flate streams at the highest level — many PDF writers favour
/// speed. Inflates with flate2 directly so a corrupt stream is skipped
/// rather than rewritten from a partial read.
fn redeflate_streams(doc: &mut Document) {
    let flate: &[u8] = b"FlateDecode";
    let ids: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter_map(|(id, object)| {
            let stream = object.as_stream().ok()?;
            let only_flate = stream.filters().is_ok_and(|f| f.as_slice() == [flate]);
            (only_flate && !stream.dict.has(b"DecodeParms")).then_some(*id)
        })
        .collect();
    let shared: &Document = doc;
    let smaller = parallel_filter_map(&ids, |id| {
        let stream = shared.get_object(*id).and_then(Object::as_stream).ok()?;
        let mut plain = Vec::new();
        ZlibDecoder::new(stream.content.as_slice())
            .read_to_end(&mut plain)
            .ok()?;
        let packed = deflate(&plain, Compression::best())?;
        (packed.len() < stream.content.len()).then_some((*id, packed))
    });
    for (id, packed) in smaller {
        if let Ok(stream) = doc.get_object_mut(id).and_then(Object::as_stream_mut) {
            stream.set_content(packed);
        }
    }
}
