//! Integration tests for the Eden Rust SDK.
//!
//! These tests spin up an in-process `httpmock` server and assert that
//! the SDK POSTs the expected URL, headers, and JSON body. They run with
//! `cargo test --test integration` and do not require a live Eden
//! backend.

use eden::{anthropic, openai, Client, Config, EventBuilder, IngestTarget};
use httpmock::prelude::*;

fn mock_client(server: &MockServer) -> Client {
    let cfg = Config::new(server.base_url(), "org_test", "sk_test").unwrap();
    Client::new(cfg).unwrap()
}

#[tokio::test]
async fn trace_posts_to_openai_ingest_with_expected_headers() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/orgs/org_test/ingest/openai")
            .header("x-org-id", "org_test")
            .header_exists("x-org-api-key")
            .header("content-type", "application/json")
            .body_contains(r#""event_type":"agent_call""#)
            .body_contains(r#""name":"my_agent""#)
            .body_contains(r#""source_format":"eden_sdk""#);
        then.status(200).body(r#"{"accepted":1,"rejected":0,"total":1}"#);
    });

    let client = mock_client(&server);
    let ev = EventBuilder::agent_call("my_agent")
        .add_tag("production")
        .with_duration_ms(42)
        .with_outcome(eden::Outcome::Success);
    client.trace(ev).await.unwrap();
    mock.assert();
}

#[tokio::test]
async fn openai_wrapper_targets_openai_path_with_payload() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/orgs/org_test/ingest/openai")
            .body_contains(r#""source_format":"openai""#)
            .body_contains(r#""model":"gpt-4o-mini""#)
            .body_contains(r#""total_tokens":2"#)
            .body_contains(r#"model:gpt-4o-mini"#);
        then.status(200).body(r#"{"accepted":1,"rejected":0,"total":1}"#);
    });

    let client = mock_client(&server);
    let response = serde_json::json!({
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "model": "gpt-4o-mini",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "hi"},
            "finish_reason": "stop"
        }],
        "usage": {
            "prompt_tokens": 1,
            "completion_tokens": 1,
            "total_tokens": 2
        }
    });
    openai::wrap(&client, "gpt-4o-mini", &response).await.unwrap();
    mock.assert();
}

#[tokio::test]
async fn anthropic_wrapper_targets_anthropic_path() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/orgs/org_test/ingest/anthropic")
            .body_contains(r#""source_format":"anthropic""#)
            .body_contains(r#""model":"claude-3-5-sonnet-20240620""#)
            .body_contains(r#"model:claude-3-5-sonnet-20240620"#);
        then.status(200).body(r#"{"accepted":1,"rejected":0,"total":1}"#);
    });

    let client = mock_client(&server);
    let response = serde_json::json!({
        "id": "msg_test",
        "type": "message",
        "model": "claude-3-5-sonnet-20240620",
        "role": "assistant",
        "content": [{"type": "text", "text": "hi"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 1, "output_tokens": 1}
    });
    anthropic::wrap(&client, "claude-3-5-sonnet-20240620", &response)
        .await
        .unwrap();
    mock.assert();
}

#[tokio::test]
async fn config_url_trims_trailing_slash() {
    let cfg = Config::new("http://localhost:8000/", "org_x", "sk_x").unwrap();
    assert_eq!(
        cfg.ingest_url(IngestTarget::Openai),
        "http://localhost:8000/orgs/org_x/ingest/openai"
    );
    assert_eq!(
        cfg.ingest_url(IngestTarget::Anthropic),
        "http://localhost:8000/orgs/org_x/ingest/anthropic"
    );
    assert_eq!(
        cfg.ingest_url(IngestTarget::Otel),
        "http://localhost:8000/orgs/org_x/ingest/otel"
    );
}

#[tokio::test]
async fn send_batch_posts_raw_json_array() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/orgs/org_test/ingest/openai")
            .body(r#"[{"a":1},{"b":2}]"#);
        then.status(200).body(r#"{"accepted":2,"rejected":0,"total":2}"#);
    });

    let client = mock_client(&server);
    let events = vec![serde_json::json!({"a": 1}), serde_json::json!({"b": 2})];
    client.send_batch(IngestTarget::Openai, &events).await.unwrap();
    mock.assert();
}

#[tokio::test]
async fn trace_5xx_returns_ingest_error() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST).path("/orgs/org_test/ingest/openai");
        then.status(500).body("oops");
    });

    let client = mock_client(&server);
    let err = client
        .trace(EventBuilder::agent_call("boom"))
        .await
        .unwrap_err();
    match err {
        eden::Error::Ingest { status, .. } => assert_eq!(status, 500),
        other => panic!("expected Ingest error, got {:?}", other),
    }
    mock.assert();
}

#[tokio::test]
async fn trace_fn_emits_agent_call_event() {
    use eden::trace_fn;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/orgs/org_test/ingest/openai")
            .body_contains(r#""event_type":"agent_call""#)
            .body_contains(r#""name":"my_agent""#);
        then.status(200).body(r#"{"accepted":1,"rejected":0,"total":1}"#);
    });

    let client = mock_client(&server);
    let counter = Arc::new(AtomicUsize::new(0));
    let c2 = Arc::clone(&counter);
    let traced = trace_fn(&client, "my_agent", move |x: i32| {
        let c = Arc::clone(&c2);
        async move {
            c.fetch_add(1, Ordering::SeqCst);
            x * 2
        }
    });
    let result = traced(21).await;
    assert_eq!(result, 42);
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    mock.assert();
}

#[tokio::test]
async fn trace_fallible_records_outcome() {
    use eden::trace_fallible;
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/orgs/org_test/ingest/openai")
            .body_contains(r#""event_type":"agent_call""#)
            .body_contains(r#""outcome":"failure""#)
            .body_contains(r#""error":"boom""#);
        then.status(200).body(r#"{"accepted":1,"rejected":0,"total":1}"#);
    });

    let client = mock_client(&server);
    let traced = trace_fallible(&client, "failing_agent", |x: i32| async move {
        if x < 0 {
            Err("boom".to_string())
        } else {
            Ok(x)
        }
    });
    let result: Result<i32, String> = traced(-1).await;
    assert!(result.is_err());
    mock.assert();
}
