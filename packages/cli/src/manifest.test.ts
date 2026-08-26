import { describe, expect, test } from "bun:test";
import { renderManifest, renderSkill } from "./manifest";

describe("filesystem manifest (surfacing via the repo, not a transport)", () => {
  test("renders one ~compact block per program with replaces-chain and safety class", () => {
    const md = renderManifest([
      {
        name: "pr_summary",
        sequence: ["Bash", "Bash", "Bash"],
        when_to_use: "Summarize review/state/files for one or more PRs",
        read_only: true,
      },
      { name: "issue_triage", sequence: ["WebFetch", "Bash"], read_only: false },
    ]);
    expect(md).toContain("## pr_summary");
    expect(md).toContain("replaces: Bash → Bash → Bash");
    expect(md).toContain("- safety: read-only");
    expect(md).toContain("## issue_triage");
    expect(md).toContain("- safety: asks-first");
    expect(md).toContain("eden run <name> --issue <id>");
    // Progressive disclosure: whole manifest is small even with programs.
    expect(md.length).toBeLessThan(2000);
  });

  test("tolerates entries missing names or sequences", () => {
    const md = renderManifest([{ name: undefined, sequence: [] }, { sequence: ["a"] }]);
    expect(md).not.toContain("undefined");
  });
});

describe("skill-native surface (SKILL.md)", () => {
  test("frontmatter name+description only; body carries the routine list", () => {
    const md = renderSkill([
      { name: "pr_summary", sequence: ["Bash", "Bash"], when_to_use: "Summarize PRs", read_only: true },
      { name: "issue_triage", sequence: ["WebFetch"] },
    ]);
    expect(md.startsWith("---\nname: eden-routines\n")).toBe(true);
    expect(md).toContain("description: Pre-approved workspace routines (pr_summary, issue_triage)");
    // Progressive disclosure: the description line is what loads at startup.
    const descLine = md.split("\n").find((l) => l.startsWith("description:"))!;
    expect(descLine.length).toBeLessThan(400);
    expect(md).toContain("## pr_summary");
    expect(md).toContain("- safety: read-only");
  });

  test("empty tool list still renders valid frontmatter", () => {
    const md = renderSkill([]);
    expect(md).toContain("description: Pre-approved workspace routines.");
    expect(md).not.toContain("undefined");
  });
});
