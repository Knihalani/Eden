//! Configuration for the Eden client.

use crate::errors::{Error, Result};
use std::env;

/// Backend allow-list (`settings.ingestion_allowed_formats`).
const ALLOWED_INGEST_FORMATS: &[&str] = &[
    "otel",
    "helicone",
    "langfuse",
    "openai",
    "anthropic",
    "bedrock",
    "gemini",
    "framework",
    "webhook",
];

/// Map a source_format label onto an allow-listed `/ingest/{format}` path.
///
/// Unknown / SDK-semantic labels (`custom`, `langchain`, …) remap to
/// `webhook` so the gateway does not return HTTP 415. Mirrors the
/// Python / TypeScript SDKs.
///
/// Literal `framework` also remaps to `webhook`: TraceEvent JSON is not
/// OTel `resourceSpans`, and `/ingest/framework` would 422 `body_not_object`.
pub fn resolve_ingest_path(source_format: &str) -> &'static str {
    let fmt = source_format.trim().to_ascii_lowercase();
    if fmt.is_empty() {
        return "webhook";
    }
    if fmt == "framework" || fmt == "custom" {
        return "webhook";
    }
    for allowed in ALLOWED_INGEST_FORMATS {
        if *allowed == fmt {
            // Return the static slice from the allow-list table.
            return allowed;
        }
    }
    "webhook"
}

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
    /// Wire format string used in the URL path (already allow-listed).
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
    /// Required: `EDEN_API_KEY`, and either `EDEN_DEFAULT_ORG` or
    /// `EDEN_ORG_ID` (alias for parity with Py/TS/Go). Optional:
    /// `EDEN_BASE_URL` (defaults to `http://localhost:8000`).
    pub fn from_env() -> Result<Self> {
        let org_id = env::var("EDEN_DEFAULT_ORG")
            .or_else(|_| env::var("EDEN_ORG_ID"))
            .map_err(|_| Error::Config("EDEN_DEFAULT_ORG (or EDEN_ORG_ID) is not set".into()))?;
        let api_key = env::var("EDEN_API_KEY")
            .map_err(|_| Error::Config("EDEN_API_KEY is not set".into()))?;
        let base_url =
            env::var("EDEN_BASE_URL").unwrap_or_else(|_| "http://localhost:8000".to_string());
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

    /// Build the full ingest URL for a typed target (allow-listed path).
    pub fn ingest_url(&self, target: IngestTarget) -> String {
        self.ingest_url_for(target.as_path())
    }

    /// Build the full ingest URL for a free-form source_format label.
    /// Non-allowlisted labels remap to `webhook`.
    pub fn ingest_url_for(&self, source_format: &str) -> String {
        format!(
            "{}/orgs/{}/ingest/{}",
            self.base_url.trim_end_matches('/'),
            self.org_id,
            resolve_ingest_path(source_format),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serialise env-mutating tests — process env is shared.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn resolve_ingest_path_allowlisted_passthrough() {
        assert_eq!(resolve_ingest_path("openai"), "openai");
        assert_eq!(resolve_ingest_path("Anthropic"), "anthropic");
        assert_eq!(resolve_ingest_path("webhook"), "webhook");
        assert_eq!(resolve_ingest_path("otel"), "otel");
    }

    #[test]
    fn resolve_ingest_path_unknown_to_webhook() {
        for bad in [
            "custom",
            "framework",
            "langchain",
            "vercel-ai",
            "eden-sdk-doctor",
            "",
        ] {
            assert_eq!(
                resolve_ingest_path(bad),
                "webhook",
                "expected remap for {bad}"
            );
        }
    }

    #[test]
    fn ingest_url_for_remaps_custom() {
        let cfg = Config::new("http://localhost:8000", "org_x", "sk_x").unwrap();
        assert_eq!(
            cfg.ingest_url_for("custom"),
            "http://localhost:8000/orgs/org_x/ingest/webhook"
        );
        assert_eq!(
            cfg.ingest_url_for("langchain"),
            "http://localhost:8000/orgs/org_x/ingest/webhook"
        );
        assert_eq!(
            cfg.ingest_url(IngestTarget::Openai),
            "http://localhost:8000/orgs/org_x/ingest/openai"
        );
    }

    #[test]
    fn from_env_accepts_eden_org_id_alias() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var("EDEN_DEFAULT_ORG");
        env::set_var("EDEN_ORG_ID", "org_from_alias");
        env::set_var("EDEN_API_KEY", "sk_test");
        env::set_var("EDEN_BASE_URL", "http://localhost:8000");

        let cfg = Config::from_env().expect("EDEN_ORG_ID alias should work");
        assert_eq!(cfg.org_id, "org_from_alias");

        env::remove_var("EDEN_ORG_ID");
        env::remove_var("EDEN_API_KEY");
        env::remove_var("EDEN_BASE_URL");
    }

    #[test]
    fn from_env_prefers_eden_default_org() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var("EDEN_DEFAULT_ORG", "org_default");
        env::set_var("EDEN_ORG_ID", "org_alias");
        env::set_var("EDEN_API_KEY", "sk_test");

        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.org_id, "org_default");

        env::remove_var("EDEN_DEFAULT_ORG");
        env::remove_var("EDEN_ORG_ID");
        env::remove_var("EDEN_API_KEY");
    }
}
