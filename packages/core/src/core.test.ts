import { describe, expect, test } from "bun:test";
import { densifyPayload, densifyValue, undensifyValue, cellsEqual } from "../src/densify";
import { modelFacing } from "../src/compact";
import { parseNamedCli } from "../src/named-cli";
import { parameterizeUrl, compileStepUrl, resolveTemplate } from "../src/urls";
import {
  cutIslands,
  fingerprintIsland,
  mergeConstantFlip,
  requiredK,
  type ToolEvent,
} from "../src/islands";
import { billableMs, buildDag, layers } from "../src/dag";
import { matchPrefix } from "../src/steer";
import type { CompiledStep } from "../src/types";

function ev(partial: Partial<ToolEvent> & { name: string }): ToolEvent {
  return {
    event_id: partial.event_id ?? crypto.randomUUID(),
    seq: partial.seq ?? 0,
    name: partial.name,
    args: partial.args ?? {},
    ok: partial.ok ?? true,
    command: partial.command,
  };
}

describe("densify", () => {
  test("columnar round-trip equals original JSON cells", () => {
    const original = [
      { id: 1, title: "a", body: "x" },
      { id: 2, title: "b", body: "y" },
      { id: 3, title: "c", body: "z" },
    ];
    const packed = densifyValue(original);
    expect(packed).toEqual({
      keys: ["body", "id", "title"],
      rows: [
        ["x", 1, "a"],
        ["y", 2, "b"],
        ["z", 3, "c"],
      ],
    });
    const back = undensifyValue(packed);
    expect(cellsEqual(back, original)).toBe(true);
  });

  test("strips ansi and duplicate blanks, keeps text", () => {
    const text = "hello\x1b[31mred\x1b[0m\n\n\nworld  \n";
    const { densified } = densifyPayload(text);
    expect(densified).toBe("hellored\n\nworld");
  });

  test("invoice uses smaller densified bytes", () => {
    const fat = Array.from({ length: 20 }, (_, i) => ({
      login: "octocat",
      id: i,
      type: "User",
      site_admin: false,
    }));
    const { raw_bytes, densified_bytes } = densifyPayload(fat);
    expect(densified_bytes).toBeLessThan(raw_bytes);
  });

  test("parameterizeUrl turns ids into params", () => {
    expect(parameterizeUrl("https://api.github.com/repos/acme/app/issues/12/comments")).toBe(
      "https://api.github.com/repos/acme/app/issues/{issue}/comments",
    );
  });

  test("compileStepUrl keeps gh api path and never emits a bare host", () => {
    expect(
      compileStepUrl({
        source_url: "https://api.github.com/repos/acme/app/commits/abc123/status",
      }),
    ).toBe("https://api.github.com/repos/acme/app/commits/{sha}/status");
    expect(compileStepUrl({ rewrite_host: "api.github.com" })).toBeUndefined();
  });

  test("resolveTemplate fills params and prior-step binds", () => {
    expect(
      resolveTemplate("{origin}/issues/{{s1.number}}", { origin: "https://x" }, { s1: { number: 12 } }),
    ).toBe("https://x/issues/12");
  });

  test("modelFacing returns facts not full bodies", () => {
    const bundle = {
      s1: { title: "Cannot deploy widget 12", body: "x".repeat(2000), number: 12, state: "open" },
      s2: Array.from({ length: 12 }, (_, i) => ({ id: i, body: "c".repeat(400) })),
    };
    const facing = modelFacing(bundle);
    expect(facing.text.length).toBeLessThan(JSON.stringify(bundle).length / 4);
    expect(facing.text).toContain("Cannot deploy widget 12");
    expect(facing.text).not.toContain("x".repeat(100));
  });
});

describe("named cli", () => {
  test("gh api keeps path as positional", () => {
    const p = parseNamedCli("gh api repos/acme/app/commits/abc123/status");
    expect(p?.subcommand).toBe("api");
    expect(p?.positionals[0]).toBe("repos/acme/app/commits/abc123/status");
  });

  test("gh pr create", () => {
    const p = parseNamedCli(`gh pr create --title "hi" --body "x" --base main`);
    expect(p?.family).toBe("gh");
    expect(p?.subcommand).toBe("pr.create");
    expect(p?.rewrite_host).toBe("api.github.com");
  });

  test("git commit is not named", () => {
    expect(parseNamedCli(`git commit -m "wip"`)).toBeNull();
  });

  test("ls is generic", () => {
    expect(parseNamedCli("ls -la")).toBeNull();
  });
});

describe("islands", () => {
  test("gh+curl inside a Read-Edit turn drafts; Edit loop does not", () => {
    const events = [
      ev({ name: "Read", args: { file_path: "src/app.ts" } }),
      ev({ name: "Edit", args: { file_path: "src/app.ts", old_string: "a".repeat(500), new_string: "b".repeat(500) } }),
      ev({ name: "Bash", command: "gh pr view 12 --json title,body", args: { command: "gh pr view 12 --json title,body" } }),
      ev({ name: "Bash", command: "curl https://api.github.com/repos/acme/app/issues/12/comments", args: { command: "curl https://api.github.com/repos/acme/app/issues/12/comments" } }),
      ev({ name: "Bash", command: "gh api repos/acme/app/commits/abc/status", args: { command: "gh api repos/acme/app/commits/abc/status" } }),
      ev({ name: "Edit", args: { file_path: "src/app.ts", old_string: "c".repeat(500), new_string: "d".repeat(500) } }),
    ];
    const islands = cutIslands(events);
    expect(islands.length).toBe(1);
    expect(islands[0].length).toBe(3);
    expect(islands[0].every((s) => s.kind === "cloud_http")).toBe(true);
    expect(islands[0][2].source_url).toContain("api.github.com/repos/acme/app/commits");
  });

  test("product SDK verbs form an island", () => {
    const events = [
      ev({ name: "get_issue", args: { issue: "12" } }),
      ev({ name: "list_comments", args: { issue: "12" } }),
      ev({ name: "get_pull", args: { issue: "12" } }),
    ];
    const islands = cutIslands(events);
    expect(islands.length).toBe(1);
    expect(islands[0].length).toBe(3);
    expect(islands[0].every((s) => s.kind === "cloud_http")).toBe(true);
  });

  test("pure ls island does not knock", () => {
    const events = [
      ev({ name: "Bash", command: "ls", args: { command: "ls" } }),
      ev({ name: "Bash", command: "ls -la", args: { command: "ls -la" } }),
    ];
    expect(cutIslands(events)).toEqual([]);
  });

  test("constant-flip becomes params and same fingerprint names", () => {
    const a = cutIslands([
      ev({ name: "Bash", command: "gh pr view 1", args: { command: "gh pr view 1", number: "1" } }),
      ev({ name: "Bash", command: "curl https://example.com/a", args: { command: "curl https://example.com/a" } }),
    ]);
    const b = cutIslands([
      ev({ name: "Bash", command: "gh pr view 2", args: { command: "gh pr view 2", number: "2" } }),
      ev({ name: "Bash", command: "curl https://example.com/b", args: { command: "curl https://example.com/b" } }),
    ]);
    expect(a.length).toBe(1);
    const merged = mergeConstantFlip(a[0], b[0]);
    expect(merged).not.toBeNull();
  });

  test("commute-safe GET order still fingerprints equal", () => {
    const a = cutIslands([
      ev({ name: "Bash", command: "curl https://api.github.com/a", args: { command: "curl https://api.github.com/a" } }),
      ev({ name: "Bash", command: "curl https://api.github.com/b", args: { command: "curl https://api.github.com/b" } }),
    ]);
    const b = cutIslands([
      ev({ name: "Bash", command: "curl https://api.github.com/b", args: { command: "curl https://api.github.com/b" } }),
      ev({ name: "Bash", command: "curl https://api.github.com/a", args: { command: "curl https://api.github.com/a" } }),
    ]);
    expect(fingerprintIsland(a[0])).toBe(fingerprintIsland(b[0]));
  });

  test("required_k is 1 when first is a named gh verb", () => {
    const islands = cutIslands([
      ev({ name: "Bash", command: "gh pr view 1", args: { command: "gh pr view 1" } }),
      ev({ name: "Bash", command: "curl https://api.github.com/x", args: { command: "curl https://api.github.com/x" } }),
    ]);
    expect(requiredK(islands[0])).toBe(1);
  });
});

describe("dag + billing", () => {
  test("independent cloud steps form one parallel layer", () => {
    const steps: CompiledStep[] = [
      { id: "s1", kind: "cloud_http", name: "a", url: "https://x/a", commute: true },
      { id: "s2", kind: "cloud_http", name: "b", url: "https://x/b", commute: true },
    ];
    const l = layers(buildDag(steps));
    expect(l.length).toBe(1);
    expect(l[0].length).toBe(2);
  });

  test("write stays after data edge", () => {
    const steps: CompiledStep[] = [
      { id: "s1", kind: "cloud_http", name: "get", url: "https://x/a", commute: true },
      { id: "s2", kind: "cloud_http", name: "post", url: "https://x/b", bind: { id: "{{s1.id}}" }, commute: false },
    ];
    const l = layers(buildDag(steps));
    expect(l.length).toBe(2);
    expect(l[0][0].id).toBe("s1");
    expect(l[1][0].id).toBe("s2");
  });

  test("billable_ms uses densified bytes", () => {
    expect(billableMs({ server_ms: 150, steps_attempted: 6, densified_bytes: 8000 })).toBe(150 + 150 + 40);
  });
});

describe("steer", () => {
  test("denies from step 1 when k=2 matches prefix", () => {
    const live = [{ name: "file_pr", seen: ["gh.pr.view", "curl.get"], required_k: 2 }];
    expect(matchPrefix(live, ["gh.pr.view"], "curl.get").action).toBe("deny");
    expect(matchPrefix(live, [], "gh.pr.view").action).toBe("allow");
  });

  test("matches island after earlier Read/Bash in the same run", () => {
    const live = [{ name: "file_pr", seen: ["gh.pr.view", "curl.get"], required_k: 2 }];
    expect(matchPrefix(live, ["Read", "gh.pr.view"], "curl.get").action).toBe("deny");
  });
});
