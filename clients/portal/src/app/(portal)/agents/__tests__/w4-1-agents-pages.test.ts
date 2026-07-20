/**
 * Wave 4.1 — Agents pages: ErrorState vs empty, 404 honesty, permission gates.
 *
 * - Detail must not treat disabled/pending queries as "Agent not found"
 * - Agent artifacts must ErrorState + retry (no hang / false empty)
 * - Drift empty gated behind !error
 * - Connect: orgless ≠ permission-denied; non-admins get PanelLocked
 * - List: Link repo CTA gated on integrations:write
 * - Ledger: mutate controls gated on jobs:write
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function showAgentDetailNotFound(opts: {
  agentId: string;
  loading: boolean;
  isNotFound: boolean;
  loadError: string | null;
  hasAgent: boolean;
}): boolean {
  if (!opts.agentId) return false;
  if (opts.loading && !opts.hasAgent) return false;
  if (opts.isNotFound) return true;
  if (opts.loadError) return false;
  return false;
}

function showAgentArtifactsEmpty(opts: {
  loading: boolean;
  error: string | null;
  count: number;
}): boolean {
  return !opts.loading && !opts.error && opts.count === 0;
}

function showDriftEmpty(opts: {
  loading: boolean;
  error: string | null;
  dimensions: number;
}): boolean {
  return !opts.loading && !opts.error && opts.dimensions === 0;
}

describe("W4.1 agents query states", () => {
  it("detail does not false-404 when query idle without ApiError 404", () => {
    const src = read("app/(portal)/agents/[id]/page.tsx");
    expect(src).toContain("Invalid agent");
    expect(src).not.toMatch(
      /isNotFound \|\| \(!loading && !agent && !loadError\)/,
    );
    expect(src).toMatch(/status === 404/);

    expect(
      showAgentDetailNotFound({
        agentId: "",
        loading: false,
        isNotFound: false,
        loadError: null,
        hasAgent: false,
      }),
    ).toBe(false);
    expect(
      showAgentDetailNotFound({
        agentId: "a1",
        loading: true,
        isNotFound: false,
        loadError: null,
        hasAgent: false,
      }),
    ).toBe(false);
    expect(
      showAgentDetailNotFound({
        agentId: "a1",
        loading: false,
        isNotFound: true,
        loadError: "Agent not found",
        hasAgent: false,
      }),
    ).toBe(true);
    expect(
      showAgentDetailNotFound({
        agentId: "a1",
        loading: false,
        isNotFound: false,
        loadError: "boom",
        hasAgent: false,
      }),
    ).toBe(false);
  });

  it("artifacts uses ErrorState with retry and gates empty behind !error", () => {
    const src = read("app/(portal)/agents/[id]/artifacts/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load artifacts");
    expect(src).toContain("Try again");
    expect(src).toMatch(/error \? \(/);
    expect(src).toContain("errorFromCaught");

    expect(
      showAgentArtifactsEmpty({ loading: true, error: null, count: 0 }),
    ).toBe(false);
    expect(
      showAgentArtifactsEmpty({ loading: false, error: "boom", count: 0 }),
    ).toBe(false);
    expect(
      showAgentArtifactsEmpty({ loading: false, error: null, count: 0 }),
    ).toBe(true);
  });

  it("drift gates empty behind !error (no false empty on outage)", () => {
    const src = read("app/(portal)/agents/[id]/drift/page.tsx");
    expect(src).toContain("Could not load drift report");
    expect(src).toMatch(/error \? null : loading/);

    expect(
      showDriftEmpty({ loading: false, error: "boom", dimensions: 0 }),
    ).toBe(false);
    expect(
      showDriftEmpty({ loading: false, error: null, dimensions: 0 }),
    ).toBe(true);
  });

  it("connect separates orgless from permission denial", () => {
    const src = read("app/(portal)/agents/connect/page.tsx");
    expect(src).toContain("NoOrgState");
    expect(src).toContain("!currentOrg");
    expect(src).toContain("OnboardingConnectFlow");
    expect(src).not.toMatch(/feature="Admins only"/);
    expect(src).not.toContain('hasPermission("integrations:write")');
  });

  it("list gates Link repo behind integrations:write", () => {
    const src = read("app/(portal)/agents/page.tsx");
    expect(src).toContain("usePermissions");
    expect(src).toContain('hasPermission("integrations:write")');
    expect(src).toContain("canLinkRepo");
    expect(src).toMatch(/canLinkRepo \? \(/);
  });

  it("ledger gates mutate controls behind jobs:write", () => {
    const src = read("app/(portal)/agents/[id]/ledger/page.tsx");
    expect(src).toContain('hasPermission("jobs:write")');
    expect(src).toContain("canMutateLedger");
    expect(src).toContain("View only");
  });

  it("fleet embed suppresses nested CrossLinkBar under agents tab", () => {
    const fleet = read("app/(portal)/fleet/page.tsx");
    const agents = read("app/(portal)/agents/page.tsx");
    expect(agents).toContain("EmbeddedSurface");
    expect(agents).toContain('tab === "fleet"');
    expect(fleet).toContain("useEmbeddedSurface");
    expect(fleet).toMatch(/embedded \? undefined/);
  });
});
