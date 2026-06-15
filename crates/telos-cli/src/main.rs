//! `telos` — headless TelosPDF.
//!
//! M0 scope: `info` and `render` prove the core is embeddable without the
//! shell. Once the command registry exists (M1), this binary becomes a thin
//! dispatcher over the same commands the UI runs, which is what makes
//! Guided Actions and CI scripting nearly free (PLAN.md §5 #24).

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use telos_core::{Renderer, TelosDocument};

const USAGE: &str = "\
telos — headless TelosPDF

USAGE:
  telos info <file.pdf>                     Print document metadata
  telos render <file.pdf> <page> <out.png>  Render a page (1-based) to PNG
";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("info") => {
            let [_, path] = args.as_slice() else {
                bail!("usage: telos info <file.pdf>")
            };
            let doc = TelosDocument::open(PathBuf::from(path))?;
            println!("file:    {}", doc.path().display());
            println!("version: PDF {}", doc.version());
            println!("pages:   {}", doc.page_count());
            if let Some(title) = doc.title() {
                println!("title:   {title}");
            }
            Ok(())
        }
        Some("render") => {
            let [_, path, page, out] = args.as_slice() else {
                bail!("usage: telos render <file.pdf> <page> <out.png>")
            };
            let page: u32 = page.parse().context("page must be a number (1-based)")?;
            if page == 0 {
                bail!("pages are 1-based");
            }
            let renderer = Renderer::new()?;
            let png = renderer.render_page_png(&PathBuf::from(path), page - 1, 1200, 0)?;
            std::fs::write(out, png)?;
            println!("wrote {out}");
            Ok(())
        }
        _ => {
            eprint!("{USAGE}");
            Ok(())
        }
    }
}
