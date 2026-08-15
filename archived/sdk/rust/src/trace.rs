//! `eden::trace(event)` — the canonical entry point.
//!
//! Mirrors the Python ``eden.trace_agent`` decorator and the TS
//! `traceAgent` decorator: capture timing + outcome around a unit of
//! work, build a telemetry event, and ship it asynchronously.
//!
//! At the minimum-viable tier the wrapper does NOT install any
//! auto-instrumentation. Callers wrap their own functions explicitly
//! (see `examples/basic.rs`).

use crate::client::Client;
use crate::config::IngestTarget;
use crate::errors::Result;
use crate::event::{EventBuilder, Outcome};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;

/// Send a pre-built event. Equivalent to `client.trace(event).await` but
/// more ergonomic at call sites that don't hold a client reference.
///
/// The caller is expected to construct the client once at startup and
/// pass it in here. We deliberately don't keep a global default client
/// (it's a sharp edge — process-wide mutable config).
pub async fn trace(client: &Client, event: EventBuilder) -> Result<()> {
    client.trace(event).await
}

/// Traced future type alias used by [`trace_fn`].
///
/// We can't name the async block's type, so we pin-box it.
pub type TracedFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Wrap an async function in a timing + outcome trace event.
///
/// The returned closure takes the wrapped function's argument by value
/// and returns a boxed future. Tracing failures are logged at `warn`
/// and swallowed — they MUST NOT break the wrapped call.
///
/// ```no_run
/// use eden::{Client, Config, trace_fn};
/// # async fn run() -> Result<(), eden::Error> {
/// let client = Client::new(Config::from_env()?)?;
/// let traced = trace_fn(&client, "my_agent", |input: String| async move {
///     format!("hello, {}", input)
/// });
/// let out = traced("world".to_string()).await;
/// # Ok(()) }
/// ```
pub fn trace_fn<F, Fut, A, T>(
    client: &Client,
    name: impl Into<String>,
    f: F,
) -> impl Fn(A) -> TracedFuture<'static, T>
where
    F: Fn(A) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = T> + Send + 'static,
    T: Send + 'static,
    A: Send + 'static,
{
    let name = name.into();
    let client = client.clone();
    let f: Arc<F> = Arc::new(f);
    move |arg: A| {
        let name = name.clone();
        let client = client.clone();
        let f = Arc::clone(&f);
        Box::pin(async move {
            let start = Instant::now();
            let result = f(arg).await;
            let duration_ms = start.elapsed().as_millis() as u64;
            let ev = EventBuilder::agent_call(name)
                .with_duration_ms(duration_ms)
                .with_outcome(Outcome::Success);
            if let Err(e) = client.trace(ev).await {
                tracing::warn!(error = %e, "eden::trace_fn: failed to emit event");
            }
            result
        })
    }
}

/// Fallible variant of [`trace_fn`] — call this when the wrapped future
/// returns a `Result<_, E>`. The wrapper inspects the `Result` to set
/// the outcome to `success` / `failure`.
///
/// ```no_run
/// use eden::{Client, Config, trace_fallible};
/// # async fn run() -> Result<(), eden::Error> {
/// # let client = Client::new(Config::from_env()?)?;
/// let traced = trace_fallible(&client, "my_agent", |x: i32| async move {
///     if x < 0 { Err("negative".to_string()) } else { Ok(x * 2) }
/// });
/// let out: Result<i32, String> = traced(2).await;
/// # Ok(()) }
/// ```
pub fn trace_fallible<F, Fut, A, T, E>(
    client: &Client,
    name: impl Into<String>,
    f: F,
) -> impl Fn(A) -> TracedFuture<'static, std::result::Result<T, E>>
where
    F: Fn(A) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = std::result::Result<T, E>> + Send + 'static,
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
    A: Send + 'static,
{
    let name = name.into();
    let client = client.clone();
    let f: Arc<F> = Arc::new(f);
    move |arg: A| {
        let name = name.clone();
        let client = client.clone();
        let f = Arc::clone(&f);
        Box::pin(async move {
            let start = Instant::now();
            let result = f(arg).await;
            let duration_ms = start.elapsed().as_millis() as u64;
            let outcome = if result.is_ok() {
                Outcome::Success
            } else {
                Outcome::Failure
            };
            let mut ev = EventBuilder::agent_call(name)
                .with_duration_ms(duration_ms)
                .with_outcome(outcome);
            if let Err(ref e) = result {
                ev = ev.set_attr("error", e.to_string());
            }
            if let Err(e) = client.trace(ev).await {
                tracing::warn!(error = %e, "eden::trace_fallible: failed to emit event");
            }
            result
        })
    }
}

/// Re-export the configured default ingest target for callers that want
/// it without depending on `crate::config` directly.
#[allow(dead_code)]
pub fn default_target() -> IngestTarget {
    IngestTarget::default()
}
