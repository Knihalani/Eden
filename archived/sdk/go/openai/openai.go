// Package openai is a thin Eden-instrumented wrapper around
// github.com/sashabaranov/go-openai. It preserves the upstream
// client's public API one-for-one and emits a single
// openai.chat_completion event to Eden per call.
//
// Usage:
//
//	import (
//	    eden "github.com/eden-ai/eden-go"
//	    "github.com/eden-ai/eden-go/openai"
//	    openaipkg "github.com/sashabaranov/go-openai"
//	)
//
//	func main() {
//	    eden.Configure(eden.ConfigFromEnv())
//	    inner := openaipkg.NewClient("sk-...")
//	    client := openai.Wrap(inner)
//	    resp, err := client.CreateChatCompletion(ctx, openaipkg.ChatCompletionRequest{
//	        Model: openaipkg.GPT4o,
//	        Messages: []openaipkg.ChatCompletionMessage{{
//	            Role:    openaipkg.ChatMessageRoleUser,
//	            Content: "Hello!",
//	        }},
//	    })
//	    // resp.Choices[0].Message.Content holds the reply.
//	    // The call has been reported to Eden in the background.
//	}
//
// Streaming: go-openai v1.40 exposes ChatCompletionStream as a
// concrete struct (not an interface), which makes it awkward to
// wrap from outside the package. We therefore do NOT wrap the
// streaming API here; the non-streaming CreateChatCompletion still
// reports a complete event to Eden. If you need stream telemetry,
// call the upstream CreateChatCompletionStream and then post a
// custom eden.Trace() per chunk, or upgrade to a version of
// go-openai that exposes the stream as an interface.
package openai

import (
	"context"
	"time"

	eden "github.com/eden-ai/eden-go"
	openaipkg "github.com/sashabaranov/go-openai"
)

// Client is the Eden-instrumented wrapper. It holds a reference to
// the underlying go-openai client and adds observability on top.
type Client struct {
	inner *openaipkg.Client
}

// Wrap returns a Client that delegates every method to inner while
// reporting each call to Eden.
func Wrap(inner *openaipkg.Client) *Client { return &Client{inner: inner} }

// Inner exposes the wrapped go-openai client (for cases where a
// caller needs to bypass instrumentation, e.g. a side-channel
// healthcheck).
func (c *Client) Inner() *openaipkg.Client { return c.inner }

// CreateChatCompletion issues a chat completion request and reports
// the full request and response to Eden.
func (c *Client) CreateChatCompletion(
	ctx context.Context,
	req openaipkg.ChatCompletionRequest,
) (openaipkg.ChatCompletionResponse, error) {
	start := time.Now()
	resp, err := c.inner.CreateChatCompletion(ctx, req)
	c.report(ctx, req, resp, start, err)
	return resp, err
}

func (c *Client) report(
	ctx context.Context,
	req openaipkg.ChatCompletionRequest,
	resp openaipkg.ChatCompletionResponse,
	start time.Time,
	callErr error,
) {
	_ = ctx // reserved for future request-id propagation
	cl := eden.Client()
	if cl == nil || !cl.IsConfigured() {
		return
	}

	// Build a map shape that mirrors what providers.py expects. We
	// forward the response verbatim (response_body) plus the
	// original request (request_body) so the portal transcript
	// view can render both sides.
	respMap := map[string]any{
		"id":      resp.ID,
		"object":  resp.Object,
		"created": resp.Created,
		"model":   resp.Model,
		"choices": resp.Choices,
		"usage":   resp.Usage,
	}
	reqMap := map[string]any{
		"model":       req.Model,
		"messages":    req.Messages,
		"temperature": req.Temperature,
		"max_tokens":  req.MaxTokens,
		"stream":      req.Stream,
	}

	ev := eden.Event{
		EventID:   nonEmpty(resp.ID, "openai-"+string(req.Model)),
		EventType: "openai.chat_completion",
		Realm:     "production",
		Payload: map[string]any{
			"openai": map[string]any{
				"response_id":   resp.ID,
				"model":         resp.Model,
				"finish_reason": firstChoiceFinishReason(resp),
			},
			"duration_ms": time.Since(start).Milliseconds(),
		},
		Metrics:      openaiMetrics(resp.Usage),
		Attributes:   openaiAttributes(resp),
		Tags:         []string{"openai", "model:" + string(req.Model)},
		RequestBody:  reqMap,
		ResponseBody: respMap,
	}
	if callErr != nil {
		if ev.Attributes == nil {
			ev.Attributes = map[string]string{}
		}
		ev.Attributes["error"] = callErr.Error()
	}
	cl.Send(eden.FormatOpenAI, ev)
}

func openaiMetrics(u openaipkg.Usage) map[string]float64 {
	if u.TotalTokens == 0 && u.PromptTokens == 0 && u.CompletionTokens == 0 {
		return nil
	}
	return map[string]float64{
		"input_tokens":  float64(u.PromptTokens),
		"output_tokens": float64(u.CompletionTokens),
		"total_tokens":  float64(u.TotalTokens),
	}
}

func openaiAttributes(resp openaipkg.ChatCompletionResponse) map[string]string {
	if resp.Model == "" {
		return nil
	}
	return map[string]string{"openai.model": resp.Model}
}

func firstChoiceFinishReason(resp openaipkg.ChatCompletionResponse) string {
	if len(resp.Choices) == 0 {
		return ""
	}
	return string(resp.Choices[0].FinishReason)
}

func nonEmpty(s, def string) string {
	if s != "" {
		return s
	}
	return def
}
