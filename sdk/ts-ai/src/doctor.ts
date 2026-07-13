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
      sourceFormat: "eden-sdk-doctor",
      payload: { doctor: true },
      attributes: { doctor: true },
      tags: ["doctor", "sdk"],
    });
    await client.flush();
    checks.push({
      name: "testEvent",
      ok: true,
      message: `Emitted test event ${eventId}`,
      detail: { eventId },
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
