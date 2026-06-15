//! Repo tasks. Run as `cargo xtask <task>` (alias in .cargo/config.toml).
//!
//! Uses `curl` and `tar` from PATH (present on macOS, Linux, Windows 10+,
//! and all CI runners) so xtask itself stays dependency-free.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use anyhow::{Context, Result, bail};

mod corpus;

/// Pinned bblanchon/pdfium-binaries release. Must match the PDFium build the
/// `pdfium-render` bindings target (its `pdfium_latest` feature — 7763 for
/// 0.9.2). Bump this and the crate version together.
const PDFIUM_TAG: &str = "chromium/7763";

const DESKTOP_PLATFORMS: &[&str] = &[
    "mac-arm64",
    "mac-x64",
    "linux-x64",
    "linux-arm64",
    "win-x64",
];
const MOBILE_PLATFORMS: &[&str] = &["android-arm64"];

const USAGE: &str = "\
cargo xtask — TelosPDF repo tasks

USAGE:
  cargo xtask fetch-pdfium [host|all|<platform>...]
      Download the pinned PDFium prebuilt(s) into .pdfium/<platform>/.
      Default: host. `all` = every desktop platform + android-arm64.
      Platforms: mac-arm64 mac-x64 linux-x64 linux-arm64 win-x64 android-arm64

  cargo xtask corpus
      Run the PDF corpus regression checks (synthetic fixtures + files from
      corpus/manifest.txt). Requires fetch-pdfium first.
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
        Some("fetch-pdfium") => fetch_pdfium(&args[1..]),
        Some("corpus") => corpus::run(&workspace_root()),
        _ => {
            eprint!("{USAGE}");
            Ok(())
        }
    }
}

fn workspace_root() -> PathBuf {
    // xtask lives at <root>/xtask.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn host_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "mac-arm64",
        ("macos", "x86_64") => "mac-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", _) => "linux-x64",
        ("windows", _) => "win-x64",
        (os, arch) => panic!("unsupported host: {os}-{arch}"),
    }
}

fn fetch_pdfium(args: &[String]) -> Result<()> {
    let mut platforms: Vec<&str> = Vec::new();
    if args.is_empty() {
        platforms.push(host_platform());
    }
    for arg in args {
        match arg.as_str() {
            "host" => platforms.push(host_platform()),
            "all" => {
                platforms.extend_from_slice(DESKTOP_PLATFORMS);
                platforms.extend_from_slice(MOBILE_PLATFORMS);
            }
            p if DESKTOP_PLATFORMS.contains(&p) || MOBILE_PLATFORMS.contains(&p) => {
                platforms.push(p)
            }
            other => bail!("unknown platform '{other}'\n{USAGE}"),
        }
    }
    platforms.dedup();

    for platform in platforms {
        let dest = workspace_root().join(".pdfium").join(platform);
        let stamp = dest.join(".tag");
        if stamp.exists() && std::fs::read_to_string(&stamp)?.trim() == PDFIUM_TAG {
            println!("{platform}: already at {PDFIUM_TAG}");
            continue;
        }
        download_and_extract(platform, &dest)?;
        std::fs::write(&stamp, PDFIUM_TAG)?;
        println!("{platform}: fetched {PDFIUM_TAG} -> {}", dest.display());
    }
    Ok(())
}

fn download_and_extract(platform: &str, dest: &Path) -> Result<()> {
    let url = format!(
        "https://github.com/bblanchon/pdfium-binaries/releases/download/{}/pdfium-{platform}.tgz",
        PDFIUM_TAG.replace('/', "%2F"),
    );
    if dest.exists() {
        std::fs::remove_dir_all(dest)?;
    }
    std::fs::create_dir_all(dest)?;
    let archive = dest.join("pdfium.tgz");

    println!("{platform}: downloading {url}");
    let status = Command::new("curl")
        .args([
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--output",
        ])
        .arg(&archive)
        .arg(&url)
        .status()
        .context("running curl (is it on PATH?)")?;
    if !status.success() {
        bail!("curl failed for {url}");
    }

    let status = Command::new("tar")
        .arg("xzf")
        .arg(&archive)
        .arg("-C")
        .arg(dest)
        .status()
        .context("running tar (is it on PATH?)")?;
    if !status.success() {
        bail!("tar extraction failed for {}", archive.display());
    }
    std::fs::remove_file(&archive)?;
    Ok(())
}
