//! Eden Rust SDK — minimum-viable observability client.
//!
//! This crate is the Rust counterpart to `@eden/sdk` and `eden.sdk`. It is
//! intentionally thin: a `reqwest`-backed HTTP client that POSTs telemetry
//! events to Eden's multi-format ingest endpoint, plus stub-level wrappers
//! for OpenAI and Anthropic that emit an `llm_completion` event after the
//! upstream call returns.
//!
//! # Quick start
//!
//! ```no_run
//! use eden::{Client, Config, Event, IngestTarget};
//!
//! # async fn run() -> Result<(), eden::Error> {
//! let cfg = Config::from_env().expect("EDEN_API_KEY / EDEN_DEFAULT_ORG");
//! let client = Client::new(cfg)?;
//!
//! client
//!     .trace(Event::agent_call("my_agent").add_tag("production"))
//!     .await?;
//! # Ok(()) }
//! ```

#![warn(missing_docs)]
#![warn(rust_2018_idioms)]

pub mod client;
pub mod errors;
pub mod openai;
pub mod anthropic;

mod config;
mod event;
mod trace;

pub use client::Client;
pub use config::{Config, IngestTarget};
pub use errors::{Error, Result};
pub use event::{Event, EventBuilder, Outcome, Realm};
pub use trace::{trace, trace_fallible, trace_fn, TracedFuture};
