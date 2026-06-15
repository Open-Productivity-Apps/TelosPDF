//! Corpus runner (PLAN.md §8): every file must open, report sane geometry,
//! and render — the regression net that grows toward ~5k real-world nasties.
//!
//! M0 scope: synthetic fixtures generated with pdf-writer (no binaries in
//! git) plus a manifest of remote files fetched into `.corpus/` by CI
//! (`corpus/manifest.txt`, one `<url> <min_pages>` per line, `#` comments).
//! Requires the PDFium prebuilt: run `cargo xtask fetch-pdfium` first.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use pdf_writer::{Content, Finish, Pdf, Rect, Ref};

struct Case {
    name: String,
    path: PathBuf,
    min_pages: u32,
}

pub fn run(workspace_root: &Path) -> Result<()> {
    let corpus_dir = workspace_root.join(".corpus");
    std::fs::create_dir_all(&corpus_dir)?;

    let mut cases = synthetic_fixtures(&corpus_dir)?;
    cases.extend(remote_fixtures(workspace_root, &corpus_dir)?);

    let renderer = telos_render::Renderer::new()
        .context("PDFium not found — run `cargo xtask fetch-pdfium` first")?;

    let mut failures = 0usize;
    for case in &cases {
        match check(&renderer, case) {
            Ok(()) => println!("PASS  {}", case.name),
            Err(e) => {
                failures += 1;
                println!("FAIL  {} — {e:#}", case.name);
            }
        }
    }

    println!(
        "\ncorpus: {} passed, {} failed",
        cases.len() - failures,
        failures
    );
    if failures > 0 {
        bail!("{failures} corpus case(s) failed");
    }
    Ok(())
}

fn check(renderer: &telos_render::Renderer, case: &Case) -> Result<()> {
    let pages = renderer.page_count(&case.path)?;
    if pages < case.min_pages {
        bail!("expected at least {} pages, got {pages}", case.min_pages);
    }
    let sizes = renderer.page_sizes(&case.path)?;
    if sizes.len() != pages as usize {
        bail!(
            "page_sizes returned {} entries for {pages} pages",
            sizes.len()
        );
    }
    for (i, (w, h)) in sizes.iter().enumerate() {
        if !(*w > 1.0 && *h > 1.0 && w.is_finite() && h.is_finite()) {
            bail!("page {i} has degenerate size {w}x{h}");
        }
    }
    // First and last page must render to decodable, non-trivial PNGs.
    for page in [0, pages - 1] {
        let png = renderer.render_page_png(&case.path, page, 400, 0)?;
        if png.len() < 100 {
            bail!(
                "page {page} rendered to a suspiciously small PNG ({} bytes)",
                png.len()
            );
        }
    }
    Ok(())
}

/// Deterministic fixtures covering structural variety (regenerated each run).
fn synthetic_fixtures(dir: &Path) -> Result<Vec<Case>> {
    let mut cases = Vec::new();

    // 1. Minimal single blank A4 page.
    cases.push(write_case(
        dir,
        "synthetic-blank",
        1,
        |pdf, page_ids, content_ids| {
            blank_pages(pdf, page_ids, content_ids, &[(595.0, 842.0)]);
        },
    )?);

    // 2. Fifty pages with drawn content (exercises lazy paging).
    let sizes: Vec<(f32, f32)> = (0..50).map(|_| (595.0, 842.0)).collect();
    cases.push(write_case(
        dir,
        "synthetic-50pages",
        50,
        move |pdf, page_ids, content_ids| {
            blank_pages(pdf, page_ids, content_ids, &sizes);
        },
    )?);

    // 3. Mixed page sizes and orientations (letter, A5 landscape, square).
    let mixed: Vec<(f32, f32)> = vec![(612.0, 792.0), (595.0, 420.0), (500.0, 500.0)];
    cases.push(write_case(
        dir,
        "synthetic-mixed-sizes",
        3,
        move |pdf, page_ids, content_ids| {
            blank_pages(pdf, page_ids, content_ids, &mixed);
        },
    )?);

    Ok(cases)
}

fn write_case(
    dir: &Path,
    name: &str,
    min_pages: u32,
    build: impl FnOnce(&mut Pdf, &[Ref], &[Ref]),
) -> Result<Case> {
    let page_count = min_pages as usize;
    let catalog_id = Ref::new(1);
    let tree_id = Ref::new(2);
    let page_ids: Vec<Ref> = (0..page_count).map(|i| Ref::new(3 + i as i32)).collect();
    let content_ids: Vec<Ref> = (0..page_count)
        .map(|i| Ref::new(3 + (page_count + i) as i32))
        .collect();

    let mut pdf = Pdf::new();
    pdf.catalog(catalog_id).pages(tree_id);
    pdf.pages(tree_id)
        .kids(page_ids.iter().copied())
        .count(page_count as i32);
    build(&mut pdf, &page_ids, &content_ids);

    let path = dir.join(format!("{name}.pdf"));
    std::fs::write(&path, pdf.finish())?;
    Ok(Case {
        name: name.into(),
        path,
        min_pages,
    })
}

/// Pages with a visible rectangle so renders are non-blank; the page tree
/// parent/content wiring is the part under test.
fn blank_pages(pdf: &mut Pdf, page_ids: &[Ref], content_ids: &[Ref], sizes: &[(f32, f32)]) {
    for (i, (&page_id, &content_id)) in page_ids.iter().zip(content_ids).enumerate() {
        let (w, h) = sizes[i.min(sizes.len() - 1)];
        let mut page = pdf.page(page_id);
        page.media_box(Rect::new(0.0, 0.0, w, h));
        page.parent(Ref::new(2));
        page.contents(content_id);
        page.finish();

        let mut content = Content::new();
        content
            .set_fill_rgb(0.2, 0.4, (i as f32 * 0.13) % 1.0)
            .rect(w * 0.1, h * 0.1, w * 0.3, h * 0.2)
            .fill_nonzero();
        pdf.stream(content_id, &content.finish());
    }
}

/// `corpus/manifest.txt` lines: `<url> <min_pages>`; downloads cached in
/// `.corpus/remote/` keyed by file name.
fn remote_fixtures(workspace_root: &Path, corpus_dir: &Path) -> Result<Vec<Case>> {
    let manifest = workspace_root.join("corpus").join("manifest.txt");
    let Ok(text) = std::fs::read_to_string(&manifest) else {
        return Ok(Vec::new());
    };
    let remote_dir = corpus_dir.join("remote");
    std::fs::create_dir_all(&remote_dir)?;

    let mut cases = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(url), Some(min_pages)) = (parts.next(), parts.next()) else {
            bail!("bad manifest line: {line}");
        };
        let min_pages: u32 = min_pages.parse().context("min_pages must be a number")?;
        let file_name = url.rsplit('/').next().unwrap_or("download.pdf");
        let path = remote_dir.join(file_name);
        if !path.exists() {
            println!("fetching {url}");
            let status = Command::new("curl")
                .args([
                    "--fail",
                    "--location",
                    "--silent",
                    "--show-error",
                    "--output",
                ])
                .arg(&path)
                .arg(url)
                .status()
                .context("running curl")?;
            if !status.success() {
                bail!("download failed: {url}");
            }
        }
        cases.push(Case {
            name: format!("remote-{file_name}"),
            path,
            min_pages,
        });
    }
    Ok(cases)
}
