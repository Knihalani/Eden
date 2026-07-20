package eden

import "strings"

// Allowed ingest path segments (settings.ingestion_allowed_formats).
// Unknown / SDK-semantic labels remap to webhook to avoid HTTP 415.
var allowedIngestFormats = map[string]struct{}{
	"otel": {}, "helicone": {}, "langfuse": {},
	"openai": {}, "anthropic": {}, "bedrock": {},
	"gemini": {}, "framework": {}, "webhook": {},
}

// TraceEvent-shaped payloads (not OTel resourceSpans) must use webhook.
// Literal "framework" is allow-listed for real OTel OpenLLMetry, but Go
// emitters send TraceEvent JSON — remap to webhook to avoid HTTP 422.
var remapIngestFormats = map[string]string{
	"framework": "webhook",
	"custom":    "webhook",
}

// ResolveIngestPath returns the /ingest/{format} path segment for a
// source_format label. Allow-listed formats pass through (except those
// in remapIngestFormats); everything else remaps to webhook.
func ResolveIngestPath(sourceFormat string) string {
	fmt := strings.ToLower(strings.TrimSpace(sourceFormat))
	if fmt == "" {
		return "webhook"
	}
	if mapped, ok := remapIngestFormats[fmt]; ok {
		return mapped
	}
	if _, ok := allowedIngestFormats[fmt]; ok {
		return fmt
	}
	return "webhook"
}
