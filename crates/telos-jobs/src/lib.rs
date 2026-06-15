//! Cancellable background jobs (OCR, compress, redact-apply, export…).
//!
//! M0 stub: the job/progress/cancellation contract that the Tauri host and
//! CLI will consume. The queue with worker threads, snapshot-and-swap
//! semantics for destructive jobs, and progress events lands with the first
//! long-running feature (M2 Organize/Export).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Cooperative cancellation token shared between a job and its owner.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Progress report emitted by jobs; forwarded to the UI as events.
#[derive(Debug, Clone)]
pub struct Progress {
    /// 0.0..=1.0, or None while indeterminate.
    pub fraction: Option<f32>,
    pub message: String,
}
