package openai

import (
	"compress/gzip"
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
	openaipkg "github.com/sashabaranov/go-openai"
)

// readRequestBody decompresses a gzip-encoded request body when
// Content-Encoding is "gzip", otherwise reads it as-is.
func readRequestBody(t *testing.T, r *http.Request) []byte {
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

func TestWrapAndInner(t *testing.T) {
	inner := openaipkg.NewClient("sk-test")
	c := Wrap(inner)
	if c == nil {
		t.Fatal("Wrap returned nil")
	}
	if c.Inner() != inner {
		t.Error("Inner() should return the same pointer")
	}
}

func TestCreateChatCompletionReportsEvent(t *testing.T) {
	var hits int32
	var lastBody []byte
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		mu.Lock()
		lastBody = readRequestBody(t, r)
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	eden.Configure(eden.Config{BaseURL: srv.URL, OrgID: "o", APIKey: "k"})
	defer eden.SetClient(nil)

	// Fake OpenAI upstream — openaipkg will POST to BaseURL/v1/chat/completions.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		resp := openaipkg.ChatCompletionResponse{
			ID:      "chatcmpl-abc",
			Object:  "chat.completion",
			Created: 1700000000,
			Model:   openaipkg.GPT4oMini,
			Choices: []openaipkg.ChatCompletionChoice{{
				Index: 0,
				Message: openaipkg.ChatCompletionMessage{
					Role:    openaipkg.ChatMessageRoleAssistant,
					Content: "ok",
				},
				FinishReason: openaipkg.FinishReasonStop,
			}},
			Usage: openaipkg.Usage{PromptTokens: 5, CompletionTokens: 2, TotalTokens: 7},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer upstream.Close()

	cfg := openaipkg.DefaultConfig("sk-fake")
	cfg.BaseURL = upstream.URL
	inner := openaipkg.NewClientWithConfig(cfg)
	c := Wrap(inner)

	resp, err := c.CreateChatCompletion(context.Background(), openaipkg.ChatCompletionRequest{
		Model:    openaipkg.GPT4oMini,
		Messages: []openaipkg.ChatCompletionMessage{{Role: openaipkg.ChatMessageRoleUser, Content: "ping"}},
	})
	if err != nil {
		t.Fatalf("CreateChatCompletion: %v", err)
	}
	if len(resp.Choices) == 0 || resp.Choices[0].Message.Content != "ok" {
		t.Errorf("unexpected response: %+v", resp)
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
	if ev.EventType != "openai.chat_completion" {
		t.Errorf("event_type = %q, want openai.chat_completion", ev.EventType)
	}
	if ev.Payload["duration_ms"] == nil {
		t.Error("payload missing duration_ms")
	}
	if ev.Metrics["input_tokens"] != 5 || ev.Metrics["output_tokens"] != 2 {
		t.Errorf("metrics = %+v", ev.Metrics)
	}
}

func TestCreateChatCompletionReportsError(t *testing.T) {
	var hits int32
	var lastBody []byte
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		mu.Lock()
		lastBody = readRequestBody(t, r)
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	eden.Configure(eden.Config{BaseURL: srv.URL, OrgID: "o", APIKey: "k"})
	defer eden.SetClient(nil)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer upstream.Close()

	cfg := openaipkg.DefaultConfig("sk-fake")
	cfg.BaseURL = upstream.URL
	inner := openaipkg.NewClientWithConfig(cfg)
	c := Wrap(inner)

	_, err := c.CreateChatCompletion(context.Background(), openaipkg.ChatCompletionRequest{
		Model:    openaipkg.GPT4oMini,
		Messages: []openaipkg.ChatCompletionMessage{{Role: openaipkg.ChatMessageRoleUser, Content: "ping"}},
	})
	if err == nil {
		t.Fatal("expected error from upstream 500")
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
	_ = json.Unmarshal(lastBody, &ev)
	mu.Unlock()
	if ev.Attributes["error"] == "" {
		t.Errorf("expected error attribute, got %+v", ev.Attributes)
	}
}

func TestCreateChatCompletionNoClientNoOp(t *testing.T) {
	eden.SetClient(nil)
	inner := openaipkg.NewClient("sk-fake")
	c := Wrap(inner)
	// Unconfigured client means Send is a no-op; the call still goes
	// through to the (non-existent) upstream. Use a real httptest
	// upstream that returns 200 so the call succeeds; the assertion
	// is that no Eden event is sent and no panic happens.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(openaipkg.ChatCompletionResponse{
			Model: openaipkg.GPT4oMini,
			Choices: []openaipkg.ChatCompletionChoice{{
				Message: openaipkg.ChatCompletionMessage{Content: "ok"},
			}},
		})
	}))
	defer upstream.Close()
	cfg := openaipkg.DefaultConfig("sk-fake")
	cfg.BaseURL = upstream.URL
	c = Wrap(openaipkg.NewClientWithConfig(cfg))
	if _, err := c.CreateChatCompletion(context.Background(), openaipkg.ChatCompletionRequest{
		Model:    openaipkg.GPT4oMini,
		Messages: []openaipkg.ChatCompletionMessage{{Role: openaipkg.ChatMessageRoleUser, Content: "ping"}},
	}); err != nil {
		t.Fatalf("CreateChatCompletion: %v", err)
	}
}
