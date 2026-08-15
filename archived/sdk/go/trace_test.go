package eden

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTraceConfiguresAndFires(t *testing.T) {
	var hits int32
	var lastBody []byte
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		mu.Lock()
		lastBody = readTestBody(t, r)
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	Configure(Config{BaseURL: srv.URL, OrgID: "o", APIKey: "k"})
	defer SetClient(nil)

	Trace(context.Background(), "test_event", map[string]any{"k": "v"},
		TraceOptions{Tags: []string{"unit", "trace"}})

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&hits) == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("expected 1 hit, got %d", hits)
	}

	mu.Lock()
	var ev Event
	if err := json.Unmarshal(lastBody, &ev); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	mu.Unlock()
	if ev.Name != "test_event" {
		t.Errorf("name = %q, want test_event", ev.Name)
	}
	if ev.EventType != "eden.trace" {
		t.Errorf("event_type = %q, want eden.trace", ev.EventType)
	}
	if ev.Realm != "production" {
		t.Errorf("realm = %q, want production", ev.Realm)
	}
	if len(ev.Tags) != 2 || ev.Tags[0] != "unit" || ev.Tags[1] != "trace" {
		t.Errorf("tags = %v", ev.Tags)
	}
	if ev.Payload["k"] != "v" {
		t.Errorf("payload = %v", ev.Payload)
	}
}

func TestTraceUnconfiguredNoOp(t *testing.T) {
	// No Configure call: Trace must not panic, block, or call any
	// HTTP endpoint. The default client is nil, Client() returns
	// nil, and the early-return branch fires.
	SetClient(nil)
	Trace(context.Background(), "x", map[string]any{"k": "v"})
	// success = no panic, no hang
}

func TestTraceWithCustomEventType(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	Configure(Config{BaseURL: srv.URL, OrgID: "o", APIKey: "k"})
	defer SetClient(nil)

	Trace(context.Background(), "agent_run", map[string]any{"step": 1},
		TraceOptions{EventType: "openai.chat_completion"})

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&hits) == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if atomic.LoadInt32(&hits) != 1 {
		t.Errorf("expected 1 hit, got %d", hits)
	}
}

func TestTraceFuncSuccess(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	Configure(Config{BaseURL: srv.URL, OrgID: "o", APIKey: "k"})
	defer SetClient(nil)

	type result struct{ Value int }
	got, err := TraceFunc(context.Background(), "compute", func() (result, error) {
		return result{Value: 42}, nil
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got.Value != 42 {
		t.Errorf("value = %d, want 42", got.Value)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&hits) == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if atomic.LoadInt32(&hits) != 1 {
		t.Errorf("expected 1 hit, got %d", hits)
	}
}

func TestTraceFuncError(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	Configure(Config{BaseURL: srv.URL, OrgID: "o", APIKey: "k"})
	defer SetClient(nil)

	want := errors.New("boom")
	_, err := TraceFunc(context.Background(), "compute", func() (string, error) {
		return "", want
	})
	if !errors.Is(err, want) {
		t.Errorf("err = %v, want %v", err, want)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&hits) == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if atomic.LoadInt32(&hits) != 1 {
		t.Errorf("expected 1 hit, got %d", hits)
	}
}

func TestTraceFuncPanic(t *testing.T) {
	Configure(Config{OrgID: "o", APIKey: "k"})
	defer SetClient(nil)

	_, err := TraceFunc(context.Background(), "panicker", func() (any, error) {
		panic("kaboom")
	})
	if err == nil {
		t.Fatal("expected error from panic")
	}
	if err.Error() == "" {
		t.Error("error message should be non-empty")
	}
}

func TestConfigureAndClear(t *testing.T) {
	Configure(Config{OrgID: "o", APIKey: "k"})
	if Client() == nil {
		t.Fatal("Client() should be non-nil after Configure")
	}
	SetClient(nil)
	if Client() != nil {
		t.Fatal("Client() should be nil after SetClient(nil)")
	}
}

func TestTraceFuncDurationIsMeasured(t *testing.T) {
	// Regression: TraceFunc used to record duration_ms as 0 because
	// it measured time.Since(time.Now()). The fix captures a start
	// time before invoking the user function.
	var mu sync.Mutex
	var lastEvent Event
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readTestBody(t, r)
		var ev Event
		_ = json.Unmarshal(body, &ev)
		mu.Lock()
		lastEvent = ev
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()
	Configure(Config{BaseURL: srv.URL, OrgID: "o", APIKey: "k"})
	defer SetClient(nil)
	_, err := TraceFunc(context.Background(), "compute", func() (int, error) {
		time.Sleep(30 * time.Millisecond)
		return 0, nil
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		ready := lastEvent.EventID != ""
		mu.Unlock()
		if ready {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	dur, _ := lastEvent.Payload["duration_ms"].(float64)
	if dur < 25 {
		t.Errorf("duration_ms = %v, want >= 25ms", dur)
	}
}
