# Eden Go SDK

## Status: Experimental

This SDK is **experimental** and not covered by any stability guarantee.
APIs may change or be removed without notice, and it is not part of the
Eden GA surface. CI (`.github/workflows/sdk-go-ci.yml`) gates on
`go vet`, `go build`, and `go test` — the test job is labelled
"(experimental)" to reflect this status. Use the Python or TypeScript
SDKs for production workloads.

> **MVP / not GA.** This SDK is intentionally stub-level. Do not claim
> feature parity with the Python or TypeScript SDKs. Streaming wrappers,
> framework auto-instrumentation, and SOTA sampling/offline/OTel land
> only if a future program expands Go scope (SOTA W6 banners Go/Rust as
> out of GA).

Minimum-viable Go SDK for the [Eden](https://github.com/eden-ai/eden)
observability platform. Designed to be imported into any Go service that
calls OpenAI or Anthropic, with one goal: report every LLM call to
Eden's `/orgs/{org_id}/ingest/{format}` endpoint with no measurable
overhead on the call path.

## What you get

- `eden.Trace(ctx, name, payload, opts...)` — fire-and-forget custom event.
- `eden.TraceFunc(ctx, name, fn, opts...)` — wrap a function call so its
  return value and duration are reported automatically.
- `eden.Configure(cfg)` — set the package-level default client.
- `openai.Wrap(client)` — drop-in wrapper around
  [`github.com/sashabaranov/go-openai`](https://github.com/sashabaranov/go-openai).
- `anthropic.Wrap(client)` — drop-in wrapper around
  [`github.com/anthropics/anthropic-sdk-go`](https://github.com/anthropics/anthropic-sdk-go).

The SDK is intentionally **stub-level**: no framework auto-instrument
(no `gorilla/mux` middleware, no `otelgrpc` interceptor), and **no
streaming wrapper** — go-openai v1.40 exposes `ChatCompletionStream`
as a struct (not an interface), which makes it awkward to wrap from
outside the package. For stream telemetry, call the upstream
`CreateChatCompletionStream` directly and then emit a custom
`eden.Trace()` per chunk or per stream. Future workers can add
per-chunk TTFT / inter-token metrics without changing the public
surface.

## Installation

```bash
go get github.com/eden-ai/eden-go
```

## Quick start

```go
package main

import (
    "context"
    "fmt"
    "log"
    "os"

    eden "github.com/eden-ai/eden-go"
    "github.com/eden-ai/eden-go/openai"
    openaipkg "github.com/sashabaranov/go-openai"
)

func main() {
    eden.Configure(eden.Config{
        BaseURL:   os.Getenv("EDEN_BASE_URL"),
        OrgID:     os.Getenv("EDEN_ORG_ID"),
        APIKey:    os.Getenv("EDEN_ORG_API_KEY"),
        ProjectID: "default",
    })

    inner := openaipkg.NewClient(os.Getenv("OPENAI_API_KEY"))
    client := openai.Wrap(inner)

    resp, err := client.CreateChatCompletion(context.Background(), openaipkg.ChatCompletionRequest{
        Model: openaipkg.GPT4oMini,
        Messages: []openaipkg.ChatCompletionMessage{{
            Role:    openaipkg.ChatMessageRoleUser,
            Content: "Hello!",
        }},
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println(resp.Choices[0].Message.Content)
}
```

## Environment variables

| Variable             | Default                  | Notes                                |
|----------------------|--------------------------|--------------------------------------|
| `EDEN_BASE_URL`      | `http://localhost:8000`  | Root of the Eden backend. **Prod risk:** the default targets localhost — set this (or `Config.BaseURL`) to your real API URL in production or events silently miss the backend. |
| `EDEN_ORG_ID`        | _(unset)_                | Sent as `X-Org-Id` header            |
| `EDEN_ORG_API_KEY`   | _(unset)_                | Sent as `X-Org-Api-Key` header       |
| `EDEN_PROJECT_ID`    | `default`                | Sent as `X-Project-Id` header        |

If `EDEN_ORG_ID` or `EDEN_ORG_API_KEY` is unset, every `Trace` and
`Send` call is a silent no-op. **The SDK is designed never to break
the host application** — observability is best-effort.

## Wire format

The SDK POSTs the same `Event` struct (see `client.go`) to the
`/orgs/{org_id}/ingest/{format}` endpoint. Allow-listed formats are
`otel`, `helicone`, `langfuse`, `openai`, `anthropic`, `bedrock`,
`gemini`, `framework`, and `webhook`. Non-allowlisted labels (including
legacy `custom`, framework aliases like `langchain` / `vercel-ai`) are
remapped to `webhook` via `ResolveIngestPath` so the gateway does not
return HTTP 415. The field-by-field mapping is documented in
`src/eden/observability/ingestion/providers.py` in the Eden backend —
`_openai_to_raw` and `_anthropic_to_raw` are the authoritative
decoders.

The minimum viable event shape is:

```json
{
  "event_id":   "uuid-or-provider-id",
  "event_type": "openai.chat_completion",
  "name":       "gpt-4o-mini",
  "realm":      "production",
  "payload":    { "openai": { "model": "gpt-4o-mini" } },
  "metrics":    { "input_tokens": 13, "output_tokens": 7, "total_tokens": 20 },
  "tags":       ["openai", "model:gpt-4o-mini"]
}
```

## Testing

```bash
cd sdk/go
go test ./...
```

The test suite uses `httptest` to spin up a fake Eden backend and
asserts that:

- the right HTTP method, path, and headers are used,
- the event JSON decodes cleanly and contains the expected fields,
- `Trace` / `TraceFunc` are no-ops when no client is configured,
- panics inside `TraceFunc` are captured as errors (not propagated),
- the fire-and-forget `Send` actually delivers to the wire.

## Streaming

This wrapper does **not** instrument OpenAI streams. If you need
per-chunk latency or aggregated token counts from a streaming
response, call the upstream `CreateChatCompletionStream` directly
and emit custom `eden.Trace()` events as chunks arrive, or use
`TraceFunc` around the whole stream consumption loop:

```go
_, _ = eden.TraceFunc(ctx, "stream_completion", func() (string, error) {
    stream, err := inner.CreateChatCompletionStream(ctx, req)
    if err != nil { return "", err }
    defer stream.Close()
    var sb strings.Builder
    for {
        resp, err := stream.Recv()
        if err != nil { break }
        sb.WriteString(resp.Choices[0].Delta.Content)
    }
    return sb.String(), nil
}, eden.TraceOptions{EventType: "openai.chat_completion_stream"})
```

## Project layout

```
sdk/go/
  client.go             # HTTP sender + Config + Event
  trace.go              # Trace, TraceFunc, package-level config
  json.go               # JSON helpers
  client_test.go        # Sender tests
  trace_test.go         # Trace / TraceFunc tests
  openai/openai.go      # go-openai wrapper
  anthropic/anthropic.go # anthropic-sdk-go wrapper
  examples/basic/main.go
  README.md
  go.mod
```

## Roadmap (handled by follow-up workers)

- Real `otelgrpc` interceptor for the Anthropic SDK.
- PII pre-mask helper (mirrors `src/eden/observability/ingestion/pii.py`).
- Bedrock + Gemini wrappers (parity with the Python SDK).
- `otel-collector` exporter.
