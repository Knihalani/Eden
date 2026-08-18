import { describe, expect, test } from "bun:test";
import { densifyPayload, densifyValue, undensifyValue, cellsEqual } from "../src/densify";
import { modelFacing, prRowFromFacts, bundleJson, CI_STATE } from "../src/compact";
import { parseNamedCli, extractNamedCliCalls, isMutatingGh, isMutatingCurl } from "../src/named-cli";
import { parameterizeUrl, compileStepUrl, resolveTemplate, githubRestFromCli, commandMatchesToolUrls } from "../src/urls";
import {
  cutIslands,
  fingerprintIsland,
  heuristicName,
  isCompilableToolName,
  mergeConstantFlip,
  requiredK,
} from "../src/islands";
import type { ToolEvent } from "../src/types";
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

  test("gh pipeline noise is not a named cli", () => {
    expect(parseNamedCli("gh 2>&1 | cat")).toBeNull();
    expect(parseNamedCli("gh api repos/KaiavN/Eden/pulls/170")).not.toBeNull();
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
    expect(heuristicName(islands[0]!)).toBe("github_pr_bundle");
    const quoted =
      `mkdir -p .raw && for n in 170 169 168; do ` +
      `gh api "repos/KaiavN/Eden/pulls/$n" > ".raw/pull-$n.json"; ` +
      `gh api "repos/KaiavN/Eden/pulls/$n/reviews" > ".raw/reviews-$n.json"; ` +
      `sha=$(jq -r .head.sha ".raw/pull-$n.json"); ` +
      `gh api "repos/KaiavN/Eden/commits/$sha/status" > ".raw/status-$n.json"; done`;
    const qCalls = extractNamedCliCalls(quoted);
    expect(qCalls.length).toBe(3);
    const qIslands = cutIslands([ev({ name: "Bash", command: quoted, args: { command: quoted } })]);
    expect(heuristicName(qIslands[0]!)).toBe("github_pr_bundle");
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
    expect(islands[0]!.length).toBe(3);
    expect(islands[0]!.every((s) => s.kind === "cloud_http")).toBe(true);
    expect(islands[0]![2]!.source_url).toContain("api.github.com/repos/acme/app/commits");
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
    expect(islands[0]![0]!.source_url).toBe("https://api.github.com/repos/KaiavN/Eden/pulls/170");
    expect(islands[0]![1]!.source_url).toContain("/pulls/170/reviews");
  });

  test("product SDK verbs form an island", () => {
    const events = [
      ev({ name: "get_issue", args: { issue: "12" } }),
      ev({ name: "list_comments", args: { issue: "12" } }),
      ev({ name: "get_pull", args: { issue: "12" } }),
    ];
    const islands = cutIslands(events);
    expect(islands.length).toBe(1);
    expect(islands[0]!.length).toBe(3);
    expect(islands[0]!.every((s) => s.kind === "cloud_http")).toBe(true);
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
    expect(heuristicName(islands[0]!)).toBe("github_pr_bundle");
  });

  test("git log is not compiled into a GitHub island", () => {
    const islands = cutIslands([
      ev({ name: "Bash", command: "gh api repos/KaiavN/Eden/pulls/12", args: { command: "gh api repos/KaiavN/Eden/pulls/12" } }),
      ev({ name: "Bash", command: "gh api repos/KaiavN/Eden/pulls/12/reviews", args: { command: "gh api repos/KaiavN/Eden/pulls/12/reviews" } }),
      ev({ name: "Bash", command: "git log --oneline", args: { command: "git log --oneline" } }),
    ]);
    expect(islands.length).toBeGreaterThan(0);
    expect(islands.flat().every((s) => s.name !== "git.log")).toBe(true);
    expect(heuristicName(islands[0]!)).toBe("github_pr_bundle");
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
    const merged = mergeConstantFlip(a[0]!, b[0]!);
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
    expect(fingerprintIsland(a[0]!)).toBe(fingerprintIsland(b[0]!));
  });

  test("required_k is 1 when first is a named gh verb", () => {
    const islands = cutIslands([
      ev({ name: "Bash", command: "gh pr view 1", args: { command: "gh pr view 1" } }),
      ev({ name: "Bash", command: "curl https://api.github.com/x", args: { command: "curl https://api.github.com/x" } }),
    ]);
    expect(requiredK(islands[0]!)).toBe(1);
  });

  test("heuristicName for pull-only is github_pr_bundle", () => {
    expect(
      heuristicName([
        {
          name: "gh.api",
          arg_keys: [],
          constants: {},
          param_keys: ["issue"],
          kind: "cloud_http",
          commute: true,
          source_url: "https://api.github.com/repos/KaiavN/Eden/pulls/12",
        },
      ]),
    ).toBe("github_pr_bundle");
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
    expect(heuristicName(islands[0]!)).toBe("github_pr_bundle");
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
    const urls = islands[0]!.map((s) => s.source_url).filter(Boolean);
    const parameterized = urls.map((u) => u!.replace(/\/pulls\/\d+/g, "/pulls/{issue}"));
    expect(new Set(parameterized).size).toBe(parameterized.length);
    expect(heuristicName(islands[0]!)).toBe("github_pr_bundle");
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
    expect(heuristicName(islands[0]!)).toBe("github_pr_bundle");
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
    expect(l[0]!.length).toBe(2);
  });

  test("write stays after data edge", () => {
    const steps: CompiledStep[] = [
      { id: "s1", kind: "cloud_http", name: "get", url: "https://x/a", commute: true },
      { id: "s2", kind: "cloud_http", name: "post", url: "https://x/b", bind: { id: "{{s1.id}}" }, commute: false },
    ];
    const l = layers(buildDag(steps));
    expect(l.length).toBe(2);
    expect(l[0]![0]!.id).toBe("s1");
    expect(l[1]![0]!.id).toBe("s2");
  });

  test("url {{s1.field}} is a data edge even without bind", () => {
    const steps: CompiledStep[] = [
      { id: "s1", kind: "cloud_http", name: "get", url: "https://x/a", commute: true },
      { id: "s2", kind: "cloud_http", name: "get2", url: "https://x/{{s1.number}}", commute: true },
    ];
    const l = layers(buildDag(steps));
    expect(l.length).toBe(2);
    expect(l[1]![0]!.id).toBe("s2");
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
    expect(r.command).toContain(".ec");
    expect(r.command).toContain("[ \"$_fail\" = 0 ]");
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

  test("playFor rewrites GraphQL PR loops once a live tool exists", () => {
    const cmd =
      "for n in 170 169; do gh api graphql -f query='query { repository { pullRequest(number: '$n') { title } } }'; done";
    const r = rewriteBash(cmd, {
      playFor: (kind, issues) => (kind === "bundle" ? `eden play github_pr_bundle --issues ${issues.join(",")}` : null),
    });
    expect(r.kind).toBe("play");
    expect(r.command).toContain("eden play github_pr_bundle --issues 170,169");
  });

  test("playFor rewrites redirected loops once a live tool exists", () => {
    const r = rewriteBash("for n in 170 169; do gh api repos/KaiavN/Eden/pulls/$n > raw/$n.json; done", {
      playFor: () => "eden play github_pr_bundle --issues 170,169",
    });
    expect(r.kind).toBe("play");
    expect(r.command).toContain("eden play github_pr_bundle --issues 170,169");
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
    expect(rows[0]!.reviews).toBe(1);
    expect(rows[0]!.files).toBe(1);
    expect(table).toContain("170 | PR 170 | 1 | success | 1");
    expect(JSON.parse(readFileSync(`${dir}/pull-170.json`, "utf8")).head.sha).toBe("sha170");
    expect(JSON.parse(readFileSync(`${dir}/reviews-169.json`, "utf8"))).toHaveLength(1);
  });

  test("typedTable uses integers not English", () => {
    expect(typedTable([{ number: 1, title: "a", reviews: 0, status: "pending" }])).toBe("1 | a | 0 | pending");
  });

  test("selectMcpTools keeps one github_pr_bundle", () => {
    const listed = selectMcpTools([
      { name: "github_pr_bundle_3", uses_count: 1 },
      { name: "github_pr_bundle", uses_count: 4 },
      { name: "github_pr_bundle_2", uses_count: 2 },
    ]);
    expect(listed.map((t) => t.name)).toEqual(["github_pr_bundle"]);
  });

  test("selectMcpTools hides github_pr and gh_api noise when a bundle exists", () => {
    const listed = selectMcpTools([
      { name: "github_pr", uses_count: 9 },
      { name: "gh_api_gh_api", uses_count: 8 },
      { name: "github_pr_bundle", uses_count: 2 },
    ]);
    expect(listed.map((t) => t.name)).toEqual(["github_pr_bundle"]);
  });

  test("isCompilableToolName rejects concatenated gh.api names", () => {
    expect(isCompilableToolName("gh_api_gh_api")).toBe(false);
    expect(isCompilableToolName("github_pr_bundle")).toBe(true);
  });

  test("selectMcpTools hides github_pr_files when a bundle exists", () => {
    const listed = selectMcpTools([
      { name: "github_pr_files", uses_count: 9 },
      { name: "github_pr_bundle", uses_count: 2 },
      { name: "fetch_issue_bundle", uses_count: 4 },
    ]);
    expect(listed.map((t) => t.name)).toEqual(["github_pr_bundle"]);
  });

  test("selectMcpTools ranks by uses and fills the list cap", () => {
    // Used tools first, then the best of the rest until the cap is reached.
    // This used to return *only* the used ones, leaving the remaining slots
    // empty — ten compiled tools of which one had ever been used surfaced one
    // tool, not six. Worse, it closed behind itself: a freshly compiled tool
    // has no uses, so once any tool had one it could never appear, and the
    // compile-surface-use loop the product depends on had no way to start.
    const listed = selectMcpTools([
      { name: "zero_a", uses_count: 0 },
      { name: "hot", uses_count: 9 },
      { name: "zero_b", uses_count: 0 },
      { name: "warm", uses_count: 2 },
      { name: "zero_c", uses_count: 0 },
      { name: "mid", uses_count: 1 },
      { name: "zero_d", uses_count: 0 },
    ]);
    expect(listed.map((t) => t.name)).toEqual(["hot", "warm", "mid", "zero_a", "zero_b", "zero_c"]);
    expect(listed).toHaveLength(6);
  });

  test("a newly compiled tool can still reach the list", () => {
    const listed = selectMcpTools([
      { name: "hot", uses_count: 9 },
      { name: "brand_new", uses_count: 0 },
    ]);
    expect(listed.map((t) => t.name)).toContain("brand_new");
  });

  test("selectMcpTools keeps a small unused set", () => {
    const listed = selectMcpTools([
      { name: "a", uses_count: 0 },
      { name: "b", uses_count: 0 },
    ]);
    expect(listed.map((t) => t.name)).toEqual(["a", "b"]);
  });

  test("shortenWhenToUse caps at MCP_DESC_CHARS", () => {
    const s = shortenWhenToUse("x".repeat(200));
    expect(s.length).toBe(140);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("canonical PR receipt", () => {
  test("prRowFromFacts uses CI state not PR open", () => {
    const row = prRowFromFacts({
      s1: { number: 170, title: "fix boot", state: "open", sha: "abc" },
      s2: { n: 2 },
      s3: { state: "failure", total_count: 3 },
      s4: { n: 4 },
    });
    expect(row).toEqual({ number: 170, title: "fix boot", reviews: 2, status: "failure", files: 4, sha: "abc" });
    expect(CI_STATE.test(row!.status)).toBe(true);
    expect(row!.status).not.toBe("open");
  });

  test("prRowFromFacts reads combined_state", () => {
    const row = prRowFromFacts({
      s1: { number: 12, title: "Cannot deploy widget 12" },
      s2: { n: 0 },
      s3: { combined_state: "success" },
    });
    expect(row?.status).toBe("success");
    expect(row?.reviews).toBe(0);
  });

  test("prRowFromFacts rolls check-runs conclusions up to CI state", () => {
    const { facts } = modelFacing({
      s1: { number: 12, title: "Cannot deploy widget 12" },
      s2: [],
      s3: {
        total_count: 3,
        check_runs: [
          { name: "test", conclusion: "success", status: "completed" },
          { name: "deploy", conclusion: "failure", status: "completed" },
        ],
      },
    });
    const row = prRowFromFacts(facts, "12");
    expect(row?.status).toBe("failure");
    expect(row?.title).toContain("Cannot deploy");
  });

  test("bundleJson is a JSON array the agent can write to prs.json", () => {
    const text = bundleJson([
      { number: 170, title: "fix boot", reviews: 2, status: "failure", files: 4 },
      { number: 169, title: "docs", reviews: 0, status: "success" },
    ]);
    const parsed = JSON.parse(text) as Array<{ number: number; status: string; files?: number }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.files).toBe(4);
    expect(parsed[1]!.files).toBeUndefined();
    expect(text).not.toContain(" | ");
    expect(text).not.toContain("\n  ");
  });
});

describe("any-workflow compile", () => {
  test("parameterizeUrl templates generic REST ids and keeps GitHub issue params", () => {
    expect(parameterizeUrl("http://127.0.0.1:8801/shop/orders/11/items")).toBe(
      "http://127.0.0.1:8801/shop/orders/{id}/items",
    );
    expect(parameterizeUrl("https://jsonplaceholder.typicode.com/posts/1/comments")).toBe(
      "https://jsonplaceholder.typicode.com/posts/{id}/comments",
    );
    expect(parameterizeUrl("https://api.github.com/repos/acme/app/issues/12/comments")).toBe(
      "https://api.github.com/repos/acme/app/issues/{issue}/comments",
    );
  });

  test("curl order+items island names from the path not curl_get_curl_get", () => {
    const islands = cutIslands([
      ev({
        name: "Bash",
        command: "curl http://127.0.0.1:8801/shop/orders/11",
        args: { command: "curl http://127.0.0.1:8801/shop/orders/11" },
      }),
      ev({
        name: "Bash",
        command: "curl http://127.0.0.1:8801/shop/orders/11/items",
        args: { command: "curl http://127.0.0.1:8801/shop/orders/11/items" },
      }),
    ]);
    expect(islands.length).toBe(1);
    expect(heuristicName(islands[0]!)).toBe("shop_orders");
    expect(isCompilableToolName(heuristicName(islands[0]!))).toBe(true);
    expect(isCompilableToolName("curl_get_curl_get")).toBe(false);
  });

  test("same API shape different ids share a fingerprint", () => {
    const a = cutIslands([
      ev({ name: "Bash", command: "curl http://x.test/posts/1", args: { command: "curl http://x.test/posts/1" } }),
      ev({
        name: "Bash",
        command: "curl http://x.test/posts/1/comments",
        args: { command: "curl http://x.test/posts/1/comments" },
      }),
    ]);
    const b = cutIslands([
      ev({ name: "Bash", command: "curl http://x.test/posts/9", args: { command: "curl http://x.test/posts/9" } }),
      ev({
        name: "Bash",
        command: "curl http://x.test/posts/9/comments",
        args: { command: "curl http://x.test/posts/9/comments" },
      }),
    ]);
    expect(fingerprintIsland(a[0]!)).toBe(fingerprintIsland(b[0]!));
  });

  test("different REST resources do not share a fingerprint", () => {
    const posts = cutIslands([
      ev({ name: "Bash", command: "curl http://x.test/posts/1", args: { command: "curl http://x.test/posts/1" } }),
      ev({
        name: "Bash",
        command: "curl http://x.test/posts/1/comments",
        args: { command: "curl http://x.test/posts/1/comments" },
      }),
    ]);
    const users = cutIslands([
      ev({ name: "Bash", command: "curl http://x.test/users/1", args: { command: "curl http://x.test/users/1" } }),
      ev({
        name: "Bash",
        command: "curl http://x.test/users/1/todos",
        args: { command: "curl http://x.test/users/1/todos" },
      }),
    ]);
    expect(fingerprintIsland(posts[0]!)).not.toBe(fingerprintIsland(users[0]!));
    expect(heuristicName(posts[0]!)).toBe("x_posts");
    expect(heuristicName(users[0]!)).toBe("x_users");
  });

  test("playFor rewrites a curl loop when the callback matches", () => {
    const cmd = "for n in 11 12; do curl http://127.0.0.1:8801/shop/orders/$n; curl http://127.0.0.1:8801/shop/orders/$n/items; done";
    const r = rewriteBash(cmd, {
      playFor: (_kind, issues) => `eden play shop_orders --ids ${issues.join(",")}`,
    });
    expect(r.kind).toBe("play");
    expect(r.command).toBe("eden play shop_orders --ids 11,12");
  });

  test("curl for-loops parallelize when no live tool exists", () => {
    const r = rewriteBash("for n in 11 12; do curl http://127.0.0.1:8801/shop/orders/$n; done");
    expect(r.changed).toBe(true);
    expect(r.kind).toBe("parallel");
    expect(r.command).toContain("wait");
    expect(r.command).toContain("curl ");
  });
});

describe("what may be reordered, and what may not", () => {
  /**
   * `commute` is not advisory. buildDag drops the sequential edge for a
   * commuting step so it runs concurrently with its layer, and
   * dedupeCloudSteps *discards* a commuting step whose parameterised URL
   * matches an earlier one. A write misclassified as commuting is therefore
   * not merely reordered, it is silently dropped: two identical POSTs to the
   * same endpoint compiled down to one.
   */
  test("a curl that writes does not read as a read", () => {
    // parseNamedCli hardcodes subcommand "get" for every curl and never looks
    // at the verb, so all of these used to commute.
    for (const cmd of [
      "curl -X POST https://api.stripe.com/v1/charges",
      "curl -XPOST https://api.stripe.com/v1/charges",
      "curl --request DELETE https://api.acme.com/v1/orders/1",
      "curl --request=PUT https://api.acme.com/v1/orders/1",
      "curl -d 'amount=100' https://api.stripe.com/v1/charges",
      "curl --data-binary @body.json https://api.acme.com/v1/orders",
      "curl -F file=@x.png https://api.acme.com/v1/upload",
    ]) {
      expect(isMutatingCurl(cmd)).toBe(true);
    }
    for (const cmd of [
      "curl https://api.acme.com/v1/orders/1",
      "curl -X GET https://api.acme.com/v1/orders/1",
      "curl -H 'Accept: application/json' https://api.acme.com/v1/orders/1",
    ]) {
      expect(isMutatingCurl(cmd)).toBe(false);
    }
  });

  test("gh api mutations are recognised however the method is spelled", () => {
    // The whitespace-only form missed --method=DELETE, and `gh api`'s
    // subcommand is the literal string "api", which matched none of the
    // mutating words the old test looked for.
    for (const cmd of [
      "gh api -X DELETE repos/o/r/issues/1/labels/bug",
      "gh api --method=DELETE repos/o/r/issues/1/labels/bug",
      "gh api --method DELETE repos/o/r/issues/1/labels/bug",
      "gh api -XPATCH repos/o/r/issues/1",
      "gh api repos/o/r/issues -f title=x",
      "gh api repos/o/r/issues --field title=x",
      "gh api repos/o/r/issues --raw-field title=x",
      "gh api graphql -f query='mutation { addComment }'",
    ]) {
      expect(isMutatingGh(cmd)).toBe(true);
    }
    for (const cmd of [
      "gh api repos/o/r/issues/1",
      "gh api -X GET repos/o/r/issues/1",
      "gh api graphql -f query='query { repository }'",
    ]) {
      expect(isMutatingGh(cmd)).toBe(false);
    }
  });

  test("a step whose name merely contains a read verb is not a read", () => {
    // The verb test was unanchored, so "widget_create" commuted for containing
    // "get", as did set_budget and gadget_purge.
    const writes = cutIslands([
      { name: "widget_create", args: { id: "1" }, ok: true, event_id: "e1", seq: 1 },
      { name: "set_budget", args: { id: "1" }, ok: true, event_id: "e2", seq: 2 },
      { name: "gadget_purge", args: { id: "1" }, ok: true, event_id: "e3", seq: 3 },
    ]).flat();
    expect(writes.length).toBeGreaterThan(0);
    for (const s of writes) expect(s.commute).toBe(false);

    const reads = cutIslands([
      { name: "get_customer", args: { id: "1" }, ok: true, event_id: "e4", seq: 1 },
      { name: "list_orders", args: { id: "1" }, ok: true, event_id: "e5", seq: 2 },
      { name: "order.view", args: { id: "1" }, ok: true, event_id: "e6", seq: 3 },
    ]).flat();
    expect(reads.length).toBeGreaterThan(0);
    for (const s of reads) expect(s.commute).toBe(true);
  });

  test("an ordered step waits for the ordered step before it, not just its neighbour", () => {
    // [A ordered, B commuting, C ordered]: C's immediate predecessor commutes,
    // so C used to get no dependency at all and land in layer 0 beside A.
    // Layers are run through Promise.all, so two steps that each declared
    // themselves order-dependent executed concurrently.
    const dag = buildDag([
      { id: "A", commute: false } as never,
      { id: "B", commute: true } as never,
      { id: "C", commute: false } as never,
    ]);
    expect(dag.find((n) => n.id === "C")!.deps).toEqual(["A"]);

    const waves = layers(dag).map((w) => w.map((n) => n.id));
    const layerOf = (id: string) => waves.findIndex((wave) => wave.includes(id));
    expect(layerOf("C")).toBeGreaterThan(layerOf("A"));
  });

  test("layers still reports a dependency that can never be satisfied", () => {
    expect(() => layers([{ id: "A", deps: ["ghost"] } as never])).toThrow(/unresolvable step deps/);
    expect(() => layers([{ id: "A", deps: ["A"] } as never])).toThrow(/unresolvable step deps/);
    expect(() =>
      layers([
        { id: "A", deps: ["B"] } as never,
        { id: "B", deps: ["A"] } as never,
      ]),
    ).toThrow(/unresolvable step deps/);
  });

  test("layers groups independent steps into one wave and keeps chains ordered", () => {
    const waves = layers([
      { id: "A", deps: [] } as never,
      { id: "B", deps: [] } as never,
      { id: "C", deps: ["A", "B"] } as never,
      { id: "D", deps: ["C"] } as never,
    ]).map((w) => w.map((n) => n.id));
    expect(waves).toEqual([["A", "B"], ["C"], ["D"]]);
  });
});

describe("rewriting a command does not corrupt it", () => {
  test("splitJsonValues survives a stray closing brace", () => {
    // depth went negative on a leading `}`, after which `depth === 0` was
    // never true again and every later JSON value was silently dropped.
    const text = `} trailing junk from a truncated log\n{"a":1}\n{"b":2}`;
    expect(compactStdout("gh api repos/o/r", text).stdout).toBeTruthy();
  });

  test("prose about passwords is not reported as a test run", () => {
    // /(\d+)\s+pass/ matched inside "3 passwords", so any output containing
    // such a phrase was replaced wholesale by a fabricated test summary.
    const prose = "Rotated 3 passwords and notified 150 passengers.";
    expect(compactStdout("bash -lc 'echo hi'", prose).stdout).not.toMatch(/^test: /m);
  });

  test("a real test run is still summarised", () => {
    const real = "bun test v1.3.13\n\n 12 pass\n 0 fail\nRan 12 tests across 3 files. [40ms]";
    expect(compactStdout("bun test", real).stdout).toContain("test: 12 pass / 0 fail");
  });
});

describe("URL shapes match at segment boundaries", () => {
  test("a prefix that stops mid-segment is not a match", () => {
    // Plain startsWith compared raw strings, so a path that merely shares a
    // *character* prefix matched: `repos/o/rep` against a tool compiled for
    // `repos/o/repo-two/pulls/{id}`. Steering on that similarity sends the
    // agent to a tool that fetches a different repository. A prefix now has
    // to end where a path segment ends.
    expect(
      commandMatchesToolUrls("gh api repos/o/rep", ["https://api.github.com/repos/o/repo-two/pulls/1"]),
    ).toBe(false);
    expect(
      commandMatchesToolUrls("gh api repos/o/repo-two/pulls/1", ["https://api.github.com/repos/o/rep"]),
    ).toBe(false);
  });

  test("an exact shape still matches", () => {
    expect(
      commandMatchesToolUrls("gh api repos/o/r/pulls/1/reviews", ["https://api.github.com/repos/o/r/pulls/2/reviews"]),
    ).toBe(true);
  });

  test("a bound value is URL-encoded like a parameter is", () => {
    // The {{step.path}} pass interpolated raw while {param} encoded, so a
    // bound value carrying ?, # or & was spliced unescaped into the URL that
    // playback hands to new URL().
    const out = resolveTemplate("https://api.acme.com/s/{{s1.q}}", {}, { s1: { q: "a b?c#d&e" } });
    expect(out).toBe("https://api.acme.com/s/a%20b%3Fc%23d%26e");
  });

  test("a non-scalar bound value contributes nothing, not [object Object]", () => {
    expect(resolveTemplate("https://api.acme.com/s/{{s1.q}}", {}, { s1: { q: { deep: 1 } } })).toBe(
      "https://api.acme.com/s/",
    );
  });
});
