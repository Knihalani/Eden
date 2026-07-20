package eden

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

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
		body, _ := io.ReadAll(r.Body)
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
