// Package eden provides a minimum-viable Go SDK for the Eden
// observability platform. It ships:
//   - a fire-and-forget HTTP sender that POSTs telemetry to
//     /orgs/{org_id}/ingest/{format} on the Eden backend,
//   - Trace and TraceFunc helpers for emitting arbitrary
//     TelemetryEvents from application code, and
//   - thin wrappers around github.com/sashabaranov/go-openai and
//     github.com/anthropics/anthropic-sdk-go that auto-emit
//     openai.* / anthropic.* events to Eden after every call.
//
// This package deliberately does NOT include framework auto-
// instrumentation (no gorilla/mux or gin middleware yet). It is a
// stub-level integration surface that mirrors the ingestion JSON
// shape accepted by src/eden/observability/ingestion/providers.py
// in the Eden backend.
package eden

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Format is the source_format stamped on every row by the
// backend ingestion registry. The path /orgs/{org}/ingest/{format}
// must accept the wire shape sent by this SDK (see providers.py).
type Format string

const (
	FormatOpenAI    Format = "openai"
	FormatAnthropic Format = "anthropic"
	FormatWebhook   Format = "webhook"
	FormatCustom    Format = FormatWebhook // alias; /ingest/custom → 415
)

// Event is the wire shape that the backend decoders accept. It is
// intentionally permissive — see _openai_to_raw and
// _anthropic_to_raw in providers.py for the field-by-field mapping.
//
// Only EventID, SourceFormat, EventType and the inner Payload are
// strictly required; the rest is best-effort metadata.
type Event struct {
	EventID      string                 `json:"event_id"`
	TraceID      string                 `json:"trace_id,omitempty"`
	Name         string                 `json:"name,omitempty"`
	EventType    string                 `json:"event_type,omitempty"`
	Realm        string                 `json:"realm,omitempty"`
	Payload      map[string]any         `json:"payload,omitempty"`
	Metrics      map[string]float64     `json:"metrics,omitempty"`
	Attributes   map[string]string      `json:"attributes,omitempty"`
	Tags         []string               `json:"tags,omitempty"`
	RequestBody  map[string]any         `json:"request_body,omitempty"`
	ResponseBody map[string]any         `json:"response_body,omitempty"`
	Reasoning    map[string]any         `json:"reasoning,omitempty"`
	Extra        map[string]any         `json:"-"`
}

// Config holds the connection settings for the SDK. All fields can
// be set via env vars (EDEN_BASE_URL, EDEN_ORG_ID, EDEN_ORG_API_KEY).
type Config struct {
	// BaseURL is the root of the Eden backend, e.g.
	// "https://api.eden.example.com" or "http://localhost:8000".
	BaseURL string

	// OrgID is the X-Org-Id header value. It also appears in the
	// URL path /orgs/{OrgID}/ingest/...
	OrgID string

	// APIKey is the X-Org-Api-Key header value.
	APIKey string

	// ProjectID is sent as X-Project-Id. Defaults to "default".
	ProjectID string

	// HTTPClient allows callers to plug in a transport with custom
	// timeouts, retries, or TLS settings. Defaults to a 5s-timeout
	// http.Client.
	HTTPClient *http.Client

	// Debug toggles verbose logging of dropped payloads.
	Debug bool

	// BatchSize is the max queued events before an automatic flush.
	// Default 50.
	BatchSize int

	// FlushInterval is the max time to hold a non-empty batch.
	// Default 250ms. Zero disables the timer (size-only flush).
	FlushInterval time.Duration
}

// ConfigFromEnv builds a Config from environment variables. Missing
// values produce an unconfigured client (Trace calls become no-ops).
func ConfigFromEnv() Config {
	return Config{
		BaseURL:   getenv("EDEN_BASE_URL", "http://localhost:8000"),
		OrgID:     os.Getenv("EDEN_ORG_ID"),
		APIKey:    os.Getenv("EDEN_ORG_API_KEY"),
		ProjectID: getenv("EDEN_PROJECT_ID", "default"),
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

type queuedEvent struct {
	format Format
	ev     Event
}

// EdenClient is the HTTP sender. Use NewClient to construct one; it is
// safe for concurrent use.
type EdenClient struct {
	cfg Config
	mu  sync.Mutex
	// queue holds pending events grouped for flush.
	queue []queuedEvent
	// stopCh closes when the flush loop should exit.
	stopCh chan struct{}
	wg     sync.WaitGroup
}

// NewClient builds a Client with the given Config. Any unset
// transport field is replaced with a sensible default.
func NewClient(cfg Config) *EdenClient {
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "http://localhost:8000"
	}
	if cfg.ProjectID == "" {
		cfg.ProjectID = "default"
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 50
	}
	if cfg.FlushInterval == 0 {
		cfg.FlushInterval = 250 * time.Millisecond
	}
	c := &EdenClient{cfg: cfg, stopCh: make(chan struct{})}
	c.wg.Add(1)
	go c.flushLoop()
	return c
}

func (c *EdenClient) flushLoop() {
	defer c.wg.Done()
	ticker := time.NewTicker(c.cfg.FlushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			_ = c.Flush(context.Background())
		}
	}
}

// Close stops the background flusher and drains the queue once.
func (c *EdenClient) Close() {
	select {
	case <-c.stopCh:
	default:
		close(c.stopCh)
	}
	c.wg.Wait()
	_ = c.Flush(context.Background())
}

// IsConfigured reports whether the client has both OrgID and APIKey.
// Unconfigured clients silently drop every Trace call — the SDK is
// designed to never break the host application.
func (c *EdenClient) IsConfigured() bool {
	return c != nil && c.cfg.OrgID != "" && c.cfg.APIKey != ""
}

// Cfg exposes the resolved config (read-only).
func (c *EdenClient) Cfg() Config { return c.cfg }

// Ingest posts a single event to the given format endpoint. It is
// the synchronous, blocking variant — most callers want Send which
// is fire-and-forget.
//
// Returns the HTTP status code and any transport error. A non-2xx
// status is returned alongside a nil error so the caller can log it.
func (c *EdenClient) Ingest(ctx context.Context, format Format, ev Event) (int, error) {
	return c.IngestBatch(ctx, format, []Event{ev})
}

// IngestBatch posts a JSON array of events to the format endpoint.
func (c *EdenClient) IngestBatch(ctx context.Context, format Format, events []Event) (int, error) {
	if !c.IsConfigured() {
		return 0, ErrNotConfigured
	}
	if len(events) == 0 {
		return 200, nil
	}
	var body []byte
	var err error
	if len(events) == 1 {
		body, err = json.Marshal(events[0])
	} else {
		body, err = json.Marshal(events)
	}
	if err != nil {
		return 0, fmt.Errorf("eden: marshal event: %w", err)
	}
	pathFormat := ResolveIngestPath(string(format))
	url := strings.TrimRight(c.cfg.BaseURL, "/") +
		"/orgs/" + c.cfg.OrgID + "/ingest/" + pathFormat

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, fmt.Errorf("eden: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Org-Id", c.cfg.OrgID)
	req.Header.Set("X-Org-Api-Key", c.cfg.APIKey)
	req.Header.Set("X-Project-Id", c.cfg.ProjectID)
	req.Header.Set("User-Agent", "eden-go/0.1.0")

	resp, err := c.cfg.HTTPClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("eden: http do: %w", err)
	}
	defer resp.Body.Close()
	// drain body so the connection can be reused
	_, _ = io.Copy(io.Discard, resp.Body)

	if c.cfg.Debug {
		fmt.Fprintf(os.Stderr, "[eden] %s %s -> %d (%d bytes)\n",
			http.MethodPost, url, resp.StatusCode, len(body))
	}
	return resp.StatusCode, nil
}

// Flush drains the in-memory queue, posting one JSON array per format.
func (c *EdenClient) Flush(ctx context.Context) error {
	if !c.IsConfigured() {
		return nil
	}
	c.mu.Lock()
	batch := c.queue
	c.queue = nil
	c.mu.Unlock()
	if len(batch) == 0 {
		return nil
	}
	byFormat := map[Format][]Event{}
	for _, q := range batch {
		byFormat[q.format] = append(byFormat[q.format], q.ev)
	}
	var firstErr error
	for format, events := range byFormat {
		if status, err := c.IngestBatch(ctx, format, events); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			if c.cfg.Debug {
				fmt.Fprintf(os.Stderr, "[eden] flush failed: %v\n", err)
			}
		} else if status >= 400 && c.cfg.Debug {
			fmt.Fprintf(os.Stderr, "[eden] flush non-2xx: %d\n", status)
		}
	}
	return firstErr
}

// Send is the fire-and-forget variant. Events are queued and flushed
// when the batch fills or FlushInterval elapses. Safe to call from
// hot paths.
func (c *EdenClient) Send(format Format, ev Event) {
	if !c.IsConfigured() {
		return
	}
	c.mu.Lock()
	c.queue = append(c.queue, queuedEvent{format: format, ev: ev})
	shouldFlush := len(c.queue) >= c.cfg.BatchSize
	c.mu.Unlock()
	if shouldFlush {
		go func() {
			_ = c.Flush(context.Background())
		}()
	}
}
