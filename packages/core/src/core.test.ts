import { describe, expect, test } from "bun:test";
import { densifyPayload, densifyValue, undensifyValue, cellsEqual } from "../src/densify";
import { modelFacing } from "../src/compact";
import { parseNamedCli, extractNamedCliCalls } from "../src/named-cli";
import { parameterizeUrl, compileStepUrl, resolveTemplate, githubRestFromCli } from "../src/urls";
import {
  cutIslands,
  fingerprintIsland,
  heuristicName,
  mergeConstantFlip,
  requiredK,
  type ToolEvent,
} from "../src/islands";
import { billableMs, buildDag, layers } from "../src/dag";
import { matchPrefix } from "../src/steer";
import { rewriteBash, compactStdout, compactReadOutput } from "../src/fulfill";
import {
  parseIssueList,
  extractLoopIds,
  planFromBash,
  runFulfillPlan,
  selectMcpTools,
  shortenWhenToUse,
  typedTable,
} from "../src/plan";
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

  test("githubRestFromCli maps gh pr view and gh api", () => {
    const pr = parseNamedCli("gh pr view 170 --json title --repo KaiavN/Eden");
    expect(githubRestFromCli(pr!, "gh pr view 170 --json title --repo KaiavN/Eden")).toBe(
      "https://api.github.com/repos/KaiavN/Eden/pulls/170",
    );
    const api = parseNamedCli("gh api repos/KaiavN/Eden/pulls/170/reviews");
    expect(githubRestFromCli(api!)).toBe("https://api.github.com/repos/KaiavN/Eden/pulls/170/reviews");
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

  test("extractNamedCliCalls unwraps for-loop gh api templates", () => {
    const cmd =
      "for n in 170 169; do\n" +
      "  gh api repos/KaiavN/Eden/pulls/$n\n" +
      "  gh api repos/KaiavN/Eden/pulls/$n/reviews\n" +
      "  gh api repos/KaiavN/Eden/commits/$sha/status\n" +
      "done";
    const calls = extractNamedCliCalls(cmd);
    expect(calls.length).toBe(3);
    const islands = cutIslands([ev({ name: "Bash", command: cmd, args: { command: cmd } })]);
    expect(heuristicName(islands[0])).toBe("github_pr_bundle");
    const quoted =
      `mkdir -p .raw && for n in 170 169 168; do ` +
      `gh api "repos/KaiavN/Eden/pulls/$n" > ".raw/pull-$n.json"; ` +
      `gh api "repos/KaiavN/Eden/pulls/$n/reviews" > ".raw/reviews-$n.json"; ` +
      `sha=$(jq -r .head.sha ".raw/pull-$n.json"); ` +
      `gh api "repos/KaiavN/Eden/commits/$sha/status" > ".raw/status-$n.json"; done`;
    const qCalls = extractNamedCliCalls(quoted);
    expect(qCalls.length).toBe(3);
    const qIslands = cutIslands([ev({ name: "Bash", command: quoted, args: { command: quoted } })]);
    expect(heuristicName(qIslands[0])).toBe("github_pr_bundle");
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

  test("gh pr view with --repo gets a REST source_url", () => {
    const islands = cutIslands([
      ev({
        name: "Bash",
        command: "gh pr view 170 --json title --repo KaiavN/Eden",
        args: { command: "gh pr view 170 --json title --repo KaiavN/Eden" },
      }),
      ev({
        name: "Bash",
        command: "gh api repos/KaiavN/Eden/pulls/170/reviews",
        args: { command: "gh api repos/KaiavN/Eden/pulls/170/reviews" },
      }),
    ]);
    expect(islands[0][0].source_url).toBe("https://api.github.com/repos/KaiavN/Eden/pulls/170");
    expect(islands[0][1].source_url).toContain("/pulls/170/reviews");
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

  test("TaskCreate is not compiled into an island", () => {
    const islands = cutIslands([
      ev({ name: "TaskCreate", args: { description: "x" } }),
      ev({ name: "TaskCreate", args: { description: "y" } }),
      ev({ name: "Bash", command: "gh api repos/KaiavN/Eden/pulls/12", args: { command: "gh api repos/KaiavN/Eden/pulls/12" } }),
    ]);
    expect(islands.every((island) => island.every((s) => s.name !== "TaskCreate"))).toBe(true);
  });

  test("gh auth status is not compiled into a GitHub island", () => {
    const islands = cutIslands([
      ev({
        name: "Bash",
        command: "gh auth status; gh api repos/KaiavN/Eden/pulls/12",
        args: { command: "gh auth status; gh api repos/KaiavN/Eden/pulls/12" },
      }),
      ev({
        name: "Bash",
        command: "gh api repos/KaiavN/Eden/pulls/12/reviews",
        args: { command: "gh api repos/KaiavN/Eden/pulls/12/reviews" },
      }),
    ]);
    expect(islands.flat().every((s) => !String(s.name).includes("auth"))).toBe(true);
    expect(heuristicName(islands[0])).toBe("github_pr_bundle");
  });

  test("git log is not compiled into a GitHub island", () => {
    const islands = cutIslands([
      ev({ name: "Bash", command: "gh api repos/KaiavN/Eden/pulls/12", args: { command: "gh api repos/KaiavN/Eden/pulls/12" } }),
      ev({ name: "Bash", command: "gh api repos/KaiavN/Eden/pulls/12/reviews", args: { command: "gh api repos/KaiavN/Eden/pulls/12/reviews" } }),
      ev({ name: "Bash", command: "git log --oneline", args: { command: "git log --oneline" } }),
    ]);
    expect(islands.length).toBeGreaterThan(0);
    expect(islands.flat().every((s) => s.name !== "git.log")).toBe(true);
    expect(heuristicName(islands[0])).toBe("github_pr_bundle");
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

  test("heuristicName for pull+reviews+status is github_pr_bundle", () => {
    const islands = cutIslands([
      ev({ name: "Bash", command: "gh api repos/KaiavN/Eden/pulls/12", args: { command: "gh api repos/KaiavN/Eden/pulls/12" } }),
      ev({
        name: "Bash",
        command: "gh api repos/KaiavN/Eden/pulls/12/reviews",
        args: { command: "gh api repos/KaiavN/Eden/pulls/12/reviews" },
      }),
      ev({
        name: "Bash",
        command: "gh api repos/KaiavN/Eden/commits/abc123def/status",
        args: { command: "gh api repos/KaiavN/Eden/commits/abc123def/status" },
      }),
    ]);
    expect(heuristicName(islands[0])).toBe("github_pr_bundle");
  });

  test("probe + loop does not duplicate parameterized pull URLs", () => {
    const islands = cutIslands([
      ev({ name: "Bash", command: "gh api repos/KaiavN/Eden/pulls/170", args: { command: "gh api repos/KaiavN/Eden/pulls/170" } }),
      ev({
        name: "Bash",
        command:
          'for n in 170 169; do gh api "repos/KaiavN/Eden/pulls/$n"; gh api "repos/KaiavN/Eden/pulls/$n/reviews"; done',
        args: {
          command:
            'for n in 170 169; do gh api "repos/KaiavN/Eden/pulls/$n"; gh api "repos/KaiavN/Eden/pulls/$n/reviews"; done',
        },
      }),
    ]);
    const urls = islands[0].map((s) => s.source_url).filter(Boolean);
    const parameterized = urls.map((u) => u!.replace(/\/pulls\/\d+/g, "/pulls/{issue}"));
    expect(new Set(parameterized).size).toBe(parameterized.length);
    expect(heuristicName(islands[0])).toBe("github_pr_bundle");
  });

  test("heuristicName prefers bundle when files and reviews are both present", () => {
    const islands = cutIslands([
      ev({ name: "Bash", command: "gh api repos/KaiavN/Eden/pulls/12", args: { command: "gh api repos/KaiavN/Eden/pulls/12" } }),
      ev({
        name: "Bash",
        command: "gh api repos/KaiavN/Eden/pulls/12/reviews",
        args: { command: "gh api repos/KaiavN/Eden/pulls/12/reviews" },
      }),
      ev({
        name: "Bash",
        command: "gh api repos/KaiavN/Eden/pulls/12/files",
        args: { command: "gh api repos/KaiavN/Eden/pulls/12/files" },
      }),
    ]);
    expect(heuristicName(islands[0])).toBe("github_pr_bundle");
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

  test("url {{s1.field}} is a data edge even without bind", () => {
    const steps: CompiledStep[] = [
      { id: "s1", kind: "cloud_http", name: "get", url: "https://x/a", commute: true },
      { id: "s2", kind: "cloud_http", name: "get2", url: "https://x/{{s1.number}}", commute: true },
    ];
    const l = layers(buildDag(steps));
    expect(l.length).toBe(2);
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

  test("k=1 denies the first gh.api once a bundle is live", () => {
    const live = [{ name: "github_pr_bundle", seen: ["gh.api", "gh.api", "gh.api"], required_k: 1 }];
    expect(matchPrefix(live, [], "gh.api").action).toBe("deny");
  });
});

describe("fulfill wrap", () => {
  test("rewriteForLoop parallelizes gh api and keeps original commands", () => {
    const cmd =
      "for n in 170 169 168; do\n" +
      "  gh api repos/KaiavN/Eden/pulls/$n\n" +
      "  gh api repos/KaiavN/Eden/pulls/$n/reviews\n" +
      "  sha=$(gh api repos/KaiavN/Eden/pulls/$n --jq .head.sha)\n" +
      "  gh api repos/KaiavN/Eden/commits/$sha/status\n" +
      "done";
    const r = rewriteBash(cmd);
    expect(r.changed).toBe(true);
    expect(r.kind).toBe("parallel");
    expect(r.command).toContain("wait");
    expect(r.command).toContain("&");
    expect(r.command).toContain("gh api repos/KaiavN/Eden/pulls/$n");
    expect(r.command).toContain("170 169 168");
    expect(r.command).toContain("cat ");
    expect(r.command).not.toContain("fulfill");
    expect(r.command).not.toContain("suffix-must-survive");
    const wrapped = "echo start; " + cmd + "; echo suffix-must-survive";
    const r2 = rewriteBash(wrapped);
    expect(r2.command).toContain("echo start");
    expect(r2.command).toContain("suffix-must-survive");
    expect(r2.command).not.toMatch(/number=\$\{meta%%/);
    const saved = rewriteBash("for n in 170 169; do gh api repos/KaiavN/Eden/pulls/$n > raw/$n.json; done");
    expect(saved.kind).toBe("parallel");
    expect(saved.command).toContain("> raw/$n.json");
    expect(saved.command).toContain("wait");
    expect(saved.command).toContain("cat ");
    expect(rewriteBash("gh api repos/KaiavN/Eden/pulls/170 > raw.json").changed).toBe(false);
    const inner = rewriteBash(
      "for n in 170 169; do gh api repos/x/pulls/$n > p-$n.json; gh api repos/x/pulls/$n/reviews > r-$n.json; done",
    );
    expect(inner.command).toContain("( gh api repos/x/pulls/$n > p-$n.json ) &");
    expect(inner.command).toContain("( gh api repos/x/pulls/$n/reviews > r-$n.json ) &");
  });

  test("single gh api is left alone so probes stay real", () => {
    const r = rewriteBash("gh api repos/KaiavN/Eden/pulls/170");
    expect(r.changed).toBe(false);
    expect(r.command).toBe("gh api repos/KaiavN/Eden/pulls/170");
  });

  test("mutating gh api is left alone", () => {
    const r = rewriteBash("gh api repos/KaiavN/Eden/issues/1/comments --method POST -f body=hi");
    expect(r.changed).toBe(false);
  });

  test("playFor wins over parallel when a live tool exists", () => {
    const cmd = "for n in 170 169; do gh api repos/KaiavN/Eden/pulls/$n; gh api repos/KaiavN/Eden/pulls/$n/reviews; done";
    const r = rewriteBash(cmd, {
      playFor: (kind, issues) => (kind === "bundle" ? `eden play github_pr_bundle --issues ${issues.join(",")}` : null),
    });
    expect(r.kind).toBe("play");
    expect(r.command).toBe("eden play github_pr_bundle --issues 170,169");
  });

  test("compactStdout leaves gh api JSON intact and shrinks bun test", () => {
    const fat = JSON.stringify({
      number: 170,
      title: "fix boot",
      state: "open",
      body: "x".repeat(8000),
      user: { login: "octocat" },
      head: { sha: "abc" },
    });
    const json = compactStdout("gh api repos/x/pulls/170", fat);
    expect(json.stdout).toBe(fat);
    expect(json.stdout).toContain("abc");
    const jq = compactStdout("gh api repos/x/pulls/170 --jq '{number,title}'", '{"number":170,"title":"fix boot"}');
    expect(jq.stdout).toBe('{"number":170,"title":"fix boot"}');
    const testDump =
      Array.from({ length: 40 }, (_, i) => `(pass) some.test.ts > case ${i} [1ms]`).join("\n") +
      "\n  40 pass\n  0 fail\nRan 40 tests across 8 files. [143.00ms]\n";
    const t = compactStdout("bun test", testDump);
    expect(t.stdout).toContain("40 pass");
    expect(t.stdout.length).toBeLessThan(80);
    expect(compactStdout("gh api repos/x/pulls/170", fat).stdout).not.toContain("eden:blob");
    expect(compactStdout("gh api repos/x/pulls/170", fat).stdout).not.toContain("eden recall");
  });

  test("parseIssueList and extractLoopIds", () => {
    expect(parseIssueList("170,169 168")).toEqual(["170", "169", "168"]);
    expect(extractLoopIds("for n in 170 169 168; do gh api repos/x/pulls/$n; done")).toEqual(["170", "169", "168"]);
  });

  test("fulfillBin rewrites the first gh loop and keeps prefix/suffix", () => {
    const cmd =
      "echo start; for n in 170 169; do gh api repos/KaiavN/Eden/pulls/$n > raw/pull-$n.json; done; echo end";
    const r = rewriteBash(cmd, { fulfillBin: "bun cli.ts fulfill" });
    expect(r.kind).toBe("fulfill");
    expect(r.command).toContain("echo start");
    expect(r.command).toContain("echo end");
    expect(r.command).toContain("bun cli.ts fulfill");
    expect(r.command).toContain("--ids 170,169");
    expect(r.command).toContain("--pull-out 'raw/pull-$n.json'");
    expect(r.command).not.toContain("gh api");
  });

  test("compactStdout leaves git log intact", () => {
    const log = "abc1234 init\ndef5678 add shipstat\n";
    const r = compactStdout("git log --oneline", log);
    expect(r.stdout).toBe(log.trim() === log ? log : r.stdout);
    expect(r.stdout).toContain("add shipstat");
    expect(r.stdout).toContain("init");
  });

  test("compactReadOutput keeps GitHub JSON including fat pull payloads", () => {
    const small = JSON.stringify({ number: 170, title: "x", head: { sha: "deadbeef" } });
    const kept = compactReadOutput("raw/pull-170.json", small);
    expect(JSON.parse(kept.stdout).head.sha).toBe("deadbeef");
    const fat = JSON.stringify({ number: 170, title: "x", head: { sha: "deadbeef" }, body: "z".repeat(4000) });
    const packed = compactReadOutput("raw/pull-170.json", fat);
    expect(JSON.parse(packed.stdout).head.sha).toBe("deadbeef");
    expect(packed.stdout).toContain("deadbeef");
  });
});

describe("plan + mcp ranking", () => {
  test("planFromBash captures redirect templates", () => {
    const cmd = [
      "for n in 170 169 168; do",
      "  gh api repos/KaiavN/Eden/pulls/$n > .raw/pull-$n.json || echo fail",
      "  gh api repos/KaiavN/Eden/pulls/$n/reviews > .raw/reviews-$n.json",
      "  gh api repos/KaiavN/Eden/commits/$sha/status > .raw/status-$n.json",
      "done",
    ].join("\n");
    const plan = planFromBash(cmd);
    expect(plan?.repo).toBe("KaiavN/Eden");
    expect(plan?.ids).toEqual(["170", "169", "168"]);
    expect(plan?.reviews).toBe(true);
    expect(plan?.status).toBe(true);
    expect(plan?.pullOut).toBe(".raw/pull-$n.json");
    expect(plan?.reviewsOut).toBe(".raw/reviews-$n.json");
    expect(plan?.statusOut).toBe(".raw/status-$n.json");
  });

  test("planFromBash expands RAW=/dir dests and skips unknown $VAR dests", () => {
    const cmd =
      "RAW=/tmp/shipstat-raw; mkdir -p $RAW; for n in 170 169; do gh api repos/KaiavN/Eden/pulls/$n > $RAW/pull-$n.json; done";
    const plan = planFromBash(cmd);
    expect(plan?.pullOut).toBe("/tmp/shipstat-raw/pull-$n.json");
    expect(
      planFromBash(
        "for n in 170 169; do gh api repos/KaiavN/Eden/pulls/$n > $RAW/pull-$n.json; done",
      ),
    ).toBeNull();
  });

  test("planFromBash reads GraphQL owner/name and does not rewrite redirected graphql", () => {
    const cmd =
      "for n in 170 169; do gh api graphql -f query='query { repository(owner:\"KaiavN\", name:\"Eden\") { pullRequest(number: '$n') { title reviews { totalCount } statusCheckRollup { state } } } }'; done";
    const plan = planFromBash(cmd);
    expect(plan?.repo).toBe("KaiavN/Eden");
    expect(plan?.ids).toEqual(["170", "169"]);
    expect(plan?.reviews).toBe(true);
    expect(plan?.status).toBe(true);
    expect(
      planFromBash(
        "for n in 170 169; do gh api graphql -f query='query { repository(owner:\"KaiavN\", name:\"Eden\") { pullRequest(number: 1) { title } } }' > raw/$n.json; done",
      ),
    ).toBeNull();
  });

  test("runFulfillPlan writes redirect files and a typed int table", async () => {
    const dir = `/tmp/eden-fulfill-${Date.now()}`;
    const { mkdirSync, readFileSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const plan = {
      repo: "KaiavN/Eden",
      ids: ["170", "169"],
      pull: true,
      reviews: true,
      status: true,
      files: true,
      pullOut: `${dir}/pull-$n.json`,
      reviewsOut: `${dir}/reviews-$n.json`,
    };
    const { table, rows } = await runFulfillPlan(plan, async (path) => {
      if (path.endsWith("/reviews") || path.endsWith("/files")) return [{ id: 1 }];
      if (path.includes("/status")) return { state: "success" };
      const n = Number(path.split("/").pop());
      return { number: n, title: `PR ${n}`, head: { sha: `sha${n}` } };
    });
    expect(rows[0].reviews).toBe(1);
    expect(rows[0].files).toBe(1);
    expect(table).toContain("170 | PR 170 | 1 | success | 1");
    expect(JSON.parse(readFileSync(`${dir}/pull-170.json`, "utf8")).head.sha).toBe("sha170");
    expect(JSON.parse(readFileSync(`${dir}/reviews-169.json`, "utf8"))).toHaveLength(1);
  });

  test("typedTable uses integers not English", () => {
    expect(typedTable([{ number: 1, title: "a", reviews: 0, status: "pending" }])).toBe("1 | a | 0 | pending");
  });

  test("selectMcpTools hides github_pr_files when a bundle exists", () => {
    const listed = selectMcpTools([
      { name: "github_pr_files", uses_count: 9 },
      { name: "github_pr_bundle", uses_count: 2 },
    ]);
    expect(listed.map((t) => t.name)).toEqual(["github_pr_bundle"]);
  });

  test("selectMcpTools ranks by uses and evicts unused when more than 3", () => {
    const listed = selectMcpTools([
      { name: "zero_a", uses_count: 0 },
      { name: "hot", uses_count: 9 },
      { name: "zero_b", uses_count: 0 },
      { name: "warm", uses_count: 2 },
      { name: "zero_c", uses_count: 0 },
    ]);
    expect(listed.map((t) => t.name)).toEqual(["hot", "warm"]);
  });

  test("selectMcpTools keeps a small unused set", () => {
    const listed = selectMcpTools([
      { name: "a", uses_count: 0 },
      { name: "b", uses_count: 0 },
    ]);
    expect(listed.map((t) => t.name)).toEqual(["a", "b"]);
  });

  test("shortenWhenToUse caps at 80 chars", () => {
    const s = shortenWhenToUse("x".repeat(200));
    expect(s.length).toBe(80);
    expect(s.endsWith("…")).toBe(true);
  });
});
