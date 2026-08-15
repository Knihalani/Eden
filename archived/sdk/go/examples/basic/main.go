// Example: minimum-viable Eden Go SDK usage.
//
// Set EDEN_BASE_URL, EDEN_ORG_ID, EDEN_ORG_API_KEY in your env, then:
//
//	go run ./examples/basic
//
// The example talks to a fake OpenAI server unless you set
// EDEN_OPENAI_API_KEY, in which case it will hit the real OpenAI
// API. Either way, every call is reported to Eden in the
// background.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	eden "github.com/eden-ai/eden-go"
	"github.com/eden-ai/eden-go/openai"
	openaipkg "github.com/sashabaranov/go-openai"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("eden-go example: %v", err)
	}
}

func run() error {
	// 1) Configure the SDK. ConfigFromEnv() pulls EDEN_BASE_URL,
	// EDEN_ORG_ID, EDEN_ORG_API_KEY from the environment.
	eden.Configure(eden.Config{
		BaseURL:   getenv("EDEN_BASE_URL", "http://localhost:8000"),
		OrgID:     os.Getenv("EDEN_ORG_ID"),
		APIKey:    os.Getenv("EDEN_ORG_API_KEY"),
		ProjectID: getenv("EDEN_PROJECT_ID", "default"),
	})

	// 2) A bare Trace call. This emits a single eden.trace event.
	eden.Trace(context.Background(), "example_started", map[string]any{
		"ts": time.Now().Format(time.RFC3339),
	}, eden.TraceOptions{
		Tags: []string{"example", "go-sdk"},
	})

	// 3) Wrap an OpenAI client. If EDEN_OPENAI_API_KEY is set, we
	// hit the real API; otherwise we spin up a local fake server
	// that mimics the ChatCompletions response shape.
	apiKey := os.Getenv("EDEN_OPENAI_API_KEY")
	cfg := openaipkg.DefaultConfig(apiKey)
	if apiKey == "" {
		baseURL, err := startFakeOpenAIServer()
		if err != nil {
			return fmt.Errorf("start fake openai server: %w", err)
		}
		cfg.BaseURL = baseURL
	}
	inner := openaipkg.NewClientWithConfig(cfg)
	client := openai.Wrap(inner)

	// 4) Make a chat completion. Eden records the request/response
	// asynchronously.
	resp, err := client.CreateChatCompletion(context.Background(), openaipkg.ChatCompletionRequest{
		Model: openaipkg.GPT4oMini,
		Messages: []openaipkg.ChatCompletionMessage{
			{Role: openaipkg.ChatMessageRoleSystem, Content: "You are concise."},
			{Role: openaipkg.ChatMessageRoleUser, Content: "Say hello in one sentence."},
		},
	})
	if err != nil {
		return fmt.Errorf("chat completion: %w", err)
	}
	if len(resp.Choices) == 0 {
		return fmt.Errorf("no choices in response")
	}
	fmt.Println("OpenAI reply:", resp.Choices[0].Message.Content)

	// 5) TraceFunc — wrap any synchronous call.
	result, err := eden.TraceFunc(context.Background(), "double", func() (int, error) {
		return 21 * 2, nil
	})
	if err != nil {
		return fmt.Errorf("trace func: %w", err)
	}
	fmt.Println("TraceFunc result:", result)

	fmt.Println("Done. Check your Eden dashboard — events were sent in the background.")
	return nil
}

// startFakeOpenAIServer runs a minimal OpenAI-compatible endpoint
// and returns its base URL. The listener is closed when the
// program exits.
func startFakeOpenAIServer() (string, error) {
	mux := http.NewServeMux()
	mux.HandleFunc("/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		resp := openaipkg.ChatCompletionResponse{
			ID:      "chatcmpl-fake",
			Object:  "chat.completion",
			Created: time.Now().Unix(),
			Model:   openaipkg.GPT4oMini,
			Choices: []openaipkg.ChatCompletionChoice{{
				Index: 0,
				Message: openaipkg.ChatCompletionMessage{
					Role:    openaipkg.ChatMessageRoleAssistant,
					Content: "Hello from the fake OpenAI server!",
				},
				FinishReason: openaipkg.FinishReasonStop,
			}},
			Usage: openaipkg.Usage{
				PromptTokens:     13,
				CompletionTokens: 7,
				TotalTokens:      20,
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	return "http://" + ln.Addr().String(), nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
