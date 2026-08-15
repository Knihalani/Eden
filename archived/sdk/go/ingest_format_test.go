package eden

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestResolveIngestPath(t *testing.T) {
	cases := map[string]string{
		"":                "webhook",
		"openai":          "openai",
		"anthropic":       "anthropic",
		"webhook":         "webhook",
		"otel":            "otel",
		"OpenAI":          "openai",
		"custom":          "webhook",
		"langchain":       "webhook",
		"vercel-ai":       "webhook",
		"eden-sdk-doctor": "webhook",
		"pydantic-ai":     "webhook",
		"mastra":          "webhook",
	}
	for in, want := range cases {
		if got := ResolveIngestPath(in); got != want {
			t.Errorf("ResolveIngestPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIngestBatchRemapsNonAllowlisted(t *testing.T) {
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, OrgID: "o", APIKey: "k"})
	defer c.Close()

	for _, fmt := range []Format{
		Format("custom"),
		Format("langchain"),
		Format("vercel-ai"),
		FormatCustom,
	} {
		_, err := c.Ingest(context.Background(), fmt, Event{EventID: "x"})
		if err != nil {
			t.Fatalf("Ingest(%q): %v", fmt, err)
		}
		if path != "/orgs/o/ingest/webhook" {
			t.Errorf("Ingest(%q) path = %q, want /orgs/o/ingest/webhook", fmt, path)
		}
	}

	_, err := c.Ingest(context.Background(), FormatOpenAI, Event{EventID: "y"})
	if err != nil {
		t.Fatalf("Ingest(openai): %v", err)
	}
	if path != "/orgs/o/ingest/openai" {
		t.Errorf("Ingest(openai) path = %q, want /orgs/o/ingest/openai", path)
	}
}
