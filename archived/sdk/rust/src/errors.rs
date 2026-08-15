//! Error types for the Eden SDK.

use thiserror::Error;

/// Result alias used throughout the crate.
pub type Result<T> = std::result::Result<T, Error>;

/// Top-level error type. Variants mirror the typical SDK failure modes —
/// configuration problems, transport / HTTP failures, and JSON encoding
/// issues — and are deliberately small so call sites can `match` on them.
#[derive(Debug, Error)]
pub enum Error {
    /// A configuration value is missing or invalid.
    #[error("configuration error: {0}")]
    Config(String),

    /// Underlying `reqwest` error (DNS, TLS, timeout, transport).
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// JSON serialization / deserialization error.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// The server returned a non-success status code.
    #[error("ingest failed: HTTP {status} — {body}")]
    Ingest {
        /// HTTP status code.
        status: u16,
        /// Response body (truncated by the server if it was huge).
        body: String,
    },

    /// Caller passed an invalid argument (e.g. empty model name).
    #[error("invalid argument: {0}")]
    Invalid(String),
}
