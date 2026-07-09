//! Configuration for the Eden client.

use crate::errors::{Error, Result};
use std::env;

/// Ingest target — which format-specific endpoint to POST to.
///
/// Mirrors the path segment used by the multi-format ingest route
/// (`POST /orgs/{org_id}/ingest/{format}`). The default (`Openai`) is the
/// canonical happy path for LLM completion traces.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum IngestTarget {
    /// `openai` — full ChatCompletion responses or usage events.
    #[default]
    Openai,
    /// `anthropic` — Messages API responses.
    Anthropic,
    /// `otel` — OpenTelemetry traces (JSON OTLP).
    Otel,
    /// `webhook` — generic catch-all.
    Webhook,
}

impl IngestTarget {
    /// Wire format string used in the URL path.
    pub fn as_path(&self) -> &'static str {
        match self {
            IngestTarget::Openai => "openai",
            IngestTarget::Anthropic => "anthropic",
            IngestTarget::Otel => "otel",
            IngestTarget::Webhook => "webhook",
        }
    }
}

/// Resolved configuration for an [`crate::Client`].
#[derive(Debug, Clone)]
pub struct Config {
    /// Base URL of the Eden API, e.g. `http://localhost:8000`.
    pub base_url: String,
    /// Tenant / org id. Source of truth for the ingest URL.
    pub org_id: String,
    /// Programmatic API key.
    pub api_key: String,
    /// Per-request timeout in seconds.
    pub timeout_secs: u64,
    /// Which ingest format to POST to.
    pub target: IngestTarget,
}

impl Config {
    /// Construct a `Config` from explicit fields. Performs minimal validation
    /// (non-empty `org_id` and `api_key`); a malformed base URL is detected
    /// on the first request.
    pub fn new(
        base_url: impl Into<String>,
        org_id: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Result<Self> {
        let base_url = base_url.into();
        let org_id = org_id.into();
        let api_key = api_key.into();
        if base_url.trim().is_empty() {
            return Err(Error::Config("base_url must be non-empty".into()));
        }
        if org_id.is_empty() {
            return Err(Error::Config("org_id must be non-empty".into()));
        }
        if api_key.is_empty() {
            return Err(Error::Config("api_key must be non-empty".into()));
        }
        Ok(Self {
            base_url,
            org_id,
            api_key,
            timeout_secs: 30,
            target: IngestTarget::default(),
        })
    }

    /// Build a `Config` from `EDEN_*` environment variables.
    ///
    /// Required: `EDEN_API_KEY`, `EDEN_DEFAULT_ORG`. Optional:
    /// `EDEN_BASE_URL` (defaults to `http://localhost:8000`).
    pub fn from_env() -> Result<Self> {
        let org_id = env::var("EDEN_DEFAULT_ORG")
            .map_err(|_| Error::Config("EDEN_DEFAULT_ORG is not set".into()))?;
        let api_key = env::var("EDEN_API_KEY")
            .map_err(|_| Error::Config("EDEN_API_KEY is not set".into()))?;
        let base_url = env::var("EDEN_BASE_URL")
            .unwrap_or_else(|_| "http://localhost:8000".to_string());
        Self::new(base_url, org_id, api_key)
    }

    /// Override the per-request timeout.
    pub fn with_timeout(mut self, secs: u64) -> Self {
        self.timeout_secs = secs;
        self
    }

    /// Override the default ingest target.
    pub fn with_target(mut self, target: IngestTarget) -> Self {
        self.target = target;
        self
    }

    /// Build the full ingest URL for a given target.
    pub fn ingest_url(&self, target: IngestTarget) -> String {
        format!(
            "{}/orgs/{}/ingest/{}",
            self.base_url.trim_end_matches('/'),
            self.org_id,
            target.as_path(),
        )
    }
}
