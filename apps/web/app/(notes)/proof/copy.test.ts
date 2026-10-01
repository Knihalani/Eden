import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  PUBLIC_CLAIMS,
  claimsOf,
  customerStudies,
  fixtureStudies,
} from "@eden/measure";
import { navCurrent } from "../../account/home";
import sitemap from "../../sitemap";
import {
  ANALOGUE,
  CASES_LEAD,
  CUSTOMERS,
  FIXTURES,
  LIMITS,
  PARITY,
  PROOF_COUNTS,
  PROOF_LEAD,
  PROOF_NOT,
  RETIRED,
  WINS,
} from "./copy";

const ROOT = join(import.meta.dir, "../../../../../");
/** Page source as JSX renders its text: Prettier may wrap a phrase over two lines. */
const prose = (src: string) => src.replace(/\s+/g, " ");

const PAGE = readFileSync(join(import.meta.dir, "page.tsx"), "utf8");
const TABLE = readFileSync(join(import.meta.dir, "../claim-table.tsx"), "utf8");
const COPY = readFileSync(join(import.meta.dir, "copy.ts"), "utf8");
const WHITEPAPER = readFileSync(join(ROOT, "docs/whitepaper.md"), "utf8");
const CASES = readFileSync(join(ROOT, "docs/cases.md"), "utf8");

test("every printed claim comes from PUBLIC_CLAIMS", () => {
  expect(WINS).toEqual(claimsOf("win"));
  expect(PARITY).toEqual(claimsOf("parity"));
  expect(ANALOGUE).toEqual(claimsOf("analogue"));
  expect(LIMITS).toEqual(claimsOf("limit"));
  expect(RETIRED).toEqual(claimsOf("retired"));
  expect(FIXTURES).toEqual(fixtureStudies());
  expect(CUSTOMERS).toEqual(customerStudies());
  expect(CUSTOMERS).toEqual([]);
  const printed = [...WINS, ...PARITY, ...ANALOGUE, ...LIMITS, ...RETIRED];
  expect(printed.length).toBe(PUBLIC_CLAIMS.length);
  for (const row of printed) {
    const src = PUBLIC_CLAIMS.find((c) => c.id === row.id);
    expect(src).toEqual(row);
    expect(existsSync(join(ROOT, row.file)) || row.kind === "retired" || row.source === "host-limit").toBe(
      true,
    );
  }
});

test("page maps statement and file, iso-doc, no ship CTA", () => {
  expect(navCurrent("/proof")).toBe(null);
  expect(PAGE).toContain("iso-doc");
  expect(PAGE).toContain("Workspace notes");
  expect(PAGE).toContain("<h1>Proof</h1>");
  expect(PAGE).toContain("ClaimTable");
  expect(TABLE).toContain("{row.statement}");
  expect(TABLE).toContain("{row.file}");
  expect(TABLE).toContain("{row.printed}");
  expect(TABLE).toContain("{row.kind}");
  expect(TABLE).toContain("{row.source}");
  expect(TABLE).toContain("<th>Kind</th>");
  expect(TABLE).toContain("<th>Source</th>");
  expect(PAGE).toContain("{PROOF_COUNTS}");
  expect(PAGE).toContain("eden claims");
  expect(TABLE).toContain("iso-table");
  expect(PAGE).toContain("{CUSTOMERS.length}");
  expect(prose(PAGE)).not.toMatch(/Arc 8/);
  expect(PAGE).not.toMatch(/className="[^"]*ship/);
  expect(PAGE).not.toMatch(/signup/i);
  expect(prose(PAGE)).not.toMatch(/Sign up/);
  expect(PAGE).not.toMatch(/redirect/);
  expect(PAGE).not.toMatch(/sign-in/);
  expect(PAGE).not.toMatch(/from "@clerk/);
  expect(PAGE).not.toMatch(/6\.67|−9\.1|\+2\.8%/);
  const layout = readFileSync(join(import.meta.dir, "../layout.tsx"), "utf8");
  expect(layout).not.toMatch(/ClerkProvider/);
  expect(layout).not.toMatch(/AppChrome/);
});

test("section order is wins, parity, analogue, limits, retired, then cases", () => {
  const wins = PAGE.indexOf("proof-wins");
  const parity = PAGE.indexOf("proof-parity");
  const analogue = PAGE.indexOf("proof-analogue");
  const limits = PAGE.indexOf("proof-limits");
  const retired = PAGE.indexOf("proof-retired");
  const cases = PAGE.indexOf("proof-cases");
  expect(wins).toBeGreaterThan(-1);
  expect(wins).toBeLessThan(parity);
  expect(parity).toBeLessThan(analogue);
  expect(analogue).toBeLessThan(limits);
  expect(limits).toBeLessThan(retired);
  expect(retired).toBeLessThan(cases);
});

test("counts line matches the tables", () => {
  expect(PROOF_COUNTS).toMatch(/0 customers/);
  expect(PROOF_COUNTS).toMatch(/limits/);
  expect(PROOF_COUNTS).toMatch(/analogue/);
});

test("lead is methodology; honesty lines sit beside it", () => {
  expect(PROOF_LEAD).toMatch(/paired/i);
  expect(PROOF_LEAD).toMatch(/counterbalanced/i);
  expect(PROOF_LEAD).toMatch(/A\/A/);
  expect(PROOF_LEAD).toMatch(/±1%/);
  expect(PROOF_LEAD).toMatch(/\bWIN\b/);
  expect(PROOF_LEAD).toMatch(/\bLOSS\b/);
  expect(PROOF_LEAD).toMatch(/cites the file/);
  expect(PROOF_LEAD).not.toMatch(/links the file/);
  expect(PROOF_NOT).toMatch(/UNCERTIFIED is never a win/);
  expect(PROOF_NOT).toMatch(/not a live Claude Code invoice/);
  expect(PROOF_NOT).toMatch(/analogue/i);
  expect(COPY).not.toMatch(/6\.67|1\.36×|5\.14×/);
});

test("analogue, oblivious-long, invoice, host-drop land in the right tables", () => {
  const analogue = ANALOGUE.find((c) => c.id === "s1b-analogue");
  expect(analogue?.kind).toBe("analogue");
  expect(analogue?.source).toBe("analogue-headless");
  expect(analogue?.statement).toMatch(/analogue/i);
  expect(analogue?.statement).toMatch(/not a live Claude Code invoice/i);
  expect(WINS.some((c) => c.id === "s1b-analogue")).toBe(false);
  expect(WINS.some((c) => c.source === "analogue-headless")).toBe(false);
  expect(WINS.some((c) => c.id === "oblivious-long")).toBe(false);
  expect(LIMITS.find((c) => c.id === "oblivious-long")?.kind).toBe("limit");
  expect(LIMITS.some((c) => c.id === "jit-soak")).toBe(false);
  expect(WINS.find((c) => c.id === "jit-soak")?.printed).toBe("PASS precision=1.000 n=38");
  expect(RETIRED.find((c) => c.id === "s1b-live-invoice")?.kind).toBe("retired");
  const host = LIMITS.find((c) => c.id === "replica-host-drop");
  expect(host?.name).toBe("replica host-drop");
  expect(host?.name).not.toMatch(/live host-drop/i);
  expect(host?.source).toBe("host-limit");
  expect(host?.statement).toMatch(/host limit/i);
  expect(WINS.some((c) => /UNCERTIFIED/i.test(c.statement))).toBe(false);
});

test("fixture studies are campaign measurements; customer studies stay 0", () => {
  expect(FIXTURES.map((c) => c.vertical).sort()).toEqual(["desk", "etl", "incident", "orders", "support"]);
  expect(FIXTURES.every((c) => c.source === "campaign" && c.kind === "win")).toBe(true);
  expect(CASES_LEAD).toMatch(/campaign fixture/i);
  expect(CASES_LEAD).toMatch(/not customers/);
  expect(CASES_LEAD).toMatch(/: 0/);
  expect(CASES_LEAD).toMatch(/same table chrome/i);
  expect(PAGE).toContain("fromFixtures(FIXTURES)");
  expect(PAGE).toContain("ClaimTable");
  expect(PAGE).toContain("CLASS_KEY");
  expect(PAGE).toContain("tag: \"fixture\"");
  expect(PAGE).toContain("Fixture verticals");
  expect(PAGE).not.toContain("<h2 id=\"proof-cases\">Case studies</h2>");
  expect(TABLE).toContain("<th>Kind</th>");
  expect(TABLE).toContain("<th>Source</th>");
  expect(TABLE).toContain("iso-tag");
  expect(CUSTOMERS.length).toBe(0);
});

test("whitepaper and cases map PUBLIC_CLAIMS statements and files", () => {
  for (const row of PUBLIC_CLAIMS) {
    expect(WHITEPAPER).toContain(row.statement);
    expect(WHITEPAPER).toContain(row.file);
  }
  for (const row of FIXTURES) {
    expect(CASES).toContain(row.statement);
    expect(CASES).toContain(row.file);
    expect(CASES).toMatch(/\| Kind \| Source \|/);
    expect(CASES).toMatch(new RegExp(`${row.vertical}.*Campaign measurement`, "s"));
  }
  expect(CASES).toMatch(/Customer-approved measured studies: \*\*0\*\*/);
  expect(CASES).not.toMatch(/Acme|Stripe|Notion|Globex/i);
  expect(WHITEPAPER).not.toMatch(/Arc 8/);
});

test("sitemap lists public notes only; middleware treats /proof as notes", () => {
  const urls = sitemap().map((e) => e.url);
  expect(urls.some((u) => u.endsWith("/proof"))).toBe(true);
  expect(urls.some((u) => u.endsWith("/isolation"))).toBe(true);
  expect(urls.some((u) => u.endsWith("/pack"))).toBe(true);
  expect(urls.every((u) => !/\/(home|workspace|setup|tour)(\/|$)/.test(u))).toBe(true);
  const mw = readFileSync(join(import.meta.dir, "../../../middleware.ts"), "utf8");
  expect(mw).toMatch(/\/proof\(\.\*\)/);
  expect(mw).toMatch(/\/pack\(\.\*\)/);
  expect(mw).toMatch(/proof\(\?:\/\|\$\)/);
  expect(mw).toMatch(/pack\(\?:\/\|\$\)/);
  const form = readFileSync(join(import.meta.dir, "../../workspace/form.tsx"), "utf8");
  expect(form).toMatch(/href="\/proof"/);
  expect(form).toMatch(/href="\/isolation"/);
  expect(form).toMatch(/href="\/pack"/);
});
