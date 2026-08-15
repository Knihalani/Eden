package eden

import (
	"context"
	"testing"
)

func TestUnconfiguredTraceNoOp(t *testing.T) {
	// Without Configure, Trace must be a silent no-op.
	Configure(Config{}) // empty config → cleared
	c := Client()
	if c != nil {
		t.Errorf("Client() should be nil when Configure clears")
	}
	Trace(context.Background(), "test", nil) // should not panic
}

func TestSendPanicGuard(t *testing.T) {
	// Test that Send doesn't panic on unconfigured client.
	c := NewClient(Config{}) // unconfigured
	c.Send(FormatOpenAI, Event{EventID: "x"})
	// No panic means success.
}

func TestFormatForEventTypeEmpty(t *testing.T) {
	if FormatForEventType("") != FormatCustom {
		t.Errorf("empty event type should map to FormatCustom")
	}
}

func TestFormatForEventTypeAnthropicStream(t *testing.T) {
	if FormatForEventType("anthropic.message_stream") != FormatAnthropic {
		t.Errorf("anthropic stream should map to FormatAnthropic")
	}
}

func TestNewClientDefaultsHTTPClient(t *testing.T) {
	c := NewClient(Config{OrgID: "o", APIKey: "k"})
	if c.Cfg().HTTPClient == nil {
		t.Error("HTTPClient should default to non-nil")
	}
	if c.Cfg().HTTPClient.Timeout == 0 {
		t.Error("HTTPClient.Timeout should be set, not 0")
	}
}

func TestNewClientDefaultsBaseURL(t *testing.T) {
	c := NewClient(Config{OrgID: "o", APIKey: "k"})
	if c.Cfg().BaseURL == "" {
		t.Error("BaseURL should default to non-empty")
	}
}

func TestNewClientDefaultsProjectID(t *testing.T) {
	c := NewClient(Config{OrgID: "o", APIKey: "k"})
	if c.Cfg().ProjectID != "default" {
		t.Errorf("ProjectID default = %q, want 'default'", c.Cfg().ProjectID)
	}
}
