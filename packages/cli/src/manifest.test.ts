import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LISTING_WITHHELD_BANNER,
  SKILL_NAME,
  listingDraftPath,
  refreshOptedInSurfaces,
  renderListingDraft,
  renderManifest,
  renderSkill,
  skillDescription,
  skillFrontmatterOk,
  skillHashLogPath,
  skillPaths,
} from "./manifest";

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
    expect(md).toContain("- defer_loading: true");
    expect(md).toContain("eden run <name> --issue <id>");
    expect(md).toContain("Summarize review/state/files for one or more PRs");
    // Progressive disclosure: whole manifest is small even with programs.
    expect(md.length).toBeLessThan(2000);
  });

  test("tolerates entries missing names or sequences", () => {
    const md = renderManifest([{ name: undefined, sequence: [] }, { sequence: ["a"] }]);
    expect(md).not.toContain("undefined");
  });
});

describe("skill-native surface (SKILL.md)", () => {
  const sample = [
    { name: "pr_summary", sequence: ["Bash", "Bash"], when_to_use: "Summarize PRs", read_only: true },
    { name: "issue_triage", sequence: ["WebFetch"] },
  ];

  test("frontmatter name+description only; body carries the routine list", () => {
    const md = renderSkill(sample);
    expect(md.startsWith(`---\nname: ${SKILL_NAME}\n`)).toBe(true);
    expect(md).toContain("description: Provides pre-approved workspace routines (pr_summary, issue_triage)");
    const descLine = md.split("\n").find((l) => l.startsWith("description:"))!;
    expect(descLine.length).toBeLessThan(400);
    expect(md).toContain("## pr_summary");
    expect(md).toContain("- safety: read-only");
    expect(md).toContain("Summarize PRs");
  });

  test("empty tool list still renders valid frontmatter", () => {
    const md = renderSkill([]);
    const fm = skillFrontmatterOk(md);
    expect(fm).not.toBeNull();
    expect(fm!.name).toBe("eden-routines");
    expect(fm!.description.length).toBeGreaterThan(0);
    expect(fm!.description.length).toBeLessThanOrEqual(1024);
    expect(md).not.toContain("undefined");
    expect(fm!.description).toMatch(/Applies when/i);
  });

  test("name and description match Agent Skills constraints", () => {
    const md = renderSkill(sample);
    const fm = skillFrontmatterOk(md);
    expect(fm).not.toBeNull();
    expect(fm!.name).toBe("eden-routines");
    expect(fm!.name.length).toBeLessThanOrEqual(64);
    expect(fm!.description.length).toBeLessThanOrEqual(1024);
    expect(fm!.description).toContain("pr_summary");
    expect(fm!.description).toContain("issue_triage");
    expect(fm!.description).toMatch(/replace a multi-step tool loop/i);
    expect(fm!.description).toMatch(/Applies when/i);
    expect(fm!.description).not.toMatch(/<[^>]+>/);
    expect(fm!.description).not.toMatch(/\b(anthropic|claude)\b/i);
    expect(fm!.name).not.toMatch(/\b(anthropic|claude)\b/i);
    // Third person: not an instruction to "you".
    expect(fm!.description).not.toMatch(/^(You |Use this )/);
  });

  test("description stays ≤1024 when many routines are named", () => {
    const tools = Array.from({ length: 80 }, (_, i) => ({ name: `routine_${i}` }));
    const desc = skillDescription(tools);
    expect(desc.length).toBeLessThanOrEqual(1024);
    expect(desc).toContain("routine_0");
    expect(skillFrontmatterOk(renderSkill(tools))).not.toBeNull();
  });

  test("when_to_use appears as a scannable one-liner in the body", () => {
    const md = renderSkill(sample);
    const pr = md.split("## pr_summary")[1]!;
    expect(pr).toContain("Summarize PRs");
    expect(pr).toContain("- replaces: Bash → Bash");
    expect(pr).toContain("- safety: read-only");
  });

  test("island when_to_use is the SKILL.md body, not the stretch dump", () => {
    const line =
      "When the next step is a draftReply judgment after lookupTicket → fetchDetails — one call, do not re-run the loop.";
    const md = renderSkill([
      {
        name: "lookupTicket_to_notify",
        sequence: ["lookupTicket", "fetchDetails", "draftReply", "notify"],
        when_to_use: line,
      },
    ]);
    const body = md.split("## lookupTicket_to_notify")[1]!;
    const oneLiner = body.trim().split("\n")[0];
    expect(oneLiner).toBe(line);
    expect(md).not.toContain("Run the repeating stretch as one tool");
    expect(md).toContain("- replaces: lookupTicket → fetchDetails → draftReply → notify");
  });
});

describe("marketplace listing draft (local, withheld)", () => {
  test("starts with the withheld banner and has no public listing URL", () => {
    const listing = renderListingDraft([{ name: "pr_summary" }]);
    expect(listing.startsWith(LISTING_WITHHELD_BANNER)).toBe(true);
    expect(listing).not.toContain("pr_summary");
    expect(listing).toContain("PUBLIC_CLAIMS");
    expect(listing).not.toMatch(/https?:\/\//i);
    expect(listing).not.toMatch(/skillhub/i);
    expect(listing).not.toMatch(/\/v1\/listings/i);
  });

  test("refuses customer names, SkillHub, and URLs even when tools carry them", () => {
    const listing = renderListingDraft([
      { name: "acme_onboarding", when_to_use: "https://skillhub.ai/acme" },
      { name: "https://example.com/list", sequence: ["SkillHub"] },
    ]);
    expect(listing.startsWith(LISTING_WITHHELD_BANNER)).toBe(true);
    expect(listing).not.toMatch(/https?:\/\//i);
    expect(listing).not.toMatch(/skillhub/i);
    expect(listing).not.toMatch(/\bacme\b/i);
    expect(listing).toMatch(/Customer-approved measured studies: 0/);
  });

  test("refresh writes listing only when SKILL.md already existed", () => {
    const workspace = mkdtempSync(join(tmpdir(), "eden-skill-"));
    const savedHome = process.env.EDEN_HOME;
    const home = mkdtempSync(join(tmpdir(), "eden-home-"));
    process.env.EDEN_HOME = home;
    try {
      const paths = skillPaths(workspace);
      const tools = [{ name: "pr_summary", sequence: ["Bash"], when_to_use: "Summarize PRs", read_only: true }];

      expect(refreshOptedInSurfaces(tools, { workspace })).toEqual({});
      expect(existsSync(paths.skill)).toBe(false);
      expect(existsSync(listingDraftPath())).toBe(false);

      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(paths.skill, "---\nname: eden-routines\ndescription: placeholder\n---\n\nold\n");
      writeFileSync(join(paths.dir, "LISTING.md"), "stale listing in the skill folder\n");
      const out = refreshOptedInSurfaces(tools, { workspace });
      expect(out.skill).toBe(paths.skill);
      expect(readFileSync(paths.skill, "utf8")).toContain("Summarize PRs");
      expect(readFileSync(listingDraftPath(), "utf8").startsWith(LISTING_WITHHELD_BANNER)).toBe(true);
      expect(existsSync(join(paths.dir, "LISTING.md"))).toBe(false);
      expect(readdirSync(paths.dir)).toEqual(["SKILL.md"]);
      const hash = JSON.parse(readFileSync(skillHashLogPath(), "utf8")) as { path: string; sha256: string; at: string };
      expect(hash.path).toBe(paths.skill);
      expect(hash.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(hash.at).toBeTruthy();
    } finally {
      if (savedHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = savedHome;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("eden.tools.md is refreshed only when already present", () => {
    const workspace = mkdtempSync(join(tmpdir(), "eden-toolsmd-"));
    try {
      const paths = skillPaths(workspace);
      const tools = [{ name: "issue_triage", sequence: ["WebFetch"], when_to_use: "Triage issues" }];
      expect(existsSync(paths.toolsMd)).toBe(false);
      refreshOptedInSurfaces(tools, { workspace });
      expect(existsSync(paths.toolsMd)).toBe(false);

      writeFileSync(paths.toolsMd, "# stale\n");
      refreshOptedInSurfaces(tools, { workspace });
      const md = readFileSync(paths.toolsMd, "utf8");
      expect(md).toContain("## issue_triage");
      expect(md).toContain("Triage issues");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
