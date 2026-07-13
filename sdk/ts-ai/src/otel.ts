/**
 * OpenTelemetry bridge — forward OTLP spans to Eden ingest.
 */

import { getDefaultClient } from "./client.js";

let _configured = false;

export interface OtelExporterOptions {
  serviceName?: string;
  framework?: string;
}

export function configureOtelExporter(opts: OtelExporterOptions = {}): void {
  const client = getDefaultClient();
  const cfg = client.getConfig();
  if (!cfg.orgId) {
    throw new Error("configure({ orgId }) is required before configureOtelExporter()");
  }

  // Dynamic import keeps OTel optional at install time.
  void (async () => {
    const otel = await import("@opentelemetry/sdk-trace-node").catch(() => null);
    const exporterMod = await import("@opentelemetry/exporter-trace-otlp-http").catch(
      () => null,
    );
    if (!otel || !exporterMod) {
      throw new Error(
        "OpenTelemetry bridge requires: npm install @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-http",
      );
    }
    const endpoint = `${cfg.baseUrl.replace(/\/$/, "")}/orgs/${cfg.orgId}/ingest/otel`;
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers["X-Org-Api-Key"] = cfg.apiKey;
    if (cfg.projectId) headers["X-Project-Id"] = cfg.projectId;
    if (opts.framework) headers["X-Source-Framework"] = opts.framework;

    const { NodeTracerProvider } = otel;
    const { OTLPTraceExporter } = exporterMod;
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(
      new (await import("@opentelemetry/sdk-trace-base")).SimpleSpanProcessor(
        new OTLPTraceExporter({ url: endpoint, headers }),
      ),
    );
    provider.register();
    _configured = true;
  })();
}

export function isOtelConfigured(): boolean {
  return _configured;
}
