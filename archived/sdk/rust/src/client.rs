//! HTTP client.
//!
//! Thin `reqwest` wrapper that POSTs a JSON body to the configured
//! `/orgs/{org_id}/ingest/{format}` endpoint with `X-Org-Id` and
//! `X-Org-Api-Key` headers.  The client is `Send + Sync` and cheap to
//! clone — it holds an `Arc` under the hood.
//!
//! # Background queue
//!
//! [`Client::trace`] is **non-blocking**: it serialises the event and
//! sends it onto an unbounded channel, returning `Ok(())` immediately.
//! A private [`drain_task`] accumulates events and POSTs them in batches
//! of up to `BATCH_SIZE` (50) events, flushing at least every
//! `FLUSH_INTERVAL` (500 ms).  Call [`Client::shutdown`] before your
//! process exits to drain any remaining events (bounded 5 s timeout).

use crate::config::Config;
use crate::config::IngestTarget;
use crate::errors::{Error, Result};
use crate::event::EventBuilder;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::StatusCode;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

// ── constants ──────────────────────────────────────────────────────────────────

/// Maximum events per outbound batch request.
const BATCH_SIZE: usize = 50;
/// Drain task flushes pending events at least this often.
const FLUSH_INTERVAL: Duration = Duration::from_millis(500);
/// Timeout for the drain task to finish on `shutdown()`.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

// ── internal types ──────────────────────────────────────────────────────────

/// A single event waiting in the outbound queue.
struct QueuedEvent {
    target: IngestTarget,
    value: Value,
}

/// State shared by all `Client` clones (`Arc`-wrapped).
struct Inner {
    http: reqwest::Client,
    config: Config,
    /// Sender half of the background queue.  Set to `None` after shutdown.
    tx: std::sync::Mutex<Option<mpsc::UnboundedSender<QueuedEvent>>>,
    /// Background drain task handle.  Taken (→ `None`) inside `shutdown`.
    drain_handle: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

// ── public API ──────────────────────────────────────────────────────────────

/// HTTP client for the Eden ingest API.
///
/// Cloning is cheap — internally all clones share the same `Arc`-backed
/// state, including the background queue and drain task.
///
/// Call [`Client::shutdown`] before process exit to flush pending events.
///
/// # Panics
///
/// `Client::new` spawns a Tokio task and **must** be called from within
/// an active Tokio runtime.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("config", &self.inner.config)
            .finish()
    }
}

impl Client {
    /// Build a client from a [`Config`].
    ///
    /// Spawns a background drain task — must be called inside a Tokio
    /// runtime.  The result is cheap to clone (`Arc`-shared).
    pub fn new(config: Config) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_secs))
            .user_agent(concat!("eden-rust/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(Error::Http)?;

        let (tx, rx) = mpsc::unbounded_channel::<QueuedEvent>();

        let drain_http = http.clone();
        let drain_config = config.clone();
        let handle = tokio::spawn(drain_task(drain_http, drain_config, rx));

        Ok(Self {
            inner: Arc::new(Inner {
                http,
                config,
                tx: std::sync::Mutex::new(Some(tx)),
                drain_handle: std::sync::Mutex::new(Some(handle)),
            }),
        })
    }

    /// Read-only access to the resolved config.
    pub fn config(&self) -> &Config {
        &self.inner.config
    }

    /// Enqueue a telemetry event for background delivery.
    ///
    /// Returns `Ok(())` immediately — the event is serialised here but
    /// the HTTP round-trip happens asynchronously in the drain task.
    /// Serialisation errors (malformed event) are still surfaced as `Err`.
    ///
    /// If called after [`shutdown`](Client::shutdown) the event is silently
    /// dropped and a `debug`-level log message is emitted.
    pub async fn trace(&self, event: EventBuilder) -> Result<()> {
        // Serialise eagerly so callers still see JSON errors.
        let value = event.into_value()?;
        let target = self.inner.config.target;

        let guard = self.inner.tx.lock().unwrap();
        match guard.as_ref() {
            Some(tx) => {
                if tx.send(QueuedEvent { target, value }).is_err() {
                    // Receiver dropped (drain task already gone).
                    tracing::debug!("eden: channel closed, trace event dropped");
                }
            }
            None => {
                tracing::debug!("eden: post-shutdown trace, event dropped");
            }
        }
        Ok(())
    }

    /// Flush the event queue and wait for all outstanding sends.
    ///
    /// Drops the sender (signalling end-of-stream to the drain task), then
    /// waits up to 5 s for the task to finish.  Safe to call concurrently
    /// from multiple clones — only the first call does meaningful work.
    pub async fn shutdown(&self) {
        // Drop the sender so the drain task's recv() returns None.
        let maybe_tx = {
            let mut g = self.inner.tx.lock().unwrap();
            g.take()
        };
        drop(maybe_tx);

        // Take the join handle — only the first caller succeeds.
        let maybe_handle = {
            let mut g = self.inner.drain_handle.lock().unwrap();
            g.take()
        };

        if let Some(handle) = maybe_handle {
            if tokio::time::timeout(SHUTDOWN_TIMEOUT, handle)
                .await
                .is_err()
            {
                tracing::warn!("eden: drain task did not finish within {SHUTDOWN_TIMEOUT:?}");
            }
        }
    }

    /// Send a pre-built JSON value to a specific ingest target.
    ///
    /// Useful when the caller has already shaped the body (e.g. an OpenAI
    /// response that should be POSTed to `/ingest/openai`).  The body's
    /// top-level keys are passed through verbatim; only `event_id` and
    /// `source_format` are added if missing.
    ///
    /// This call is **synchronous** (blocking on the HTTP round-trip) and
    /// bypasses the background queue.  HTTP errors are propagated to the
    /// caller.
    pub async fn post_json(&self, target: IngestTarget, body: &Value) -> Result<()> {
        let mut body = body.clone();
        if let Some(obj) = body.as_object_mut() {
            if !obj.contains_key("event_id") {
                obj.insert(
                    "event_id".into(),
                    Value::String(format!("evt_{}", uuid::Uuid::new_v4())),
                );
            }
            if !obj.contains_key("source_format") {
                obj.insert("source_format".into(), Value::String("eden_sdk".into()));
            }
        }
        let url = self.inner.config.ingest_url(target);
        let headers = build_auth_headers(&self.inner.config, Some(target))?;
        let resp = self
            .inner
            .http
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        let body = resp.text().await.unwrap_or_default();
        Err(Error::Ingest {
            status: status.as_u16(),
            body: truncate(&body, 512),
        })
    }

    /// Send a batch of events to a single ingest target.
    ///
    /// The batch is POSTed as a raw JSON array `[...]` (matching the
    /// Python/TS SDK wire shape).  Useful for replaying a recorded trace dump.
    ///
    /// This call **bypasses the background queue** and is synchronous.
    pub async fn send_batch(&self, target: IngestTarget, events: &[Value]) -> Result<()> {
        send_batch_impl(&self.inner.http, &self.inner.config, target, events).await
    }

    /// Helper for tests: was the last response a 2xx?
    #[allow(dead_code)]
    pub(crate) fn is_success(status: StatusCode) -> bool {
        status.is_success()
    }
}

// ── module-level helpers (shared by Client methods and drain_task) ──────────

/// Build the standard set of auth + content-type headers.
fn build_auth_headers(config: &Config, _target: Option<IngestTarget>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        HeaderName::from_static("x-org-id"),
        HeaderValue::from_str(&config.org_id)
            .map_err(|_| Error::Config("invalid org_id header value".into()))?,
    );
    headers.insert(
        HeaderName::from_static("x-org-api-key"),
        HeaderValue::from_str(&config.api_key)
            .map_err(|_| Error::Config("invalid api_key header value".into()))?,
    );
    // Per-target extras would be added here in future.
    Ok(headers)
}

/// POST a JSON array of events to the given target (shared by `send_batch`
/// and the drain task).
async fn send_batch_impl(
    http: &reqwest::Client,
    config: &Config,
    target: IngestTarget,
    events: &[Value],
) -> Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    let body = Value::Array(events.to_vec());
    let url = config.ingest_url(target);
    let headers = build_auth_headers(config, None)?;
    let resp = http.post(&url).headers(headers).json(&body).send().await?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    let body = resp.text().await.unwrap_or_default();
    Err(Error::Ingest {
        status: status.as_u16(),
        body: truncate(&body, 512),
    })
}

// ── background drain task ────────────────────────────────────────────────────

/// Flush accumulated events grouped by ingest target.
///
/// Drains `pending` in place.  Errors from individual batch requests are
/// logged at `warn` level but do not abort subsequent batches.
async fn flush_pending(http: &reqwest::Client, config: &Config, pending: &mut Vec<QueuedEvent>) {
    if pending.is_empty() {
        return;
    }

    // Group by target path segment so events for different targets are
    // sent to the correct endpoints.
    let mut by_path: BTreeMap<&'static str, (IngestTarget, Vec<Value>)> = BTreeMap::new();
    for ev in pending.drain(..) {
        by_path
            .entry(ev.target.as_path())
            .or_insert_with(|| (ev.target, Vec::new()))
            .1
            .push(ev.value);
    }

    for (path, (target, events)) in by_path {
        let count = events.len();
        if let Err(e) = send_batch_impl(http, config, target, &events).await {
            tracing::warn!(
                error = %e,
                count,
                ingest_path = path,
                "eden: batch send failed"
            );
        }
    }
}

/// Long-running background task.
///
/// Receives [`QueuedEvent`]s from the channel, accumulates them, and
/// flushes via [`flush_pending`] when either:
/// - the batch reaches `BATCH_SIZE` (50) events, or
/// - `FLUSH_INTERVAL` (500 ms) elapses.
///
/// When the sender side is dropped (via [`Client::shutdown`]) the task
/// performs a final flush and exits.
async fn drain_task(
    http: reqwest::Client,
    config: Config,
    mut rx: mpsc::UnboundedReceiver<QueuedEvent>,
) {
    let mut pending: Vec<QueuedEvent> = Vec::with_capacity(BATCH_SIZE);
    let mut interval = tokio::time::interval(FLUSH_INTERVAL);
    // Skip missed ticks so a slow flush doesn't cause cascading immediate fires.
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            // Prefer draining new events over the timer when both are ready.
            biased;

            maybe_ev = rx.recv() => {
                match maybe_ev {
                    Some(ev) => {
                        pending.push(ev);
                        if pending.len() >= BATCH_SIZE {
                            flush_pending(&http, &config, &mut pending).await;
                        }
                    }
                    None => {
                        // Channel closed — sender was dropped in shutdown().
                        flush_pending(&http, &config, &mut pending).await;
                        return;
                    }
                }
            }

            _ = interval.tick() => {
                flush_pending(&http, &config, &mut pending).await;
            }
        }
    }
}

// ── utilities ────────────────────────────────────────────────────────────────

fn truncate(s: &str, max: usize) -> String {
    // Use char boundaries, not byte indices, so non-ASCII bodies don't
    // panic on a multi-byte character boundary.
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out = String::with_capacity(max * 4 + 4);
    for c in s.chars().take(max) {
        out.push(c);
    }
    out.push('…');
    out
}

// ── unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[tokio::test]
    async fn client_constructs_with_valid_config() {
        let cfg = Config::new("http://localhost:8000", "org_test", "sk_test").unwrap();
        let client = Client::new(cfg).unwrap();
        assert_eq!(client.config().org_id, "org_test");
        assert_eq!(
            client.config().ingest_url(IngestTarget::Openai),
            "http://localhost:8000/orgs/org_test/ingest/openai"
        );
        client.shutdown().await;
    }

    #[test]
    fn truncate_handles_non_ascii_safely() {
        // Regression: truncate used to slice on byte boundaries,
        // which panics if the cut falls inside a multi-byte char.
        let body = "你好，世界！".repeat(100); // 300+ multi-byte chars
        let out = truncate(&body, 10);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), 11); // 10 chars + ellipsis
    }

    #[test]
    fn truncate_returns_input_when_short() {
        let s = "short body";
        assert_eq!(truncate(s, 100), "short body");
    }
}
