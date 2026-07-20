package eden

import "strings"

// Allowed ingest path segments (settings.ingestion_allowed_formats).
// Unknown / SDK-semantic labels remap to webhook to avoid HTTP 415.
var allowedIngestFormats = map[string]struct{}{
	"otel": {}, "helicone": {}, "langfuse": {},
	"openai": {}, "anthropic": {}, "bedrock": {},
	"gemini": {}, "framework": {}, "webhook": {},
}

// ResolveIngestPath returns the /ingest/{format} path segment for a
// source_format label. Allow-listed formats pass through; everything
// else (custom, langchain, vercel-ai, …) remaps to webhook.
func ResolveIngestPath(sourceFormat string) string {
	fmt := strings.ToLower(strings.TrimSpace(sourceFormat))
	if fmt == "" {
		return "webhook"
	}
	if _, ok := allowedIngestFormats[fmt]; ok {
		return fmt
	}
	return "webhook"
}
