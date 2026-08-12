# eden-sdk (Rust)

> **MVP / not GA.** Minimum-viable tier only. No framework auto-instrument,
> streaming, retries, or full OpenTelemetry export in v0.1.0. Do not claim
> SOTA parity with Py/TS SDKs (SOTA program keeps Go/Rust as MVP banners).

Minimum-viable Rust client for Eden's telemetry ingest API. Mirrors the
Python `eden-sdk` and the `@eden-ai/sdk` packages: send a `TraceEvent` to
`POST /orgs/{org_id}/ingest/{format}` and Eden's observability platform
will record it in `telemetry_events`.

## What's in the box

- `eden::Client` — `reqwest`-backed HTTP client, cheap to clone.
- `eden::trace(event)` — ergonomic single-shot send.
- `eden::openai::wrap(client, model, &response)` — POST an OpenAI
  `ChatCompletion` to `/ingest/openai`.
- `eden::anthropic::wrap(client, model, &response)` — POST an Anthropic
  `Messages` response to `/ingest/anthropic`.
- `eden::trace_fn` / `eden::trace_fallible` — async-fn wrappers that
  emit a single `agent_call` event with timing + outcome.

> **Scope:** this is the minimum-viable tier. The SDK does NOT install
> any framework auto-instrumentation. Callers wrap their own functions
> explicitly. Streaming, retries, and full OpenTelemetry export are
> out of scope for v0.1.0.

## Quick start

```toml
# Cargo.toml
[dependencies]
eden-sdk = "0.1"
tokio = { version = "1.40", features = ["macros", "rt-multi-thread"] }
```

```rust
use eden::{Client, Config, EventBuilder, openai, anthropic};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = Config::from_env()?;
    let client = Client::new(cfg)?;

    // 1. OpenAI ChatCompletion
    let response = serde_json::json!({
        "id": "chatcmpl-1",
        "model": "gpt-4o-mini",
        "object": "chat.completion",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "hi"},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6}
    });
    openai::wrap(&client, "gpt-4o-mini", &response).await?;

    // 2. Anthropic Messages
    let msg = serde_json::json!({
        "id": "msg_1",
        "type": "message",
        "model": "claude-3-5-sonnet-20240620",
        "role": "assistant",
        "content": [{"type": "text", "text": "hi back"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 4, "output_tokens": 3}
    });
    anthropic::wrap(&client, "claude-3-5-sonnet-20240620", &msg).await?;

    // 3. Free-form agent_call
    client.trace(
        EventBuilder::agent_call("my_agent")
            .with_tag("production")
            .with_duration_ms(127)
    ).await?;

    Ok(())
}
```

## Configuration

The client reads from environment variables by default:

| Variable | Required | Default |
|----------|----------|---------|
| `EDEN_API_KEY` | yes | — |
| `EDEN_DEFAULT_ORG` | yes* | — |
| `EDEN_ORG_ID` | alias | — |
| `EDEN_BASE_URL` | no | `http://localhost:8000` |

\* Either `EDEN_DEFAULT_ORG` or `EDEN_ORG_ID` (Py/TS/Go parity alias) must be set;
`EDEN_DEFAULT_ORG` wins when both are present.

Non-allowlisted ingest format labels (`custom`, framework aliases, …) are
remapped to `webhook` via `resolve_ingest_path` / `Config::ingest_url_for`
so the gateway does not return HTTP 415.

You can also construct a `Config` directly:

```rust
let cfg = Config::new("https://api.edenobservability.com", "org_abc", "sk_xxx")?
    .with_timeout(60);
let client = Client::new(cfg)?;
```

## Examples

The `examples/basic.rs` example shows the full happy-path flow:

```bash
EDEN_API_KEY=... EDEN_DEFAULT_ORG=... EDEN_BASE_URL=http://localhost:8000 \
    cargo run --example basic
```

## Tests

```bash
cargo test                  # unit + integration tests
cargo test --lib            # unit tests only
cargo test --test integration  # integration tests with httpmock
```

Integration tests spin up an in-process `httpmock` server and assert
the SDK POSTs the right URL, headers, and JSON body — no live backend
required.

## End-to-end verification

1. Start Eden's backend (`./scripts/start_dev.sh` or `docker compose up`).
2. From this directory:

   ```bash
   cargo test
   EDEN_API_KEY=... EDEN_DEFAULT_ORG=... cargo run --example basic
   ```

3. Verify a `telemetry_events` row exists:

   ```bash
   psql "$DATABASE_URL" -c \
     "SELECT event_type, source_format, name FROM telemetry_events \
      ORDER BY created_at DESC LIMIT 5;"
   ```

   You should see one `agent_call` and one `llm_completion` row tagged
   with `openai` (and one with `anthropic` if you ran the example).
