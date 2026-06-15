//! TelosPDF core engine façade.
//!
//! Re-exports the public API of the engine crates. This is the crate that
//! shells embed — the Tauri host, `telos-cli`, and any future non-Tauri
//! frontend (via UniFFI). CI enforces that nothing under `crates/` depends
//! on Tauri or UI code.

pub use telos_doc as doc;
pub use telos_jobs as jobs;
pub use telos_render as render;

pub use telos_doc::TelosDocument;
pub use telos_render::Renderer;
