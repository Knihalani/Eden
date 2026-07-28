/**
 * The coding-agent prompt exists twice: once as a builder here (rendered in
 * the onboarding tour with real credentials substituted) and once inline in
 * the docs site's quickstart, which is a separate Docusaurus build with no
 * shared imports.
 *
 * That duplication is deliberate — wiring the docs site to the portal's
 * credential bridge would mean duplicating a 367-line component instead —
 * but an unguarded copy of a 150-line prompt will rot. This pins the two
 * together structurally, so editing one and forgetting the other fails CI
 * rather than silently shipping two different sets of instructions.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentIntegrationPrompt } from "@/lib/agent-integration-prompt";

const DOCS_QUICKSTART = join(
  __dirname,
  "../../../../docs/docs/quickstart.mdx",
);

function headings(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

describe("agent prompt / docs drift guard", () => {
  const built = buildAgentIntegrationPrompt({
    apiKey: "<your-api-key>",
    orgId: "<your-org-id>",
  });
  const docs = readFileSync(DOCS_QUICKSTART, "utf8");

  it("docs contain the prompt block", () => {
    expect(docs).toContain("Integrate Eden observability into this codebase.");
  });

  it("both copies define the same steps in the same order", () => {
    const fromBuilder = headings(built);
    // The docs file has its own page headings too; keep only the ones that
    // belong to the prompt block.
    const promptStart = docs.indexOf(
      "Integrate Eden observability into this codebase.",
    );
    const promptEnd = docs.indexOf("## What's next");
    const fromDocs = headings(docs.slice(promptStart, promptEnd));

    expect(fromBuilder.length).toBeGreaterThan(0);
    expect(fromDocs).toEqual(fromBuilder);
  });

  it("both copies keep the load-bearing rules verbatim", () => {
    for (const rule of [
      "Do not report success without that",
      "Do not hardcode the key",
      "https://edenobservability.com/traces",
      "npx eden-doctor",
      "python -m eden_sdk.doctor",
      "@eden-ai/sdk",
    ]) {
      expect(built, `builder missing: ${rule}`).toContain(rule);
      expect(docs, `docs missing: ${rule}`).toContain(rule);
    }
  });
});
