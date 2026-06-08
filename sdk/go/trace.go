package eden

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

// ErrNotConfigured is returned by Ingest when the client is missing
// OrgID or APIKey. Trace and TraceFunc never return it — they no-op.
var ErrNotConfigured = errors.New("eden: client is not configured (missing EDEN_ORG_ID or EDEN_ORG_API_KEY)")

// TraceOptions customises a single Trace call. Tags and metadata are
// merged into the event payload's attributes and tags fields.
type TraceOptions struct {
	// Tags are attached to the event as e.g. ["production", "agent:router"].
	Tags []string

	// Metadata is attached as event attributes (stringified). Use
	// sparingly — attributes are stored as TEXT in PostgreSQL.
	Metadata map[string]string

	// TraceID lets you correlate a chain of Trace events. If empty,
	// a random ID is generated.
	TraceID string

	// EventType overrides the default "eden.trace" event type. Use
	// this when the trace corresponds to a specific domain concept
	// (e.g. "agent_call", "tool_invocation").
	EventType string

	// Realm is the deployment environment. Defaults to "production".
	Realm string
}

// defaultClient is the package-level Client used by the package-level
// Trace / TraceFunc helpers. It is initialised lazily by Configure.
var (
	defaultClientMu sync.RWMutex
	defaultClient   *EdenClient
)

// Configure sets the package-level default client. Pass the result
// of ConfigFromEnv() with any overrides you need:
//
//	eden.Configure(eden.Config{
//	    BaseURL: "https://api.eden.example.com",
//	    OrgID:   "org_abc",
//	    APIKey:  "sk_...",
//	})
//
// Calling Configure(nil) clears the default.
func Configure(cfg Config) {
	defaultClientMu.Lock()
	defer defaultClientMu.Unlock()
	if cfg.OrgID == "" && cfg.APIKey == "" && cfg.BaseURL == "" {
		defaultClient = nil
		return
	}
	defaultClient = NewClient(cfg)
}

// Client returns the current default client, or nil if Configure has
// not been called. Useful for subpackages (openai, anthropic) which
// need to honour the same configuration.
func Client() *EdenClient {
	defaultClientMu.RLock()
	defer defaultClientMu.RUnlock()
	return defaultClient
}

// SetClient replaces the default client. Mainly used by tests.
func SetClient(c *EdenClient) {
	defaultClientMu.Lock()
	defer defaultClientMu.Unlock()
	defaultClient = c
}

// Trace records a single telemetry event under the given name.
// Payload is a free-form map stored verbatim in the row's payload
// JSONB column. Returns immediately; the HTTP send happens in a
// goroutine.
//
// Safe to call from any goroutine. If no client is configured,
// Trace is a silent no-op.
func Trace(ctx context.Context, name string, payload map[string]any, opts ...TraceOptions) {
	c := Client()
	if c == nil || !c.IsConfigured() {
		return
	}
	var o TraceOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	ev := buildEvent(name, payload, o)
	format := FormatForEventType(o.EventType)
	c.Send(format, ev)
}

// TraceFunc wraps fn so that its execution is reported as a single
// Trace event. The function's return value is captured (as a JSON
// shape if it's a struct / map, else as its string form) and
// recorded in payload["result"]. Panics are recovered and recorded
// as payload["error"] with event outcome "failure".
//
// Usage:
//
//	result, err := eden.TraceFunc(ctx, "fetch_user", func() (any, error) {
//	    return db.GetUser(id)
//	}, eden.TraceOptions{Tags: []string{"db"}})
func TraceFunc[T any](ctx context.Context, name string, fn func() (T, error), opts ...TraceOptions) (T, error) {
	var (
		out T
		err error
	)
	func() {
		defer func() {
			if r := recover(); r != nil {
				err = panickedToError(r)
			}
		}()
		out, err = fn()
	}()

	c := Client()
	if c != nil && c.IsConfigured() {
		var o TraceOptions
		if len(opts) > 0 {
			o = opts[0]
		}
		payload := map[string]any{
			"function":   name,
			"duration_ms": time.Since(startTimeFromContext(ctx)).Milliseconds(),
		}
		if err != nil {
			payload["error"] = err.Error()
		} else {
			payload["result"] = out
		}
		ev := buildEvent(name, payload, o)
		if err != nil {
			if ev.Attributes == nil {
				ev.Attributes = map[string]string{}
			}
			ev.Attributes["error"] = err.Error()
		}
		c.Send(FormatForEventType(o.EventType), ev)
	}
	return out, err
}

// FormatForEventType maps an EventType prefix to the right ingestion
// format. Unknown / empty types default to FormatCustom.
func FormatForEventType(t string) Format {
	switch {
	case len(t) >= 7 && t[:7] == "openai.":
		return FormatOpenAI
	case len(t) >= 10 && t[:10] == "anthropic.":
		return FormatAnthropic
	default:
		return FormatCustom
	}
}

func buildEvent(name string, payload map[string]any, o TraceOptions) Event {
	ev := Event{
		EventID:   newID(),
		TraceID:   o.TraceID,
		Name:      name,
		EventType: orDefault(o.EventType, "eden.trace"),
		Realm:     orDefault(o.Realm, "production"),
		Payload:   payload,
		Tags:      o.Tags,
	}
	if o.Metadata != nil {
		ev.Attributes = make(map[string]string, len(o.Metadata))
		for k, v := range o.Metadata {
			ev.Attributes[k] = v
		}
	}
	return ev
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// startTimeFromContext is a no-op for now — context carries no
// monotonic start time. We use time.Now() so TraceFunc durations are
// measured from call to return, not from any upstream timestamp.
func startTimeFromContext(ctx context.Context) time.Time {
	_ = ctx
	return time.Now()
}

type panicError struct{ v any }

func (p *panicError) Error() string { return "panic: " + toString(p.v) }

func panickedToError(v any) error { return &panicError{v: v} }

func toString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if e, ok := v.(error); ok {
		return e.Error()
	}
	return "non-string panic value"
}
