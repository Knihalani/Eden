//! HTTP client.
//!
//! Thin `reqwest` wrapper that POSTs a JSON body to the configured
//! `/orgs/{org_id}/ingest/{format}` endpoint with `X-Org-Id` and
//! `X-Org-Api-Key` headers. The client is `Send + Sync` and cheap to
//! clone — it holds an `Arc<reqwest::Client>` under the hood.

use crate::config::IngestTarget;
use crate::config::Config;
use crate::errors::{Error, Result};
use crate::event::EventBuilder;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::StatusCode;
use serde_json::Value;
use std::sync::Arc;

/// HTTP client for the Eden ingest API.
///
/// Cloning is cheap — internally we just bump an `Arc`. The underlying
/// `reqwest::Client` is connection-pooled and reused across requests.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    config: Config,
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
    /// This validates the configuration and eagerly constructs the
    /// underlying `reqwest::Client` (TLS / connection pool / user-agent).
    /// The result is cheap to clone (`Arc`-shared), so callers should
    /// build the client once and reuse it for the lifetime of the app
    /// rather than rebuilding per call.
    pub fn new(config: Config) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(config.timeout_secs))
            .user_agent(concat!("eden-rust/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(Error::Http)?;
        Ok(Self {
            inner: Arc::new(Inner { http, config }),
        })
    }

    /// Read-only access to the resolved config.
    pub fn config(&self) -> &Config {
        &self.inner.config
    }

    /// Send a telemetry event.
    ///
    /// This is the lowest-level send. The event is serialised via
    /// [`EventBuilder::into_value`] and POSTed to the configured target.
    pub async fn trace(&self, event: EventBuilder) -> Result<()> {
        let value = event.into_value()?;
        self.post_json(self.inner.config.target, &value).await
    }

    /// Send a pre-built JSON value to a specific ingest target.
    ///
    /// Useful when the caller has already shaped the body (e.g. an OpenAI
    /// response that should be POSTed to `/ingest/openai`). The body's
    /// top-level keys are passed through verbatim; only `event_id` and
    /// `source_format` are added if missing.
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
        let headers = self.auth_headers(Some(target))?;
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
    /// Python/TS SDK wire shape). Useful for replaying a recorded
    /// trace dump.
    pub async fn send_batch(&self, target: IngestTarget, events: &[Value]) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let body = Value::Array(events.to_vec());
        let url = self.inner.config.ingest_url(target);
        let headers = self.auth_headers(None)?;
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

    /// Build the standard set of auth / content-type headers, optionally
    /// merging per-target extras.
    fn auth_headers(&self, target: Option<IngestTarget>) -> Result<HeaderMap> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            HeaderName::from_static("x-org-id"),
            HeaderValue::from_str(&self.inner.config.org_id)
                .map_err(|_| Error::Config("invalid org_id header value".into()))?,
        );
        headers.insert(
            HeaderName::from_static("x-org-api-key"),
            HeaderValue::from_str(&self.inner.config.api_key)
                .map_err(|_| Error::Config("invalid api_key header value".into()))?,
        );
        if let Some(t) = target {
            if let Some(extra) = self.extra_headers(t) {
                headers.extend(extra);
            }
        }
        Ok(headers)
    }

    /// Per-target header injection.
    ///
    /// The OpenAI ingest endpoint allows `X-Project-Id` to scope the
    /// event to a project; other targets don't need it. We don't set
    /// one by default — the backend treats the absence as `"default"`.
    fn extra_headers(&self, _target: IngestTarget) -> Option<HeaderMap> {
        None
    }

    /// Helper for tests: was the last response a 2xx?
    #[allow(dead_code)]
    pub(crate) fn is_success(status: StatusCode) -> bool {
        status.is_success()
    }
}

fn truncate(s: &str, max: usize) -> String {
    // Use char boundaries, not byte indices, so non-ASCII
    // bodies don't panic on a multi-byte character. The 512
    // cap is for log readability, so the exact byte count
    // doesn't matter.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[test]
    fn client_constructs_with_valid_config() {
        let cfg = Config::new("http://localhost:8000", "org_test", "sk_test").unwrap();
        let client = Client::new(cfg).unwrap();
        assert_eq!(client.config().org_id, "org_test");
        assert_eq!(
            client.config().ingest_url(IngestTarget::Openai),
            "http://localhost:8000/orgs/org_test/ingest/openai"
        );
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
