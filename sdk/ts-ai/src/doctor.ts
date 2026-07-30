/**
 * `eden doctor` — validate SDK config and emit a test event.
 */

import { getDefaultClient } from "./client.js";
import { randomId } from "./ids.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export async function runDoctor(opts: {
  emitTestEvent?: boolean;
  timeoutMs?: number;
} = {}): Promise<DoctorReport> {
  const emitTestEvent = opts.emitTestEvent ?? true;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const client = getDefaultClient();
  const cfg = client.getConfig();
  const checks: DoctorCheck[] = [];

  if (cfg.orgId) {
    checks.push({ name: "orgId", ok: true, message: `orgId set (${cfg.orgId})` });
  } else {
    checks.push({
      name: "orgId",
      ok: false,
      message: "Missing orgId — set EDEN_ORG_ID or configure({ orgId })",
    });
  }

  if (cfg.apiKey) {
    checks.push({ name: "apiKey", ok: true, message: "apiKey set" });
  } else {
    checks.push({
      name: "apiKey",
      ok: false,
      message: "Missing apiKey — set EDEN_ORG_API_KEY or configure({ apiKey })",
    });
  }

  checks.push({
    name: "baseUrl",
    ok: true,
    message: `baseUrl=${cfg.baseUrl}`,
    detail: { baseUrl: cfg.baseUrl },
  });

  checks.push({
    name: "gatewayUrl",
    ok: true,
    message: `gatewayUrl=${client.resolvedGatewayUrl()}`,
    detail: { gatewayUrl: client.resolvedGatewayUrl() },
  });

  const enabledOpts = [
    ["exact_cache", cfg.exactCache],
    ["coalesce", cfg.coalesce],
    ["provider_cache_layout", cfg.providerCacheLayout],
    ["response_repair", cfg.responseRepair],
  ]
    .filter(([, on]) => on)
    .map(([name]) => name);
  const disabledOpts = [
    ["exact_cache", cfg.exactCache],
    ["coalesce", cfg.coalesce],
    ["provider_cache_layout", cfg.providerCacheLayout],
    ["response_repair", cfg.responseRepair],
  ]
    .filter(([, on]) => !on)
    .map(([name]) => name);
  let optMsg = `enabled: ${enabledOpts.join(", ") || "none"}`;
  if (disabledOpts.length) optMsg += `; disabled: ${disabledOpts.join(", ")}`;
  checks.push({
    name: "gatewayOptimizations",
    ok: true,
    message: optMsg,
    detail: {
      exactCache: cfg.exactCache,
      coalesce: cfg.coalesce,
      providerCacheLayout: cfg.providerCacheLayout,
      responseRepair: cfg.responseRepair,
    },
  });

  const healthUrl = `${cfg.baseUrl.replace(/\/$/, "")}/health`;
  try {
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers["X-Org-Api-Key"] = cfg.apiKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(healthUrl, { headers, signal: controller.signal });
    clearTimeout(timer);
    checks.push({
      name: "connectivity",
      ok: resp.status < 500,
      message: `GET /health -> ${resp.status}`,
      detail: { statusCode: resp.status },
    });
  } catch (err) {
    checks.push({
      name: "connectivity",
      ok: false,
      message: `Could not reach ${healthUrl}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const sessionOk = Boolean(cfg.orgId && cfg.apiKey && cfg.baseUrl);
  checks.push({
    name: "sessionConfig",
    ok: sessionOk,
    message: sessionOk
      ? "Session ingest path ready (/orgs/{orgId}/ingest/agent-sessions)"
      : "Session config incomplete — need orgId + apiKey + baseUrl",
    detail: {
      endpoint: cfg.orgId && cfg.baseUrl
        ? `${cfg.baseUrl.replace(/\/$/, "")}/orgs/${cfg.orgId}/ingest/agent-sessions`
        : null,
    },
  });

  if (emitTestEvent && cfg.orgId && !cfg.disabled) {
    const eventId = `doctor_${randomId()}`;
    client.emit({
      eventId,
      tenantId: cfg.orgId ?? "default",
      projectId: cfg.projectId,
      traceId: randomId(),
      realm: cfg.realm,
      eventType: "agent.run",
      timestamp: new Date().toISOString(),
      name: "eden.doctor",
      durationMs: 0,
      // Path remaps to webhook; keep semantic label in payload via wire.
      sourceFormat: "webhook",
      payload: { doctor: true, source_format: "eden-sdk-doctor" },
      attributes: { doctor: true },
      tags: ["doctor", "sdk"],
    });
    const rejectedBefore = client.rejectedTotal;
    const flushedOk = await client.flush();
    const status = client.lastIngestHttpStatus;
    // A 2xx is not proof the event was stored — the body carries the
    // per-row outcome, and a fully-rejected batch still returns 200.
    // Keying `ok` off the HTTP status alone meant a customer whose
    // events were being 100% discarded ran `doctor`, was told
    // "ok: true — Emitted test event (HTTP 2xx)", saw nothing in the
    // portal, and filed a bug nobody could reproduce. That is the
    // single worst place in the product for a false all-clear.
    const rejected = client.rejectedTotal - rejectedBefore;
    const stored = flushedOk && rejected === 0;

    let failMsg = `Test event ${eventId} ingest did not confirm HTTP 2xx`;
    if (flushedOk && rejected > 0) {
      failMsg =
        `Test event ${eventId} was accepted by the server but REJECTED ` +
        `as malformed (HTTP 2xx, rejected=${rejected}). Nothing was ` +
        `stored — it will not appear in the portal.`;
    } else if (!flushedOk && (status === 401 || status === 403)) {
      failMsg = `Test event ${eventId} rejected (HTTP ${status}) — check API key / org`;
    } else if (!flushedOk && status != null) {
      failMsg = `Test event ${eventId} ingest did not confirm HTTP 2xx (HTTP ${status})`;
    }
    checks.push({
      name: "testEvent",
      ok: stored,
      message: stored
        ? `Emitted test event ${eventId} (HTTP 2xx, accepted)`
        : failMsg,
      detail: { eventId, statusCode: status, rejected },
    });
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

export async function main(): Promise<number> {
  const report = await runDoctor();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error("\nNo events in 60s? Run `npx @eden-ai/sdk doctor` after configure().");
  }
  return report.ok ? 0 : 1;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
