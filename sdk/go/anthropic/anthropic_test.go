package anthropic

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	eden "github.com/eden-ai/eden-go"
	anthropicpkg "github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

func TestWrapAndInner(t *testing.T) {
	inner := anthropicpkg.NewClient()
	c := Wrap(inner)
	if c == nil {
		t.Fatal("Wrap returned nil")
	}
	// The Client struct contains slices that aren't ==-comparable;
	// just exercise the Inner() accessor (real round-trip is
	// covered by TestCreateMessageReportsEvent).
	_ = c.Inner()
}

func TestCreateMessageReportsEvent(t *testing.T) {
	var hits int32
	var lastBody []byte
	var mu sync.Mutex
	edenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		mu.Lock()
		lastBody, _ = io.ReadAll(r.Body)
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	}))
	defer edenSrv.Close()

	eden.Configure(eden.Config{BaseURL: edenSrv.URL, OrgID: "o", APIKey: "k"})
	defer eden.SetClient(nil)

	// Hand-written JSON: avoids the SDK's strict union decoder
	// which panics on direct struct construction in tests.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
            "id": "msg_abc",
            "type": "message",
            "role": "assistant",
            "model": "claude-3-7-sonnet-latest",
            "content": [{"type": "text", "text": "hello"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 5}
        }`))
	}))
	defer upstream.Close()

	inner := anthropicpkg.NewClient(option.WithBaseURL(upstream.URL), option.WithAPIKey("sk-fake"))
	c := Wrap(inner)

	resp, err := c.CreateMessage(context.Background(), anthropicpkg.MessageNewParams{
		Model:     anthropicpkg.ModelClaude3_7SonnetLatest,
		MaxTokens: 64,
		Messages: []anthropicpkg.MessageParam{
			anthropicpkg.NewUserMessage(anthropicpkg.NewTextBlock("ping")),
		},
	})
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if resp == nil {
		t.Fatal("nil response")
	}

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
	var ev eden.Event
	if err := json.Unmarshal(lastBody, &ev); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	mu.Unlock()
	if ev.EventType != "anthropic.message" {
		t.Errorf("event_type = %q, want anthropic.message", ev.EventType)
	}
	if ev.Metrics["input_tokens"] != 10 || ev.Metrics["output_tokens"] != 5 {
		t.Errorf("metrics = %+v", ev.Metrics)
	}
}

func TestFirstTextExtractsTextBlock(t *testing.T) {
	if got := firstText(nil); got != "" {
		t.Errorf("firstText(nil) = %q, want \"\"", got)
	}
	resp := &anthropicpkg.Message{
		Content: []anthropicpkg.ContentBlockUnion{
			{Type: "text", Text: "first"},
			{Type: "text", Text: "second"},
		},
	}
	if got := firstText(resp); got != "first" {
		t.Errorf("firstText = %q, want first", got)
	}
}
