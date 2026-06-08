// Package anthropic is a thin Eden-instrumented wrapper around
// github.com/anthropics/anthropic-sdk-go. It preserves the
// upstream client's Message.NewRequest / Messages API surface and
// emits a single anthropic.message event to Eden per call.
//
// Usage:
//
//	import (
//	    eden "github.com/eden-ai/eden-go"
//	    "github.com/eden-ai/eden-go/anthropic"
//	    anthropicpkg "github.com/anthropics/anthropic-sdk-go"
//	)
//
//	func main() {
//	    eden.Configure(eden.ConfigFromEnv())
//	    inner := anthropicpkg.NewClient()
//	    client := anthropic.Wrap(inner)
//	    resp, err := client.CreateMessage(ctx, anthropicpkg.MessageNewParams{
//	        Model:     anthropicpkg.ModelClaude3_7SonnetLatest,
//	        MaxTokens: 1024,
//	        Messages: []anthropicpkg.MessageParam{
//	            anthropicpkg.NewUserMessage(
//	                anthropicpkg.NewTextBlock("Hello!"),
//	            ),
//	        },
//	    })
//	    // resp.Content[0].Text holds the reply.
//	    // The call has been reported to Eden in the background.
//	}
package anthropic

import (
	"context"
	"encoding/json"
	"time"

	eden "github.com/eden-ai/eden-go"
	anthropicpkg "github.com/anthropics/anthropic-sdk-go"
)

// Client is the Eden-instrumented wrapper around the upstream
// anthropic-sdk-go Client.
type Client struct {
	inner anthropicpkg.Client
}

// Wrap returns a Client that delegates to inner while reporting
// every Messages call to Eden.
func Wrap(inner anthropicpkg.Client) *Client { return &Client{inner: inner} }

// Inner exposes the wrapped client.
func (c *Client) Inner() anthropicpkg.Client { return c.inner }

// CreateMessage issues a Messages API request and reports it to Eden.
func (c *Client) CreateMessage(
	ctx context.Context,
	params anthropicpkg.MessageNewParams,
) (*anthropicpkg.Message, error) {
	start := time.Now()
	resp, err := c.inner.Messages.New(ctx, params)
	c.report(ctx, params, resp, start, err)
	return resp, err
}

func (c *Client) report(
	ctx context.Context,
	params anthropicpkg.MessageNewParams,
	resp *anthropicpkg.Message,
	start time.Time,
	callErr error,
) {
	_ = ctx // reserved for future request-id propagation
	cl := eden.Client()
	if cl == nil || !cl.IsConfigured() {
		return
	}

	ev := eden.Event{
		EventID:   nonEmpty(messageID(resp), "anthropic-"+string(params.Model)),
		EventType: "anthropic.message",
		Realm:     "production",
		Payload: map[string]any{
			"anthropic": map[string]any{
				"response_id":         messageID(resp),
				"model":               string(params.Model),
				"stop_reason":         stopReason(resp),
				"content_text":        firstText(resp),
				"content_block_count": len(messageContent(resp)),
			},
			"duration_ms": time.Since(start).Milliseconds(),
		},
		Metrics:    anthropicMetrics(resp),
		Attributes: anthropicAttributes(resp, params),
		Tags:       []string{"anthropic", "model:" + string(params.Model)},
		RequestBody: map[string]any{
			"model":      string(params.Model),
			"max_tokens": params.MaxTokens,
			"messages":   params.Messages,
			"system":     params.System,
		},
	}
	if resp != nil {
		ev.ResponseBody = map[string]any{
			"id":         resp.ID,
			"type":       resp.Type,
			"role":       string(resp.Role),
			"model":      resp.Model,
			"content":    resp.Content,
			"stop_reason": resp.StopReason,
			"usage":      resp.Usage,
		}
	}
	if callErr != nil {
		if ev.Attributes == nil {
			ev.Attributes = map[string]string{}
		}
		ev.Attributes["error"] = callErr.Error()
	}
	cl.Send(eden.FormatAnthropic, ev)
}

func anthropicMetrics(resp *anthropicpkg.Message) map[string]float64 {
	if resp == nil {
		return nil
	}
	u := resp.Usage
	if u.InputTokens == 0 && u.OutputTokens == 0 {
		return nil
	}
	return map[string]float64{
		"input_tokens":  float64(u.InputTokens),
		"output_tokens": float64(u.OutputTokens),
		"total_tokens":  float64(u.InputTokens + u.OutputTokens),
	}
}

func anthropicAttributes(resp *anthropicpkg.Message, params anthropicpkg.MessageNewParams) map[string]string {
	out := map[string]string{"anthropic.model": string(params.Model)}
	if resp != nil && resp.ID != "" {
		out["anthropic.response_id"] = resp.ID
	}
	if resp != nil && resp.StopReason != "" {
		out["anthropic.stop_reason"] = string(resp.StopReason)
	}
	return out
}

func messageID(resp *anthropicpkg.Message) string {
	if resp == nil {
		return ""
	}
	return resp.ID
}

func stopReason(resp *anthropicpkg.Message) string {
	if resp == nil {
		return ""
	}
	return string(resp.StopReason)
}

func firstText(resp *anthropicpkg.Message) string {
	if resp == nil {
		return ""
	}
	for _, block := range resp.Content {
		// The upstream SDK exposes content blocks as a typed
		// union; we only need the text branch. The block has a
		// `.Text` field for text variants; fall back to JSON
		// round-trip when the field is unexported.
		if text, ok := extractText(block); ok {
			return text
		}
	}
	return ""
}

func extractText(block anthropicpkg.ContentBlockUnion) (string, bool) {
	// The ContentBlockUnion is a struct where the `Text` field is
	// populated for text-block variants. When other variants are
	// present (tool_use, thinking, etc.) the field is zero.
	// Falling back to JSON ensures we capture the text even if the
	// union's discriminator flips to a new variant in a future
	// SDK release.
	if block.Text != "" {
		return block.Text, true
	}
	type textish struct {
		Text string `json:"text"`
	}
	raw, err := json.Marshal(block)
	if err != nil {
		return "", false
	}
	var t textish
	if err := json.Unmarshal(raw, &t); err != nil {
		return "", false
	}
	return t.Text, t.Text != ""
}

func messageContent(resp *anthropicpkg.Message) []anthropicpkg.ContentBlockUnion {
	if resp == nil {
		return nil
	}
	return resp.Content
}

func nonEmpty(s, def string) string {
	if s != "" {
		return s
	}
	return def
}
