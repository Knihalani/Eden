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
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"strconv"
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

	// DisableCompression disables gzip compression of request bodies.
	// Compression is on by default at gzip BestSpeed (level 1);
	// set this to true to send plain JSON instead.
	DisableCompression bool

	// MaxRetries is the number of additional HTTP attempts after an
	// initial failure (transport error, 429, or 5xx). Default 3.
	// Set to a negative value to disable retries entirely.
	MaxRetries int

	// RetryBase is the base delay for exponential back-off between
	// retry attempts. Default 500ms. Retry-After headers on 429/503
	// responses override this for that specific wait.
	RetryBase time.Duration
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

// bufPool recycles bytes.Buffer values across concurrent IngestBatch
// calls to reduce per-flush allocations.
var bufPool = sync.Pool{New: func() any { return new(bytes.Buffer) }}

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

	// sleepFn replaces time.Sleep in the retry back-off path.
	// nil → ctx-aware real sleep. Set in tests to avoid actual delays
	// while still exercising the retry logic. Set before the first
	// concurrent use of the client.
	sleepFn func(time.Duration)
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
	if cfg.MaxRetries == 0 {
		cfg.MaxRetries = 3
	}
	if cfg.RetryBase == 0 {
		cfg.RetryBase = 500 * time.Millisecond
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
// Request bodies are gzip-compressed at BestSpeed unless
// DisableCompression is set. Failed requests are retried up to
// MaxRetries times with exponential back-off; 429/503 Retry-After
// headers are honoured. Non-retryable 4xx responses are dropped with
// a Warn-level log message.
func (c *EdenClient) IngestBatch(ctx context.Context, format Format, events []Event) (int, error) {
	if !c.IsConfigured() {
		return 0, ErrNotConfigured
	}
	if len(events) == 0 {
		return 200, nil
	}

	// ── S12: encode JSON (streaming) and optionally gzip-compress. ──
	bodyBytes, contentEncoding, err := c.encodeBody(events)
	if err != nil {
		return 0, err
	}

	pathFormat := ResolveIngestPath(string(format))
	url := strings.TrimRight(c.cfg.BaseURL, "/") +
		"/orgs/" + c.cfg.OrgID + "/ingest/" + pathFormat

	// ── S7: retry loop. ──
	// maxAttempts = initial attempt + up to MaxRetries retries.
	// A negative MaxRetries value disables retries (1 attempt total).
	maxAttempts := 1
	if c.cfg.MaxRetries > 0 {
		maxAttempts = 1 + c.cfg.MaxRetries
	}

	var (
		lastStatus int
		lastErr    error
	)

	for attempt := 0; attempt < maxAttempts; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url,
			bytes.NewReader(bodyBytes))
		if err != nil {
			return 0, fmt.Errorf("eden: build request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Org-Id", c.cfg.OrgID)
		req.Header.Set("X-Org-Api-Key", c.cfg.APIKey)
		req.Header.Set("X-Project-Id", c.cfg.ProjectID)
		req.Header.Set("User-Agent", "eden-go/0.1.0")
		if contentEncoding != "" {
			req.Header.Set("Content-Encoding", contentEncoding)
		}

		resp, doErr := c.cfg.HTTPClient.Do(req)
		if doErr != nil {
			// Transport error: schedule a retry if attempts remain.
			lastErr = fmt.Errorf("eden: http do: %w", doErr)
			lastStatus = 0
			if attempt < maxAttempts-1 {
				if c.cfg.Debug {
					fmt.Fprintf(os.Stderr,
						"[eden] debug: attempt %d/%d transport error, retrying: %v\n",
						attempt+1, maxAttempts, doErr)
				}
				c.doSleep(ctx, retryBackoff(c.cfg.RetryBase, attempt, nil))
			}
			continue
		}

		// Drain body so the connection can be reused.
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()

		lastStatus = resp.StatusCode
		lastErr = nil

		if c.cfg.Debug {
			fmt.Fprintf(os.Stderr,
				"[eden] debug: attempt %d/%d POST %s -> %d (%d bytes)\n",
				attempt+1, maxAttempts, url, resp.StatusCode, len(bodyBytes))
		}

		// Success.
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return resp.StatusCode, nil
		}

		// Non-retryable 4xx: warn unconditionally and drop the batch.
		if resp.StatusCode >= 400 && resp.StatusCode < 500 && resp.StatusCode != 429 {
			fmt.Fprintf(os.Stderr,
				"[eden] WARN: dropping batch of %d event(s): non-retryable HTTP %d from %s\n",
				len(events), resp.StatusCode, url)
			return resp.StatusCode, nil
		}

		// Retryable (429 or 5xx): back off then loop.
		if attempt < maxAttempts-1 {
			delay := retryBackoff(c.cfg.RetryBase, attempt, resp)
			if c.cfg.Debug {
				fmt.Fprintf(os.Stderr,
					"[eden] debug: attempt %d/%d status %d, retrying in %v\n",
					attempt+1, maxAttempts, resp.StatusCode, delay)
			}
			c.doSleep(ctx, delay)
		}
	}

	// All attempts exhausted.
	if lastErr != nil {
		return 0, lastErr
	}
	return lastStatus, nil
}

// encodeBody serialises events to JSON using a streaming encoder and
// optionally gzip-compresses the result into a pooled buffer. The
// encoded bytes are copied out of the pool buffer before it is
// returned, so the buffer is available for the next concurrent call
// immediately after this function returns.
func (c *EdenClient) encodeBody(events []Event) (body []byte, contentEncoding string, err error) {
	buf := bufPool.Get().(*bytes.Buffer)
	buf.Reset()
	defer bufPool.Put(buf)

	if !c.cfg.DisableCompression {
		// S1: stream JSON directly into a gzip writer — no intermediate copy.
		gw, gzErr := gzip.NewWriterLevel(buf, gzip.BestSpeed)
		if gzErr != nil {
			return nil, "", fmt.Errorf("eden: gzip init: %w", gzErr)
		}
		enc := json.NewEncoder(gw)
		if len(events) == 1 {
			err = enc.Encode(events[0])
		} else {
			err = enc.Encode(events)
		}
		if err != nil {
			return nil, "", fmt.Errorf("eden: json encode: %w", err)
		}
		if err = gw.Close(); err != nil {
			return nil, "", fmt.Errorf("eden: gzip close: %w", err)
		}
		contentEncoding = "gzip"
	} else {
		enc := json.NewEncoder(buf)
		if len(events) == 1 {
			err = enc.Encode(events[0])
		} else {
			err = enc.Encode(events)
		}
		if err != nil {
			return nil, "", fmt.Errorf("eden: json encode: %w", err)
		}
	}

	// Copy bytes out of the pooled buffer so it can be reused
	// concurrently while the caller's retry loop is in flight.
	out := make([]byte, buf.Len())
	copy(out, buf.Bytes())
	return out, contentEncoding, nil
}

// retryBackoff returns the delay to wait before the next attempt.
// If resp carries a Retry-After header (integer seconds or HTTP-date),
// that value takes precedence. Otherwise the delay is:
//
//	base << attempt  +  jitter(0 .. base)
//
// capped at 30 seconds to prevent runaway waits on misconfigured
// MaxRetries values.
func retryBackoff(base time.Duration, attempt int, resp *http.Response) time.Duration {
	if resp != nil {
		if ra := resp.Header.Get("Retry-After"); ra != "" {
			// Integer seconds form (most common).
			if secs, err := strconv.Atoi(ra); err == nil && secs >= 0 {
				return time.Duration(secs) * time.Second
			}
			// HTTP-date form.
			if t, err := http.ParseTime(ra); err == nil {
				if d := time.Until(t); d > 0 {
					return d
				}
				return 0
			}
		}
	}
	// Exponential back-off with full jitter.
	shift := uint(attempt)
	if shift > 30 {
		shift = 30 // guard against overflow
	}
	backoff := base << shift
	const maxBackoff = 30 * time.Second
	if backoff > maxBackoff {
		backoff = maxBackoff
	}
	jitter := time.Duration(rand.Int63n(int64(base) + 1))
	return backoff + jitter
}

// doSleep sleeps for d, respecting context cancellation. In tests,
// sleepFn can be replaced with a no-op (or a duration recorder) to
// avoid real waits without removing the retry logic from the path.
func (c *EdenClient) doSleep(ctx context.Context, d time.Duration) {
	if c.sleepFn != nil {
		c.sleepFn(d)
		return
	}
	if d <= 0 {
		return
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
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
