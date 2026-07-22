/**
 * Phase 3 Alerts contract — surfaces/alerts.md acceptance.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreNavLeaves } from "@/lib/sidebar-config";
import {
  buildAlertIssueHref,
  buildAlertTraceHref,
  CHANNELS_SETTINGS_HREF,
} from "../_components/alert-links";
import type { AlertRow } from "../_components/alert-types";
import { parseAlertsTab } from "../_components/alert-types";

const portalSrc = path.resolve(__dirname, "../../../..");
const alertsRoot = path.join(portalSrc, "app/(portal)/alerts");
const messagesEn = path.join(portalSrc, "messages/en.json");
const messagesDe = path.join(portalSrc, "messages/de.json");
const nextConfig = path.join(portalSrc, "../next.config.ts");

function walkTsx(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkTsx(full, acc);
    else if (/\.(tsx|ts)$/.test(name)) acc.push(full);
  }
  return acc;
}

const sampleAlert: AlertRow = {
  alertId: "al_1",
  title: "Error rate spike",
  severity: "high",
  status: "open",
  firedAt: new Date().toISOString(),
  agentId: "agent_support",
  traceId: "tr_ab12",
  issueId: "iss_12",
  message: "12 errors in 5m",
  payload: {},
  channels: [],
};

describe("rebuild alerts contract", () => {
  it("required routes and components exist", () => {
    expect(existsSync(path.join(alertsRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(alertsRoot, "loading.tsx"))).toBe(true);
    for (const file of [
      "alerts-toolbar.tsx",
      "inbox-table.tsx",
      "alert-detail-panel.tsx",
      "rules-table.tsx",
      "rule-form.tsx",
      "signals-panel.tsx",
      "alert-detail-sheet.tsx",
    ]) {
      expect(existsSync(path.join(alertsRoot, "_components", file))).toBe(
        true,
      );
    }
  });

  it("supports tab=inbox|rules|signals", () => {
    const src = readFileSync(path.join(alertsRoot, "page.tsx"), "utf8");
    expect(src).toContain('"inbox"');
    expect(src).toContain('"rules"');
    expect(src).toContain('"signals"');
    expect(parseAlertsTab(undefined)).toBe("inbox");
    expect(parseAlertsTab("rules")).toBe("rules");
    expect(parseAlertsTab("signals")).toBe("signals");
    expect(parseAlertsTab("redteam")).toBe("inbox");
  });

  it("wires listAlerts, acknowledge, rules, events, and createRule", () => {
    const page = readFileSync(path.join(alertsRoot, "page.tsx"), "utf8");
    expect(page).toContain("api.listAlerts");
    expect(page).toContain("api.acknowledgeAlert");
    expect(page).toContain("api.acknowledgeAlertsBatch");
    expect(page).toContain("api.getAlertRules");
    expect(page).toContain("api.listAlertEvents");
    expect(page).toContain("nlAlertsApi.createRule");
    expect(page).not.toContain("signalsApi");
  });

  it("signals panel prefers listAlertEvents and not signalsApi threshold library", () => {
    const panel = readFileSync(
      path.join(alertsRoot, "_components/signals-panel.tsx"),
      "utf8",
    );
    expect(panel).not.toContain("signalsApi");
    const page = readFileSync(path.join(alertsRoot, "page.tsx"), "utf8");
    expect(page).toContain("listAlertEvents");
  });

  it("C5 Alert→Trace/Issue retains alertId and preserves filters", () => {
    const params = new URLSearchParams("agentId=agent_support&pastHours=24&q=err");
    const trace = buildAlertTraceHref(sampleAlert, params);
    const issue = buildAlertIssueHref(sampleAlert, params);
    expect(trace).toContain("/traces?");
    expect(trace).toContain("traceId=tr_ab12");
    expect(trace).toContain("alertId=al_1");
    expect(trace).toContain("agentId=agent_support");
    expect(trace).toContain("pastHours=24");
    expect(issue).toContain("/issues/");
    expect(issue).toContain("iss_12");
    expect(issue).toContain("alertId=al_1");
    expect(issue).toContain("pastHours=24");

    const detail = readFileSync(
      path.join(alertsRoot, "_components/alert-detail-panel.tsx"),
      "utf8",
    );
    expect(detail).toContain("alert-open-trace");
    expect(detail).toContain("alert-open-issue");
    // Single Link per exit — ≤2 clicks from list row (select) + button.
    expect((detail.match(/alert-open-trace/g) ?? []).length).toBe(1);
    expect((detail.match(/alert-open-issue/g) ?? []).length).toBe(1);
  });

  it("channels link to settings security stub", () => {
    expect(CHANNELS_SETTINGS_HREF).toBe("/settings?tab=security");
    const detail = readFileSync(
      path.join(alertsRoot, "_components/alert-detail-panel.tsx"),
      "utf8",
    );
    const form = readFileSync(
      path.join(alertsRoot, "_components/rule-form.tsx"),
      "utf8",
    );
    const links = readFileSync(
      path.join(alertsRoot, "_components/alert-links.ts"),
      "utf8",
    );
    expect(detail).toContain("CHANNELS_SETTINGS_HREF");
    expect(form).toContain("CHANNELS_SETTINGS_HREF");
    expect(links).toContain('/settings?tab=security');
  });

  it("hides Silence/Test/Update actions (no API)", () => {
    const files = walkTsx(alertsRoot);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/\bSilence\b/);
      expect(src).not.toMatch(/\bTest rule\b/i);
      expect(src).not.toMatch(/updateAlertRule|silenceAlert|testAlertRule/);
    }
  });

  it("has no red-team tab or attack library UI", () => {
    const files = walkTsx(alertsRoot);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/red-?team/i);
      expect(src).not.toMatch(/attack library/i);
      expect(src).not.toMatch(/adversarial/i);
      expect(src).not.toContain("/redteam");
    }
  });

  it("/signals redirects to /alerts?tab=signals", () => {
    const cfg = readFileSync(nextConfig, "utf8");
    expect(cfg).toContain('source: "/signals"');
    expect(cfg).toContain('destination: "/alerts?tab=signals"');
  });

  it("alerts sidebar href is live /alerts", () => {
    const alerts = getCoreNavLeaves().find((i) => i.id === "alerts");
    expect(alerts?.href).toBe("/alerts");
  });

  it("i18n alerts namespace exists in en and de", () => {
    const en = JSON.parse(readFileSync(messagesEn, "utf8")) as {
      alerts?: { tabs?: Record<string, string> };
    };
    const de = JSON.parse(readFileSync(messagesDe, "utf8")) as {
      alerts?: { tabs?: Record<string, string> };
    };
    expect(en.alerts?.tabs?.inbox).toBeTruthy();
    expect(en.alerts?.tabs?.rules).toBeTruthy();
    expect(en.alerts?.tabs?.signals).toBeTruthy();
    expect(de.alerts?.tabs?.inbox).toBeTruthy();
    expect(de.alerts?.tabs?.rules).toBeTruthy();
    expect(de.alerts?.tabs?.signals).toBeTruthy();
  });

  it("rule form Save CTA is present (accent primary)", () => {
    const form = readFileSync(
      path.join(alertsRoot, "_components/rule-form.tsx"),
      "utf8",
    );
    expect(form).toContain('data-testid="rule-save"');
    expect(form).toContain('t("save")');
  });
});
