//! Thin Anthropic wrapper.
//!
//! Symmetric to [`crate::openai`]: the SDK doesn't bundle an Anthropic
//! HTTP client, but it accepts the standard `Messages` response shape
//! and ships it to `/ingest/anthropic`.
//!
//! ```no_run
//! # use eden::{Client, Config, anthropic};
//! # async fn run() -> Result<(), eden::Error> {
//! # let client = Client::new(Config::from_env()?)?;
//! let response = serde_json::json!({
//!     "id": "msg_abc",
//!     "type": "message",
//!     "model": "claude-3-5-sonnet-20240620",
//!     "role": "assistant",
//!     "content": [{"type": "text", "text": "hello"}],
//!     "stop_reason": "end_turn",
//!     "usage": {"input_tokens": 10, "output_tokens": 4},
//! });
//! eden::anthropic::wrap(&client, "claude-3-5-sonnet-20240620", &response).await?;
//! # Ok(()) }
//! ```

use crate::client::Client;
use crate::config::IngestTarget;
use crate::errors::Result;
use crate::event::EventBuilder;
use serde_json::Value;

/// Wrap an Anthropic Messages response and emit an `llm_completion`
/// event to the `/ingest/anthropic` endpoint.
pub async fn wrap(client: &Client, model: &str, response: &Value) -> Result<()> {
    let event = EventBuilder::llm_completion("anthropic_completion", "anthropic")
        .with_source_format("anthropic")
        .add_tag(format!("model:{}", model))
        .set_payload("anthropic", response.clone());
    client
        .post_json(IngestTarget::Anthropic, &event.into_value()?)
        .await
}

/// Variant that also accepts the original request body.
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
            "id": "msg_x",
            "model": "claude-3-5-sonnet-20240620",
            "role": "assistant",
            "content": [],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1}
        });
        let event = EventBuilder::llm_completion("anthropic_completion", "anthropic")
            .with_source_format("anthropic")
            .add_tag("model:claude-3-5-sonnet-20240620")
            .set_payload("anthropic", response)
            .into_value()
            .unwrap();
        assert_eq!(event["source_format"], "anthropic");
        assert!(event["tags"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "model:claude-3-5-sonnet-20240620"));
    }
}
