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

  const droppedTotal = client.droppedTotal;
  const sampledOut = client.sampledOut;
  const dropSamplingParts: string[] = [
    `droppedTotal=${droppedTotal}`,
    `sampledOut=${sampledOut}`,
  ];
  if (droppedTotal > 0) {
    dropSamplingParts.push(
      "events were evicted from the queue (check maxQueueSize / flush cadence)",
    );
  }
  if (sampledOut > 0) {
    dropSamplingParts.push(
      "events were client-sampled out (check EDEN_SAMPLING_PROFILE)",
    );
  }
  checks.push({
    name: "dropSampling",
    ok: droppedTotal === 0,
    message: dropSamplingParts.join("; "),
    detail: { droppedTotal, sampledOut },
  });

  // S10 sampling posture nudge: warn when the SDK has sent >10k events on
  // the default "full" profile so operators know when to switch to "balanced".
  // "balanced" keeps all P0/P1 signals (errors + slow spans) and downsamples
  // routine traces to ~15%, cutting ingest cost 5–10×.
  const sentTotal = client.sent;
  const samplingProfile = client.samplingProfile;
  const samplingNudgeOk = !(sentTotal > 10_000 && samplingProfile === "full");
  checks.push({
    name: "samplingNudge",
    ok: samplingNudgeOk,
    message: samplingNudgeOk
      ? `samplingProfile="${samplingProfile}" (${sentTotal} events sent)`
      : `High volume (${sentTotal} events) with samplingProfile="full" — ` +
        `consider configure({ samplingProfile: "balanced" }) or ` +
        `EDEN_SAMPLING_PROFILE=balanced to reduce ingest cost 5–10×`,
    detail: { sentTotal, samplingProfile },
  });

  if (emitTestEvent && cfg.orgId && !cfg.disabled) {
    const eventId = `doctor_${randomId()}`;
    const sent0 = client.sent;
    const failed0 = client.failed;
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
    await client.flush();
    const status = client.lastIngestHttpStatus;
    const sentDelta = client.sent - sent0;
    const failedDelta = client.failed - failed0;
    const emitOk = sentDelta > 0 && failedDelta === 0;

    let emitMsg: string;
    if (emitOk) {
      emitMsg = `Emitted test event ${eventId} (HTTP 2xx)`;
    } else if (failedDelta > 0) {
      emitMsg =
        `Test event ${eventId} ingest failed ` +
        `(failed+=${failedDelta}; expect HTTP 2xx)`;
    } else {
      emitMsg =
        `Test event ${eventId} did not confirm HTTP 2xx ` +
        `(sent+=${sentDelta}, failed+=${failedDelta})`;
    }
    checks.push({
      name: "testEvent",
      ok: emitOk,
      message: emitMsg,
      detail: {
        eventId,
        statusCode: status,
        sentDelta,
        failedDelta,
      },
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
