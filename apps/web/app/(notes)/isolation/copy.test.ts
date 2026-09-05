import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { claimById } from "@eden/measure";
import { navCurrent } from "../../account/home";
import { ISOLATION_CLAIMS, LIMIT_CLAIMS, LOGGING, OWASP_ROWS, PACK, PACK_ROWS } from "./copy";

const ROOT = join(import.meta.dir, "../../../../../");
const PAGE = readFileSync(join(import.meta.dir, "page.tsx"), "utf8");

test("every isolation claim points at a test file that exists", () => {
  expect(ISOLATION_CLAIMS.length).toBeGreaterThanOrEqual(10);
  for (const row of ISOLATION_CLAIMS) {
    expect(row.claim.endsWith(".")).toBe(true);
    expect(row.claim.includes("\n")).toBe(false);
    expect(existsSync(join(ROOT, row.test)), row.test).toBe(true);
  }
});

test("published limits name every PUBLIC_CLAIMS limit, plus analogue and retired on their own lists", () => {
  expect(LIMIT_CLAIMS.map((r) => r.id)).toEqual([
    "oblivious-long",
    "s1b-analogue",
    "s1b-live-invoice",
    "replica-host-drop",
    "ood-long",
    "cert-bounds",
  ]);
  for (const row of LIMIT_CLAIMS) {
    expect(row.claim.endsWith(".")).toBe(true);
    expect(existsSync(join(ROOT, row.test)), row.test).toBe(true);
    expect(row.test).toBe(claimById(row.id)?.file);
  }
  expect(LIMIT_CLAIMS[0]?.claim).toMatch(/\+2\.8% cents and \+3\.2% wall/);
  expect(LIMIT_CLAIMS[0]?.kind).toBe("limit");
  expect(LIMIT_CLAIMS[0]?.source).toBe("campaign");
  expect(LIMIT_CLAIMS.find((r) => r.id === "s1b-analogue")?.kind).toBe("analogue");
  expect(LIMIT_CLAIMS.find((r) => r.id === "s1b-live-invoice")?.kind).toBe("retired");
  expect(PAGE).toContain("iso-limits");
  expect(PAGE).toContain("iso-limits-analogue");
  expect(PAGE).toContain("iso-limits-retired");
  expect(PAGE).toContain("ClaimTable");
  expect(PAGE).toContain("LIMIT_KEY");
  expect(PAGE.indexOf("iso-limits")).toBeLessThan(PAGE.indexOf("iso-pack"));
  expect(PAGE).not.toContain("{LIMIT_CLAIMS.map");
  const iso = readFileSync(join(ROOT, "docs/isolation.md"), "utf8");
  expect(iso).toMatch(/oblivious-long/);
  expect(iso).toMatch(/\+2\.8% cents/);
  expect(iso).toMatch(/−9\.1% cents \(analogue\)/);
  expect(iso).toMatch(/HOST-DROP\.md/);
  expect(iso).toMatch(/OBLIVIOUS-LONG\.md/);
  expect(iso).toMatch(/ood-long/);
  expect(iso).toMatch(/WITNESS-ECON\.md/);
  expect(iso).not.toMatch(/\| `docs\/ROADMAP\.md` \|/);
  expect(iso).toMatch(/\| Name \| Kind \| Source \|/);
  expect(iso.indexOf("### Limits")).toBeLessThan(iso.indexOf("### Analogue"));
  expect(iso.indexOf("### Analogue")).toBeLessThan(iso.indexOf("### Retired"));
  expect(LIMIT_CLAIMS.find((r) => r.id === "oblivious-long")?.test).toBe(
    "benchmarks/campaign/OBLIVIOUS-LONG.md",
  );
  expect(LIMIT_CLAIMS.find((r) => r.id === "replica-host-drop")?.test).toBe(
    "benchmarks/campaign/HOST-DROP.md",
  );
});

test("OWASP maps all ten MCP ids with a control and a gap", () => {
  const ids = OWASP_ROWS.map((r) => r.id);
  expect(ids).toEqual([
    "MCP01:2025",
    "MCP02:2025",
    "MCP03:2025",
    "MCP04:2025",
    "MCP05:2025",
    "MCP06:2025",
    "MCP07:2025",
    "MCP08:2025",
    "MCP09:2025",
    "MCP10:2025",
  ]);
  for (const row of OWASP_ROWS) {
    expect(row.control.length).toBeGreaterThan(20);
    expect(row.gap.length).toBeGreaterThan(20);
  }
  expect(OWASP_ROWS.find((r) => r.id === "MCP08:2025")?.control).toMatch(/audit export/i);
});

test("logging story is aligned and not a certification badge", () => {
  expect(LOGGING.inForce).toContain("2 August 2026");
  expect(LOGGING.record).toMatch(/approvals/);
  expect(LOGGING.record).toMatch(/versions/);
  expect(LOGGING.record).toMatch(/executions/);
  expect(LOGGING.record).toMatch(/refusals/);
  expect(LOGGING.export).toMatch(/jsonl/);
  expect(LOGGING.export).toMatch(/csv/);
  expect(LOGGING.notClaimed).toMatch(/not claiming high-risk/i);
  expect(LOGGING.notClaimed).toMatch(/not a SOC 2 report/i);
  expect(LOGGING.notClaimed).not.toMatch(/SOC2 ready/i);
  expect(LOGGING.notClaimed).not.toMatch(/certified$/i);
});

test("isolation page is graphite copy, not a rail item, no ship CTA", () => {
  expect(navCurrent("/isolation")).toBe(null);
  expect(PAGE).toContain("iso-doc");
  expect(PAGE).not.toMatch(/className="[^"]*ship/);
  expect(PAGE).not.toMatch(/SOC2 ready/i);
  expect(PAGE).not.toMatch(/signup/);
  expect(PAGE).not.toMatch(/redirect/);
  expect(PAGE).not.toMatch(/sign-in/);
  expect(PAGE).not.toMatch(/from "@clerk/);
  const layout = readFileSync(join(import.meta.dir, "../layout.tsx"), "utf8");
  expect(layout).not.toMatch(/ClerkProvider/);
  expect(layout).not.toMatch(/AppChrome/);
});

test("each isolation claim is the sentence the page prints, not a placeholder", () => {
  expect(ISOLATION_CLAIMS[0]?.claim).toBe(
    "Two workspaces that record the same public-API sequence keep their own cluster rows.",
  );
  expect(ISOLATION_CLAIMS.some((row) => row.claim === "Compiled tools stay scoped to the workspace that recorded them.")).toBe(
    true,
  );
});

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(next));
    else out.push(next);
  }
  return out;
}

function backtickRepoPaths(text: string): string[] {
  const found: string[] = [];
  const re = /`((?:docs|apps|packages|benchmarks)\/[^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[1]!.replace(/[.,;:]+$/, "");
    found.push(raw);
  }
  return found;
}

const PACK_MD = readFileSync(join(ROOT, "docs/evidence-pack.md"), "utf8");
const ISO_MD = readFileSync(join(ROOT, "docs/isolation.md"), "utf8");

test("evidence pack index exists and is a binder an auditor can open", () => {
  expect(existsSync(join(ROOT, PACK.index))).toBe(true);
  expect(PACK_MD.startsWith("# Evidence pack\n\nAligned, not certified.")).toBe(true);
  expect(PACK_MD).toMatch(/not a SOC 2 report/i);
  expect(PACK_MD).toMatch(/isolation tests remain the shipped truth/i);
  expect(PACK_MD).toMatch(/nothing goes live without it/i);
  expect(PACK_MD).toMatch(/eden audit export/);
  expect(PACK_MD).toMatch(/eden audit review/);
  expect(PACK_MD).toMatch(/GET \/v1\/audit/);
  expect(PACK_MD).toMatch(/GET \/v1\/audit\/review/);
  expect(PACK_MD).toMatch(/docs\/ROADMAP\.md/);
  expect(PACK_MD).toMatch(/process\.env\.EDEN_/);
  expect(PACK_MD).toMatch(/EDEN_NET_ALLOW/);
  expect(PACK_MD).toMatch(/docs\/zdr\.md/);
  expect(PACK_MD).toMatch(/docs\/marketplace-draft\.md/);
  expect(PACK_MD).toMatch(/api\.github\.com/);
  expect(PACK_MD).not.toMatch(/SOC2 ready/i);
  expect(PACK_MD).not.toMatch(/SOC 2 ready/i);
  expect(PACK_MD).not.toMatch(/SOC2 certified/i);
  expect(PACK_MD).not.toMatch(/SOC 2 certified/i);
  expect(PACK_MD).not.toMatch(/contact us for/i);
  expect(PACK.lead).toMatch(/aligned, not certified/i);
  expect(PACK.lead).toMatch(/not a SOC 2 report/i);
  expect(PACK.lead).not.toMatch(/SOC2 ready/i);
});

test("every binder path in the pack and isolation notes exists", () => {
  expect(PACK_ROWS.length).toBeGreaterThanOrEqual(8);
  for (const row of PACK_ROWS) {
    expect(existsSync(join(ROOT, row.path)), row.path).toBe(true);
    expect(PACK_MD).toContain(row.path);
  }
  const cited = [...new Set([...backtickRepoPaths(PACK_MD), ...backtickRepoPaths(ISO_MD)])];
  expect(cited.length).toBeGreaterThanOrEqual(10);
  for (const path of cited) {
    expect(existsSync(join(ROOT, path)), path).toBe(true);
  }
});

test("isolation docs and /isolation point at the pack; pool cadence is named", () => {
  expect(ISO_MD).toContain("evidence-pack.md");
  expect(ISO_MD).toMatch(/\/pack/);
  expect(PACK.href).toBe("/pack");
  expect(PAGE).toContain("{PACK.href}");
  expect(ISO_MD).toMatch(/aligned, not certified/i);
  expect(ISO_MD).toMatch(/PUBLIC_POOL_HOSTS/);
  expect(ISO_MD).toMatch(/rcp:/);
  expect(ISO_MD).toMatch(/credential-free/i);
  expect(ISO_MD).toMatch(/GET-ok/);
  expect(ISO_MD).toMatch(/api\.github\.com/);
  expect(ISO_MD).toMatch(/reviewed/);
  expect(ISO_MD).toMatch(/empty list means no public pool/i);
  expect(PACK.pool).toMatch(/PUBLIC_POOL_HOSTS/);
  expect(PACK.pool).toMatch(/api\.github\.com/);
  expect(PACK.pool).toMatch(/credential-free/);
  expect(PACK.pool).toMatch(/reviewed/);
  expect(PAGE).toContain("iso-pack");
  expect(PAGE).toContain("{PACK.lead}");
  expect(PAGE).toContain("{PACK.index}");
  expect(PACK.walk).toMatch(/eden audit review/);
  expect(PACK.walk).toMatch(/EDEN_NET_ALLOW/);
  expect(PAGE).toContain("{PACK_ROWS.map");
  expect(PAGE).not.toMatch(/SOC 2 certified/i);
  expect(PAGE).not.toMatch(/className="[^"]*ship/);
});

test("landing and /proof never mention SOC 2", () => {
  const roots = [
    join(ROOT, "apps/web/app/(marketing)"),
    join(ROOT, "apps/web/app/(notes)/proof"),
  ];
  const hits: string[] = [];
  for (const dir of roots) {
    for (const file of filesUnder(dir)) {
      const text = readFileSync(file, "utf8");
      if (/SOC ?2/i.test(text)) hits.push(file);
    }
  }
  expect(hits).toEqual([]);
});

test("live /pack binder is graphite notes, eight controls, not a cert", () => {
  const packPage = readFileSync(join(import.meta.dir, "../pack/page.tsx"), "utf8");
  expect(navCurrent("/pack")).toBe(null);
  expect(packPage).toContain("iso-doc");
  expect(packPage).toContain("PACK_ROWS.map");
  expect(packPage).not.toMatch(/className="[^"]*ship/);
  expect(packPage).not.toMatch(/SOC2 ready/i);
  expect(packPage).not.toMatch(/SOC 2 certified/i);
  expect(packPage).not.toMatch(/from "@clerk/);
  expect(PACK_ROWS.map((r) => r.control)).toEqual([
    "Isolation",
    "Audit export",
    "Access-review",
    "Human Approve",
    "Kill switches",
    "Doctor allowlist",
    "ZDR guidance",
    "Marketplace draft",
  ]);
  expect(PACK_MD).toMatch(/\/pack/);
});

