package eden

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// readTestBody decodes a gzip-compressed request body if
// Content-Encoding is "gzip", otherwise reads it plain. Used by
// test HTTP handlers to obtain the raw JSON that the SDK posted.
func readTestBody(t *testing.T, r *http.Request) []byte {
	t.Helper()
	if r.Header.Get("Content-Encoding") == "gzip" {
		gr, err := gzip.NewReader(r.Body)
		if err != nil {
			t.Fatalf("gzip.NewReader: %v", err)
		}
		defer gr.Close()
		b, err := io.ReadAll(gr)
		if err != nil {
			t.Fatalf("read gzip body: %v", err)
		}
		return b
	}
	b, _ := io.ReadAll(r.Body)
	return b
}

func TestConfigFromEnv(t *testing.T) {
	t.Setenv("EDEN_BASE_URL", "https://api.example.com")
	t.Setenv("EDEN_ORG_ID", "org_test")
	t.Setenv("EDEN_ORG_API_KEY", "sk_test")
	t.Setenv("EDEN_PROJECT_ID", "proj_test")
	cfg := ConfigFromEnv()
	if cfg.BaseURL != "https://api.example.com" {
		t.Errorf("BaseURL = %q, want %q", cfg.BaseURL, "https://api.example.com")
	}
	if cfg.OrgID != "org_test" {
		t.Errorf("OrgID = %q, want %q", cfg.OrgID, "org_test")
	}
	if cfg.APIKey != "sk_test" {
		t.Errorf("APIKey = %q, want %q", cfg.APIKey, "sk_test")
	}
	if cfg.ProjectID != "proj_test" {
		t.Errorf("ProjectID = %q, want %q", cfg.ProjectID, "proj_test")
	}
}

func TestNewClientDefaults(t *testing.T) {
	c := NewClient(Config{OrgID: "o", APIKey: "k"})
	if c.cfg.BaseURL != "http://localhost:8000" {
		t.Errorf("BaseURL = %q, want default", c.cfg.BaseURL)
	}
	if c.cfg.ProjectID != "default" {
		t.Errorf("ProjectID = %q, want default", c.cfg.ProjectID)
	}
	if c.cfg.HTTPClient == nil {
		t.Error("HTTPClient should default to non-nil")
	}
	if !c.IsConfigured() {
		t.Error("IsConfigured should be true with OrgID+APIKey")
	}
}

func TestIsConfiguredMissingFields(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
		want bool
	}{
		{"missing org", Config{APIKey: "k"}, false},
		{"missing key", Config{OrgID: "o"}, false},
		{"both set", Config{OrgID: "o", APIKey: "k"}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := NewClient(tc.cfg)
			if got := c.IsConfigured(); got != tc.want {
				t.Errorf("IsConfigured() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIngestSuccess(t *testing.T) {
	var got int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&got, 1)

		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/orgs/org_x/ingest/openai" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("X-Org-Id") != "org_x" {
			t.Errorf("X-Org-Id = %q", r.Header.Get("X-Org-Id"))
		}
		if r.Header.Get("X-Org-Api-Key") != "sk_x" {
			t.Errorf("X-Org-Api-Key = %q", r.Header.Get("X-Org-Api-Key"))
		}
		if r.Header.Get("X-Project-Id") != "default" {
			t.Errorf("X-Project-Id = %q", r.Header.Get("X-Project-Id"))
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Content-Type = %q", r.Header.Get("Content-Type"))
		}
		body := readTestBody(t, r)
		var ev Event
		if err := json.Unmarshal(body, &ev); err != nil {
			t.Fatalf("body not JSON: %v", err)
		}
		if ev.EventID != "evt_1" {
			t.Errorf("event_id = %q", ev.EventID)
		}
		if ev.EventType != "openai.chat_completion" {
			t.Errorf("event_type = %q", ev.EventType)
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"accepted":1,"source_format":"openai"}`))
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, OrgID: "org_x", APIKey: "sk_x"})
	status, err := c.Ingest(context.Background(), FormatOpenAI, Event{
		EventID:   "evt_1",
		EventType: "openai.chat_completion",
	})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if status != http.StatusAccepted {
		t.Errorf("status = %d, want 202", status)
	}
	if atomic.LoadInt32(&got) != 1 {
		t.Errorf("server hit count = %d, want 1", got)
	}
}

func TestIngestUnconfigured(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://localhost:1"})
	status, err := c.Ingest(context.Background(), FormatOpenAI, Event{})
	if err == nil {
		t.Fatal("expected error from unconfigured client")
	}
	if status != 0 {
		t.Errorf("status = %d, want 0", status)
	}
	if !strings.Contains(err.Error(), "not configured") {
		t.Errorf("err = %v, want ErrNotConfigured", err)
	}
}

func TestSendFireAndForget(t *testing.T) {
	var got int32
	var bodyLen int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&got, 1)
		b, _ := io.ReadAll(r.Body)
		atomic.StoreInt32(&bodyLen, int32(len(b)))
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := NewClient(Config{
		BaseURL:       srv.URL,
		OrgID:         "o",
		APIKey:        "k",
		BatchSize:     50,
		FlushInterval: time.Hour, // size/Flush-only in this test
	})
	defer c.Close()
	for i := 0; i < 5; i++ {
		c.Send(FormatCustom, Event{EventID: "x", EventType: "eden.trace"})
	}
	if err := c.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if got := atomic.LoadInt32(&got); got != 1 {
		t.Errorf("server hit count = %d, want 1 (batched)", got)
	}
	if atomic.LoadInt32(&bodyLen) < 2 {
		t.Errorf("expected non-empty batch body")
	}
}

func TestFlushOnBatchSize(t *testing.T) {
	var got int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&got, 1)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := NewClient(Config{
		BaseURL:       srv.URL,
		OrgID:         "o",
		APIKey:        "k",
		BatchSize:     3,
		FlushInterval: time.Hour,
	})
	defer c.Close()
	for i := 0; i < 3; i++ {
		c.Send(FormatOpenAI, Event{EventID: "x", EventType: "openai.chat_completion"})
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&got) >= 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := atomic.LoadInt32(&got); got < 1 {
		t.Errorf("server hit count = %d, want >=1 after batch size flush", got)
	}
}

func TestSendUnconfiguredNoOp(t *testing.T) {
	// Calling Send on an unconfigured client must not panic, must
	// not block, and must not produce any error.
	c := NewClient(Config{BaseURL: "http://localhost:1"})
	c.Send(FormatOpenAI, Event{EventID: "x"})
	// If we got here, success.
}

func TestFormatForEventType(t *testing.T) {
	cases := map[string]Format{
		"openai.chat_completion":        FormatOpenAI,
		"openai.chat_completion_stream": FormatOpenAI,
		"anthropic.message":             FormatAnthropic,
		"anthropic.message_stream":      FormatAnthropic,
		"agent_call":                    FormatCustom,
		"":                              FormatCustom,
		"unknown":                       FormatCustom,
	}
	for in, want := range cases {
		if got := FormatForEventType(in); got != want {
			t.Errorf("FormatForEventType(%q) = %q, want %q", in, got, want)
		}
	}
}


// ── S1: gzip compression tests ────────────────────────────────────────────

// TestGzipCompressionDefault verifies that IngestBatch sets
// Content-Encoding: gzip and that the body round-trips through gunzip
// back to valid JSON.
func TestGzipCompressionDefault(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Encoding") != "gzip" {
			t.Errorf("Content-Encoding = %q, want gzip", r.Header.Get("Content-Encoding"))
		}
		gr, err := gzip.NewReader(r.Body)
		if err != nil {
			t.Fatalf("gzip.NewReader: %v", err)
		}
		defer gr.Close()
		plain, err := io.ReadAll(gr)
		if err != nil {
			t.Fatalf("read gzip: %v", err)
		}
		var ev Event
		if err := json.Unmarshal(plain, &ev); err != nil {
			t.Fatalf("body not JSON after gunzip: %v", err)
		}
		if ev.EventID != "evt_gzip" {
			t.Errorf("event_id = %q, want evt_gzip", ev.EventID)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, OrgID: "o", APIKey: "k"})
	defer c.Close()

	status, err := c.Ingest(context.Background(), FormatOpenAI,
		Event{EventID: "evt_gzip", EventType: "openai.chat_completion"})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if status != http.StatusAccepted {
		t.Errorf("status = %d, want 202", status)
	}
}

// TestGzipBatchRoundTrip verifies that a multi-event batch is gzip-
// compressed and the JSON array round-trips correctly.
func TestGzipBatchRoundTrip(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Encoding") != "gzip" {
			t.Errorf("Content-Encoding = %q, want gzip", r.Header.Get("Content-Encoding"))
		}
		gr, err := gzip.NewReader(r.Body)
		if err != nil {
			t.Fatalf("gzip.NewReader: %v", err)
		}
		defer gr.Close()
		plain, err := io.ReadAll(gr)
		if err != nil {
			t.Fatalf("read gzip: %v", err)
		}
		var evs []Event
		if err := json.Unmarshal(plain, &evs); err != nil {
			t.Fatalf("batch not JSON array after gunzip: %v", err)
		}
		if len(evs) != 2 {
			t.Errorf("got %d events, want 2", len(evs))
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, OrgID: "o", APIKey: "k"})
	defer c.Close()

	_, err := c.IngestBatch(context.Background(), FormatOpenAI, []Event{
		{EventID: "a", EventType: "openai.chat_completion"},
		{EventID: "b", EventType: "openai.chat_completion"},
	})
	if err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}
}

// TestDisableCompression verifies the opt-out: when DisableCompression
// is set, no Content-Encoding header is sent and the body is plain JSON.
func TestDisableCompression(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if enc := r.Header.Get("Content-Encoding"); enc != "" {
			t.Errorf("Content-Encoding = %q, want empty", enc)
		}
		body, _ := io.ReadAll(r.Body)
		var ev Event
		if err := json.Unmarshal(body, &ev); err != nil {
			t.Fatalf("body not JSON: %v", err)
		}
		if ev.EventID != "evt_plain" {
			t.Errorf("event_id = %q, want evt_plain", ev.EventID)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := NewClient(Config{
		BaseURL:            srv.URL,
		OrgID:              "o",
		APIKey:             "k",
		DisableCompression: true,
	})
	defer c.Close()

	_, err := c.Ingest(context.Background(), FormatOpenAI,
		Event{EventID: "evt_plain"})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
}

// ── S7: retry tests ───────────────────────────────────────────────────────

// TestRetryOn5xx verifies that a transient 5xx causes the SDK to retry
// and ultimately succeed on the third attempt.
func TestRetryOn5xx(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n < 3 {
			w.WriteHeader(http.StatusServiceUnavailable) // 503
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := NewClient(Config{
		BaseURL:    srv.URL,
		OrgID:      "o",
		APIKey:     "k",
		MaxRetries: 3,
		RetryBase:  5 * time.Millisecond, // short for speed
	})
	c.sleepFn = func(time.Duration) {} // no-op: don't actually wait
	defer c.Close()

	status, err := c.Ingest(context.Background(), FormatOpenAI,
		Event{EventID: "x"})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if status != http.StatusAccepted {
		t.Errorf("status = %d, want 202", status)
	}
	if n := atomic.LoadInt32(&attempts); n != 3 {
		t.Errorf("attempt count = %d, want 3 (2 failures + 1 success)", n)
	}
}

// TestRetryExhausted verifies that when all retries are exhausted the
// last non-2xx status is returned (no panic, no error).
func TestRetryExhausted(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusBadGateway) // 502 always
	}))
	defer srv.Close()

	c := NewClient(Config{
		BaseURL:    srv.URL,
		OrgID:      "o",
		APIKey:     "k",
		MaxRetries: 2, // 3 total attempts
		RetryBase:  1 * time.Millisecond,
	})
	c.sleepFn = func(time.Duration) {}
	defer c.Close()

	status, err := c.Ingest(context.Background(), FormatOpenAI,
		Event{EventID: "x"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", status)
	}
	if n := atomic.LoadInt32(&attempts); n != 3 {
		t.Errorf("attempt count = %d, want 3", n)
	}
}

// TestNonRetryable4xxDrops verifies that a non-retryable 4xx (e.g.
// 403) is NOT retried and returns the status code with a nil error.
func TestNonRetryable4xxDrops(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusForbidden) // 403
	}))
	defer srv.Close()

	c := NewClient(Config{
		BaseURL:    srv.URL,
		OrgID:      "o",
		APIKey:     "k",
		MaxRetries: 3,
	})
	c.sleepFn = func(time.Duration) {}
	defer c.Close()

	status, err := c.Ingest(context.Background(), FormatOpenAI,
		Event{EventID: "x"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status != http.StatusForbidden {
		t.Errorf("status = %d, want 403", status)
	}
	// Must NOT have retried.
	if n := atomic.LoadInt32(&attempts); n != 1 {
		t.Errorf("attempt count = %d, want 1 (no retry on 4xx)", n)
	}
}

// TestRetryOn429WithRetryAfter verifies that a 429 response with a
// Retry-After header passes the exact header value to the sleep
// function and does not exceed a reasonable bound.
func TestRetryOn429WithRetryAfter(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n == 1 {
			w.Header().Set("Retry-After", "0") // retry immediately
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	var mu sync.Mutex
	var sleptDurations []time.Duration

	c := NewClient(Config{
		BaseURL:    srv.URL,
		OrgID:      "o",
		APIKey:     "k",
		MaxRetries: 3,
		RetryBase:  500 * time.Millisecond,
	})
	c.sleepFn = func(d time.Duration) {
		mu.Lock()
		sleptDurations = append(sleptDurations, d)
		mu.Unlock()
	}
	defer c.Close()

	status, err := c.Ingest(context.Background(), FormatOpenAI,
		Event{EventID: "x"})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if status != http.StatusAccepted {
		t.Errorf("status = %d, want 202", status)
	}
	// Should have retried once.
	if n := atomic.LoadInt32(&attempts); n != 2 {
		t.Errorf("attempt count = %d, want 2", n)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(sleptDurations) != 1 {
		t.Fatalf("sleep call count = %d, want 1", len(sleptDurations))
	}
	// Retry-After: 0 → sleep 0s; verify the header was honoured.
	if sleptDurations[0] != 0 {
		t.Errorf("sleep duration = %v, want 0 (Retry-After: 0)", sleptDurations[0])
	}
}

// TestRetryTransportError verifies that a transport-level failure (TCP
// refused) is retried and an error is returned after all attempts.
func TestRetryTransportError(t *testing.T) {
	// Use a server that closes immediately after accepting.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Hijack the connection and close it to simulate a transport error.
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	srv.Close() // close immediately so all connections are refused

	c := NewClient(Config{
		BaseURL:    srv.URL,
		OrgID:      "o",
		APIKey:     "k",
		MaxRetries: 2,
		RetryBase:  1 * time.Millisecond,
	})
	c.sleepFn = func(time.Duration) {}
	defer c.Close()

	_, err := c.Ingest(context.Background(), FormatOpenAI, Event{EventID: "x"})
	if err == nil {
		t.Fatal("expected error from refused connection, got nil")
	}
}

// TestCloseNoGoroutineLeak verifies that Close stops the flush loop
// goroutine (wg.Wait returns) and that a second Close does not panic.
func TestCloseNoGoroutineLeak(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, OrgID: "o", APIKey: "k"})
	c.Send(FormatOpenAI, Event{EventID: "x"})
	c.Close()  // must return (goroutine exited)
	c.Close()  // double-close must not panic
}

func BenchmarkSendFireAndForget(b *testing.B) {
	// Measure the cost of a fire-and-forget Trace call. The HTTP
	// server returns 202 immediately so the goroutine backing
	// each Send can return quickly; we measure how long it takes
	// to enqueue + schedule the goroutine, which is the only
	// work the user actually pays for.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, OrgID: "o", APIKey: "k"})

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		c.Send(FormatOpenAI, Event{EventID: "x", EventType: "openai.chat_completion"})
	}
}
