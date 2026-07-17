/**
 * Wave 28 — F64 agentic metrics, F34 classifiers, MCP stretch (portal contracts).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const py = (rel: string) =>
  readFileSync(resolve(ROOT, "../../src", rel), "utf8");
const docs = (rel: string) =>
  readFileSync(resolve(ROOT, "../../docs", rel), "utf8");

describe("W28 F64 agentic metrics", () => {
  it("ships service + API + home/fleet surfaces", () => {
    expect(
      existsSync(
        resolve(ROOT, "../../src/eden/evaluation/agentic_metrics/service.py"),
      ),
    ).toBe(true);
    const route = py("eden/api/routes/agentic_metrics.py");
    expect(route).toContain("/agentic-metrics");
    expect(route).toContain("/summary");
    const dash = src("app/(portal)/dashboard/page.tsx");
    expect(dash).toContain("agentic");
    expect(dash).toContain("agenticMetricsSummary");
    const fleet = src("app/(portal)/fleet/page.tsx");
    expect(fleet).toContain("f64-agentic-fleet");
    expect(fleet).toContain("agenticMetricsSummary");
  });

  it("registers agentic_metrics_v1 flag", () => {
    const cfg = py("eden/config.py");
    expect(cfg).toContain("agentic_metrics_v1");
  });
});

describe("W28 F34 classifiers", () => {
  it("wires classifier before investigator + REST lifecycle", () => {
    const consumer = py("eden/workers/trace_finalized_consumer.py");
    expect(consumer).toContain("_run_signal_classifiers");
    expect(consumer).toContain("skip_inv");
    expect(
      existsSync(resolve(ROOT, "../../src/eden/signals/classifier_worker.py")),
    ).toBe(true);
    const routes = py("eden/api/routes/signal_classifiers.py");
    expect(routes).toContain('prefix="/orgs/{org_id}/signals/{signal_id}/classifier"');
    expect(routes).toContain('"/train"');
    expect(routes).toContain('"/promote"');
    expect(routes).toContain('"/shadow-report"');
  });

  it("surfaces classifier savings in FinOps explorer", () => {
    const finops = src(
      "app/(portal)/optimization/_components/finops-explorer.tsx",
    );
    expect(finops).toContain("f34-classifier-savings");
    expect(finops).toContain("classifier_savings_usd");
    const ledger = py("eden/llmops/cost_ledger.py");
    expect(ledger).toContain("signal_classifier");
    expect(ledger).toContain("classifier_savings_usd");
  });

  it("ships migration 112", () => {
    const mig = py("eden/db_migrations/versions/112_w28_f64_f34_mcp.py");
    expect(mig).toContain('down_revision: str = "111_w27_live_labels"');
    expect(mig).toContain("classifier_predictions");
    expect(mig).toContain("investigator_disabled");
  });
});

describe("W28 MCP stretch", () => {
  it("registers eql/sql/eval tools + Streamable HTTP", () => {
    const server = py("eden/mcp_server/server.py");
    expect(server).toContain('"query_eql"');
    expect(server).toContain('"query_sql"');
    expect(server).toContain('"get_agentic_metrics"');
    expect(
      existsSync(resolve(ROOT, "../../src/eden/mcp_server/http_transport.py")),
    ).toBe(true);
    const http = py("eden/mcp_server/http_transport.py");
    expect(http).toContain("streamable-http");
    expect(http).toContain('/v1/mcp');
  });

  it("MCP keys CRUD + Settings UX", () => {
    expect(
      existsSync(resolve(ROOT, "../../src/eden/api/routes/mcp_keys.py")),
    ).toBe(true);
    const mcpTab = src("app/(portal)/settings/_components/mcp-tab.tsx");
    expect(mcpTab).toContain("createMcpKey");
    expect(mcpTab).toContain("query_eql");
    expect(mcpTab).toContain("Streamable HTTP");
    const keysTab = src("app/(portal)/settings/_components/api-keys-tab.tsx");
    expect(keysTab).toContain("mcp:read");
    expect(keysTab).toContain("MCP presets");
  });

  it("docs mention W28 tools / HTTP", () => {
    const guide = docs("docs/how-to/mcp-cursor.md");
    expect(guide).toMatch(/query_eql|Streamable HTTP|get_agentic_metrics/i);
  });
});

describe("W28 U11 topics", () => {
  it("scatter + Act menu on Topics page", () => {
    const page = src("app/(portal)/insights/topics/page.tsx");
    expect(page).toContain("u11-topics-scatter");
    expect(page).toContain("u11-act-menu");
    expect(page).toContain("Create dataset");
    expect(page).toContain("Online rule");
  });
});

describe("W28 tracker honesty", () => {
  it("stamps W28 exit in tracker", () => {
    const tracker = docs("specs/SOTA-WAVE-TRACKER.md");
    expect(tracker).toMatch(/W28.*(GREEN|PARTIAL)|(GREEN|PARTIAL).*W28/i);
  });
});
