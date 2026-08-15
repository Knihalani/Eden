//! Basic example — wrap a fake OpenAI call, send a trace, and inspect the reply.
//!
//! Run with:
//!
//! ```text
//! EDEN_API_KEY=... EDEN_DEFAULT_ORG=... EDEN_BASE_URL=http://localhost:8000 \
//!     cargo run --example basic
//! ```
//!
//! The example:
//! 1. Builds a `Client` from env.
//! 2. Wraps a fake OpenAI `ChatCompletion` response and POSTs it to
//!    `/orgs/{org}/ingest/openai`.
//! 3. Wraps a fake Anthropic `Messages` response and POSTs it to
//!    `/orgs/{org}/ingest/anthropic`.
//! 4. Emits a free-form `agent_call` trace event.

use eden::{anthropic, openai, Client, Config, Event, EventBuilder, Outcome};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = Config::from_env()?;
    let client = Client::new(cfg)?;

    // 1. OpenAI
    let openai_response = serde_json::json!({
        "id": "chatcmpl-example",
        "object": "chat.completion",
        "model": "gpt-4o-mini",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "hello from Rust"},
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": 12,
            "completion_tokens": 4,
            "total_tokens": 16,
        }
    });
    openai::wrap(&client, "gpt-4o-mini", &openai_response).await?;
    println!("openai: posted ChatCompletion event");

    // 2. Anthropic
    let anthropic_response = serde_json::json!({
        "id": "msg_example",
        "type": "message",
        "model": "claude-3-5-sonnet-20240620",
        "role": "assistant",
        "content": [{"type": "text", "text": "hello back from Rust"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 12, "output_tokens": 5},
    });
    anthropic::wrap(&client, "claude-3-5-sonnet-20240620", &anthropic_response).await?;
    println!("anthropic: posted Messages event");

    // 3. Free-form agent_call
    let ev: Event = EventBuilder::agent_call("example_agent")
        .add_tag("production")
        .add_tag("example:basic")
        .with_duration_ms(137)
        .with_outcome(Outcome::Success)
        .set_metric("input_tokens", 12.0)
        .set_attr("user", "local-dev");
    eden::trace(&client, ev).await?;
    println!("agent_call: posted trace event");

    // 4. Read the config back so the example produces some output even
    // if the user is just sanity-checking the wiring.
    println!(
        "ingest base: {}",
        client.config().ingest_url(eden::IngestTarget::Openai)
    );
    Ok(())
}
