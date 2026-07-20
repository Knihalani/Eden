/**
 * Wave 9.3 — portal API client contracts (F48-style).
 * Paths/bodies for debugger / signals / fleet / improve must exist on backend.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { readApiModules } from "./_read-api";

const PORTAL_ROOT = resolve(__dirname, "../../..");
const REPO_ROOT = resolve(PORTAL_ROOT, "../..");

function readPy(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, "src", rel), "utf8");
}

describe("W9.3 debugger / signals / fleet / improve path contracts", () => {
  const api = readApiModules(PORTAL_ROOT);

  it("debuggerApi: path-scoped checkpoints, sessions, no rewind", () => {
    const block =
      api.split("const debuggerApi")[1]?.split("const debugSessionsApi")[0] ?? "";
    expect(block).toContain(
      "/debugger/checkpoints/${encodeURIComponent(traceId)}",
    );
    expect(block).toContain("/debugger/rerun");
    expect(block).not.toContain("rewind");
    expect(api).not.toMatch(/debugger\/rewind/);

    const sessions =
      api.split("const debugSessionsApi")[1]?.split("const browserSessionsApi")[0] ??
      "";
    expect(sessions).toContain("/debugger/sessions?limit=");
    expect(sessions).toContain("/debugger/sessions/${sessionId}");
    expect(sessions).toContain("/compare?run_a=");

    const backend = readPy("eden/api/routes/debugger.py");
    expect(backend).toContain('"/checkpoints/{trace_id}"');
    expect(backend).toContain('"/rerun"');
    expect(backend).toContain('"/sessions"');
    expect(backend).not.toMatch(/\/rewind/);
  });

  it("signalsApi: description create + match + seed-defaults, no compile", () => {
    const block =
      api.split("const signalsApi")[1]?.split("const debuggerApi")[0] ?? "";
    expect(block).toContain("`/orgs/${orgId}/signals`");
    expect(block).toContain("description: string");
    expect(block).toContain("/signals/${signalId}/match");
    expect(block).toContain("/signals/seed-defaults");
    expect(block).not.toContain("compile:");
    expect(block).not.toContain("/compile");

    const backend = readPy("eden/api/routes/signals.py");
    expect(backend).toContain('prefix="/orgs/{org_id}/signals"');
    expect(backend).toContain('"/seed-defaults"');
    expect(backend).toContain('"/{signal_id}/match"');
    expect(backend).not.toMatch(/\/compile/);
  });

  it("fleetApi: summary/heatmap/delegation/sla-breaches match fleet.py", () => {
    const block =
      api.split("export const fleetApi")[1]?.split("export type AgentAuditEvent")[0] ??
      "";
    expect(block).toContain("/fleet/summary");
    expect(block).toContain("/fleet/heatmap");
    expect(block).toContain("/fleet/delegation");
    expect(block).toContain("/fleet/sla-breaches");

    const backend = readPy("eden/api/routes/fleet.py");
    expect(backend).toContain('"/summary"');
    expect(backend).toContain('"/heatmap"');
    expect(backend).toContain('"/delegation"');
    expect(backend).toContain('"/sla-breaches"');
  });

  it("improveApi / plans / runs / scorecard match improve.py + learn.py", () => {
    expect(api).toContain("/improve/queue");
    expect(api).toContain("/improve/items/${encodeURIComponent(itemRef)}/snooze");
    expect(api).toContain("/improve/items/${encodeURIComponent(itemRef)}/approve");
    expect(api).toContain("/improve/plans");
    expect(api).toContain("/improve/plans/${planId}/approve");
    expect(api).toContain("/improve/runs");
    expect(api).toContain("/improve/schedule");
    expect(api).toContain("/improve/scorecard");
    expect(api).toContain("/onboarding/improvement-loop");

    const improve = readPy("eden/api/routes/improve.py");
    expect(improve).toContain('"/queue"');
    expect(improve).toContain('"/plans/{plan_id}/approve"');
    expect(improve).toContain('"/runs"');
    expect(improve).toContain('"/schedule"');
    expect(improve).toContain('"/items/{item_ref:path}/approve"');

    const learn = readPy("eden/api/routes/learn.py");
    expect(learn).toContain('"/improve/scorecard"');
    expect(learn).toContain('"/onboarding/improvement-loop"');
  });
});

describe("W9.3 user behavioural signal contracts", () => {
  const api = readApiModules(PORTAL_ROOT);
  const userBlock =
    api.split("export const userApi")[1]?.split("// ── Intelligence: Outcomes")[0] ??
    "";

  it("only ships live backend signal write paths (no Phase-1-cut phantoms)", () => {
    expect(userBlock).toContain("/intelligence/user/signals/regeneration");
    expect(userBlock).toContain("/intelligence/user/signals/edit-distance");
    expect(userBlock).toContain("/intelligence/user/signals/abandonment");
    expect(userBlock).not.toContain("/signals/return");
    expect(userBlock).not.toContain("/signals/copy-paste");
    expect(userBlock).not.toContain("/signals/retry");
    expect(userBlock).not.toContain("postReturnSignal");
    expect(userBlock).not.toContain("postCopyPasteSignal");
    expect(userBlock).not.toContain("postRetrySignal");

    const backend = readPy("eden/api/routes/intelligence_user.py");
    expect(backend).toContain('"/signals/regeneration"');
    expect(backend).toContain('"/signals/edit-distance"');
    expect(backend).toContain('"/signals/abandonment"');
    expect(backend).not.toContain('@router.post("/signals/return")');
    expect(backend).not.toContain('@router.post("/signals/copy-paste")');
    expect(backend).not.toContain('@router.post("/signals/retry")');
  });

  it("regeneration / edit-distance / abandonment bodies match Pydantic schemas", () => {
    const regen =
      userBlock.split("postRegenerationSignal")[1]?.split("postEditDistanceSignal")[0] ??
      "";
    const edit =
      userBlock.split("postEditDistanceSignal")[1]?.split("postAbandonmentSignal")[0] ??
      "";
    const abandon = userBlock.split("postAbandonmentSignal")[1] ?? "";

    expect(regen).toContain("regenerated?: boolean");
    expect(regen).not.toContain("count: number");
    expect(edit).toContain("model_response: string");
    expect(edit).toContain("final_text: string");
    expect(edit).not.toContain("distance: number");
    expect(abandon).toContain("abandoned?: boolean");

    const backend = readPy("eden/api/routes/intelligence_user.py");
    expect(backend).toContain("regenerated: bool = True");
    expect(backend).toContain("model_response: str");
    expect(backend).toContain("final_text: str");
    expect(backend).toContain("abandoned: bool = True");
  });
});
