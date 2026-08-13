/**
 * OpenTelemetry bridge — forward OTLP spans to Eden ingest.
 */

import { getDefaultClient } from "./client.js";

let _configured = false;

export interface OtelExporterOptions {
  serviceName?: string;
  framework?: string;
}

/**
 * Set up an OTel ``NodeTracerProvider`` that forwards spans to the Eden
 * ingest endpoint via OTLP/HTTP.
 *
 * @returns A ``Promise<void>`` that resolves once the provider is
 *   registered, or **rejects** if a required peer dependency is missing
 *   or setup fails. The rejection message names every missing package so
 *   the developer knows exactly what to install.
 *
 *   Callers that do **not** await the returned promise will still see the
 *   error via a ``console.error`` log — a default ``.catch`` handler is
 *   attached to the returned promise before it is handed back, so the
 *   rejection is always handled and will **never** trigger Node's
 *   ``UnhandledPromiseRejection`` crash, even with ``void configureOtelExporter()``.
 *
 * @example
 * // Awaited (recommended — surfaces setup errors immediately):
 * await configureOtelExporter({ framework: "langchain" });
 *
 * // Fire-and-forget (error is logged to stderr; process continues):
 * void configureOtelExporter();
 */
export function configureOtelExporter(opts: OtelExporterOptions = {}): Promise<void> {
  const setup = (async (): Promise<void> => {
    const client = getDefaultClient();
    const cfg = client.getConfig();
    if (!cfg.orgId) {
      throw new Error(
        "[eden-ai] configure({ orgId }) is required before configureOtelExporter()",
      );
    }

    // Import all three peer deps up front so we can name every missing
    // package in a single, actionable error message.
    const [otel, exporterMod, tracerBase] = await Promise.all([
      import("@opentelemetry/sdk-trace-node").catch(() => null),
      import("@opentelemetry/exporter-trace-otlp-http").catch(() => null),
      import("@opentelemetry/sdk-trace-base").catch(() => null),
    ]);

    if (!otel || !exporterMod || !tracerBase) {
      const missingPkgs: string[] = [];
      if (!otel) missingPkgs.push("@opentelemetry/sdk-trace-node");
      if (!exporterMod) missingPkgs.push("@opentelemetry/exporter-trace-otlp-http");
      if (!tracerBase) missingPkgs.push("@opentelemetry/sdk-trace-base");
      throw new Error(
        `[eden-ai] OpenTelemetry bridge is missing required peer ${
          missingPkgs.length === 1 ? "dependency" : "dependencies"
        }. Run: npm install ${missingPkgs.join(" ")}`,
      );
    }

    const endpoint = `${cfg.baseUrl.replace(/\/$/, "")}/orgs/${cfg.orgId}/ingest/otel`;
    const headers: Record<string, string> = {};
    if (cfg.orgId) headers["X-Org-Id"] = cfg.orgId;
    if (cfg.apiKey) headers["X-Org-Api-Key"] = cfg.apiKey;
    if (cfg.projectId) headers["X-Project-Id"] = cfg.projectId;
    if (opts.framework) headers["X-Source-Framework"] = opts.framework;

    const { NodeTracerProvider } = otel;
    const { OTLPTraceExporter } = exporterMod;
    const { BatchSpanProcessor } = tracerBase;
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: endpoint, headers }),
      ),
    );
    provider.register();
    _configured = true;
  })();

  // Attach a default rejection handler so callers that do not await the
  // returned promise still see the error logged to stderr — instead of
  // silently swallowing it (the old void-async IIFE) or crashing the
  // process with an unhandled-rejection abort (a bare async IIFE with no
  // handler). This makes ``void configureOtelExporter()`` safe to use while
  // still letting awaiting callers receive the full rejection.
  setup.catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(
      "[eden-ai] configureOtelExporter failed:",
      err instanceof Error ? err.message : String(err),
    );
  });

  return setup;
}

export function isOtelConfigured(): boolean {
  return _configured;
}

/** Test-only: reset the ``_configured`` flag so tests start from a known state. */
export function _resetOtelConfiguredForTests(): void {
  _configured = false;
}
