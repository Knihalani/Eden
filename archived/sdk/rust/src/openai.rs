//! Thin OpenAI wrapper.
//!
//! The minimum-viable SDK doesn't bundle `async-openai` — it expects the
//! caller to construct the response (or use the upstream SDK of their
//! choice) and pass it to [`wrap`] for telemetry emission. This keeps
//! the dependency surface tiny and lets the user pick their preferred
//! HTTP / retry layer.
//!
//! ```no_run
//! # use eden::{Client, Config, openai, Event, Outcome};
//! # async fn run() -> Result<(), eden::Error> {
//! # let client = Client::new(Config::from_env()?)?;
//! let response = serde_json::json!({
//!     "id": "chatcmpl-abc",
//!     "object": "chat.completion",
//!     "model": "gpt-4o-mini",
//!     "choices": [{
//!         "index": 0,
//!         "message": {"role": "assistant", "content": "hi"},
//!         "finish_reason": "stop",
//!     }],
//!     "usage": {
//!         "prompt_tokens": 10,
//!         "completion_tokens": 4,
//!         "total_tokens": 14,
//!     },
//! });
//! eden::openai::wrap(&client, "gpt-4o-mini", &response).await?;
//! # Ok(()) }
//! ```

use crate::client::Client;
use crate::config::IngestTarget;
use crate::errors::Result;
use crate::event::EventBuilder;
use serde_json::Value;

/// Wrap an OpenAI ChatCompletion response and emit an `llm_completion`
/// event to the `/ingest/openai` endpoint.
///
/// The body is passed through verbatim; the ingest decoder understands
/// the standard `ChatCompletion` shape (id, model, choices, usage).
pub async fn wrap(client: &Client, model: &str, response: &Value) -> Result<()> {
    let event = EventBuilder::llm_completion("openai_completion", "openai")
        .with_source_format("openai")
        .add_tag(format!("model:{}", model))
        .set_payload("openai", response.clone());
    client
        .post_json(IngestTarget::Openai, &event.into_value()?)
        .await
}

/// Variant that also accepts the original request body so the ingest
/// decoder can capture it for the portal transcript view.
pub async fn wrap_with_request(
    client: &Client,
    model: &str,
    request: &Value,
    response: &Value,
) -> Result<()> {
    let mut body = response.clone();
    if let Some(obj) = body.as_object_mut() {
        obj.insert("request_payload".into(), request.clone());
    }
    wrap(client, model, &body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_event_includes_model_tag() {
        let response = serde_json::json!({
            "id": "x",
            "model": "gpt-4o-mini",
            "choices": [],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
        });
        let event = EventBuilder::llm_completion("openai_completion", "openai")
            .with_source_format("openai")
            .add_tag("model:gpt-4o-mini")
            .set_payload("openai", response)
            .into_value()
            .unwrap();
        assert_eq!(event["source_format"], "openai");
        assert!(event["tags"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "model:gpt-4o-mini"));
    }
}
