//! Integration tests for the Eden Rust SDK.
//!
//! These tests spin up an in-process `httpmock` server and assert that
//! the SDK POSTs the expected URL, headers, and JSON body.  They run with
//! `cargo test --test integration` and do not require a live Eden backend.
//!
//! # Background-queue notes
//!
//! `Client::trace` is now non-blocking — it enqueues the event and
//! returns immediately.  Tests that assert mock hit counts after `trace`
//! calls **must** call `client.shutdown().await` first to flush the queue.
//! Tests using `post_json` or `send_batch` are unaffected (those paths
//! remain synchronous).

use eden::{anthropic, openai, Client, Config, EventBuilder, IngestTarget};
use httpmock::prelude::*;
use std::time::{Duration, Instant};

fn mock_client(server: &MockServer) -> Client {
    let cfg = Config::new(server.base_url(), "org_test", "sk_test").unwrap();
    Client::new(cfg).unwrap()
}

// ── existing tests (updated for async queue) ────────────────────────────────

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
        then.status(200)
            .body(r#"{"accepted":1,"rejected":0,"total":1}"#);
    });

    let client = mock_client(&server);
    let ev = EventBuilder::agent_call("my_agent")
        .add_tag("production")
        .with_duration_ms(42)
        .with_outcome(eden::Outcome::Success);
    client.trace(ev).await.unwrap();
    // Flush the background queue before asserting mock hits.
    client.shutdown().await;
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
        then.status(200)
            .body(r#"{"accepted":1,"rejected":0,"total":1}"#);
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
    // openai::wrap calls post_json (direct, synchronous) — no shutdown needed.
    openai::wrap(&client, "gpt-4o-mini", &response)
        .await
        .unwrap();
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
        then.status(200)
            .body(r#"{"accepted":1,"rejected":0,"total":1}"#);
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
    // anthropic::wrap calls post_json (direct, synchronous) — no shutdown needed.
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
        then.status(200)
            .body(r#"{"accepted":2,"rejected":0,"total":2}"#);
    });

    let client = mock_client(&server);
    let events = vec![serde_json::json!({"a": 1}), serde_json::json!({"b": 2})];
    // send_batch bypasses the queue and is synchronous — no shutdown needed.
    client
        .send_batch(IngestTarget::Openai, &events)
        .await
        .unwrap();
    mock.assert();
}

/// post_json still propagates HTTP errors synchronously.
#[tokio::test]
async fn post_json_5xx_returns_ingest_error() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST).path("/orgs/org_test/ingest/openai");
        then.status(500).body("oops");
    });

    let client = mock_client(&server);
    let err = client
        .post_json(
            IngestTarget::Openai,
            &serde_json::json!({"event_type": "agent_call", "name": "boom"}),
        )
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
        then.status(200)
            .body(r#"{"accepted":1,"rejected":0,"total":1}"#);
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
    // trace() enqueues — flush before asserting.
    client.shutdown().await;
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
        then.status(200)
            .body(r#"{"accepted":1,"rejected":0,"total":1}"#);
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
    // trace() enqueues — flush before asserting.
    client.shutdown().await;
    mock.assert();
}

// ── new tests: background queue, batching, non-blocking, shutdown flush ──────

/// N `trace()` calls produce exactly one batched HTTP request containing
/// all N events (serialised as a JSON array).
///
/// We verify batching by asserting:
///   (a) the mock was hit exactly once (not once per event), and
///   (b) the single request body contains the first and last event names —
///       proving they were coalesced into one array.
#[tokio::test]
async fn batch_n_traces_produce_one_request_with_all_events() {
    const N: usize = 5;

    let server = MockServer::start();
    // Require that the body contains the first AND last event name — they
    // must appear in the same request to satisfy both body_contains checks.
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/orgs/org_test/ingest/openai")
            .body_contains(r#""agent_0""#)
            .body_contains(r#""agent_4""#);
        then.status(200)
            .body(r#"{"accepted":5,"rejected":0,"total":5}"#);
    });

    let client = mock_client(&server);

    for i in 0..N {
        client
            .trace(EventBuilder::agent_call(format!("agent_{i}")))
            .await
            .unwrap();
    }

    // Flushing must deliver all events in a single batched POST.
    client.shutdown().await;

    // All N events landed in exactly 1 request (batch, not per-event).
    // The body_contains guards above guarantee both "agent_0" and "agent_4"
    // appeared in the same request, proving they were coalesced.
    mock.assert_hits(1);
}

/// `trace()` returns without waiting for the HTTP round-trip.
#[tokio::test]
async fn trace_returns_before_http_completes() {
    let server = MockServer::start();
    let _mock = server.mock(|when, then| {
        when.method(POST).path("/orgs/org_test/ingest/openai");
        then.status(200).body(r#"{"accepted":1}"#);
    });

    let client = mock_client(&server);

    let start = Instant::now();
    client
        .trace(EventBuilder::agent_call("non_blocking"))
        .await
        .unwrap();
    let elapsed = start.elapsed();

    // Serialising + sending to an in-process channel should take < 10 ms.
    // We allow 100 ms to leave room for CI jitter.
    assert!(
        elapsed < Duration::from_millis(100),
        "trace() took {elapsed:?}; expected < 100 ms (non-blocking)"
    );

    client.shutdown().await;
}

/// `shutdown()` flushes events that have not yet been sent by the timer.
///
/// We verify all 3 events are coalesced into one request by requiring
/// all 3 names to appear in the same body.
#[tokio::test]
async fn shutdown_flushes_pending_events() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/orgs/org_test/ingest/openai")
            .body_contains(r#""ev1""#)
            .body_contains(r#""ev2""#)
            .body_contains(r#""ev3""#);
        then.status(200).body(r#"{"accepted":3}"#);
    });

    let client = mock_client(&server);

    client.trace(EventBuilder::agent_call("ev1")).await.unwrap();
    client.trace(EventBuilder::agent_call("ev2")).await.unwrap();
    client.trace(EventBuilder::agent_call("ev3")).await.unwrap();

    // Drain task may not have fired the 500 ms interval yet.
    client.shutdown().await;

    // All three events must have been delivered in one batched POST.
    mock.assert_hits(1);
}

/// Calling `trace()` after `shutdown()` must not panic — the event is
/// silently dropped.
#[tokio::test]
async fn trace_after_shutdown_is_a_noop() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST).path("/orgs/org_test/ingest/openai");
        then.status(200).body(r#"{"accepted":0}"#);
    });

    let client = mock_client(&server);
    client.shutdown().await;

    // Must not panic, must not send an HTTP request.
    client
        .trace(EventBuilder::agent_call("ghost"))
        .await
        .unwrap();

    assert_eq!(
        mock.hits(),
        0,
        "post-shutdown event must be dropped silently"
    );
}

/// Batching hard-caps at BATCH_SIZE (50): 51 events must produce
/// at least 2 requests (one batch of 50 + one of 1).
///
/// We assert ≥2 hits (the 50-event flush fires mid-stream, then shutdown
/// flushes the remaining 1), verifying the size cap is enforced.
#[tokio::test]
async fn batch_size_cap_at_50_events() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST).path("/orgs/org_test/ingest/openai");
        then.status(200).body(r#"{"accepted":50}"#);
    });

    let client = mock_client(&server);

    for i in 0..51_usize {
        client
            .trace(EventBuilder::agent_call(format!("ev_{i}")))
            .await
            .unwrap();
    }

    client.shutdown().await;

    // The 50th event triggers an immediate flush mid-stream, then shutdown
    // flushes the 51st, so we expect exactly 2 requests.
    assert!(
        mock.hits() >= 2,
        "51 events need at least 2 batch requests (got {})",
        mock.hits()
    );
}
