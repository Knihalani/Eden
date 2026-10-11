import { describe, expect, test } from "bun:test";
import { bashAccepts, ifAccepts, subcommands } from "./permission-rule";

describe("the hooks reference's Bash matching table", () => {
  const rows: [pattern: string, command: string, runs: boolean][] = [
    ["git *", "FOO=bar git push", true],
    ["git *", "npm test && git push", true],
    ["rm *", "echo $(rm -rf /)", true],
    ["rm *", "echo $(date)", false],
    ["cat *", "echo before $(date) after", false],
    ["git *", "$TOOL git push", true],
    ["git push *", "echo $(date)", true],
  ];
  for (const [pattern, command, runs] of rows)
    test(`Bash(${pattern}) on \`${command}\`: ${runs ? "runs" : "does not run"}`, () => {
      expect(bashAccepts(pattern, command)).toBe(runs);
    });
});

describe("patterns", () => {
  test("`*` matches any run of characters; a trailing ` *` also matches the bare command", () => {
    expect(bashAccepts("gh pr merge*", "gh pr merge 42 --squash")).toBe(true);
    expect(bashAccepts("git push *", "git push")).toBe(true);
    expect(bashAccepts("git push --force*", "git push origin feature")).toBe(false);
    expect(bashAccepts("*deploy*", "npm run deploy:prod")).toBe(true);
    expect(bashAccepts("git push *+*", "git push origin +main")).toBe(true);
    expect(bashAccepts("ls *", "lsof")).toBe(false);
  });

  test("each subcommand, quotes kept whole", () => {
    expect(subcommands(`git commit -m "a && b" && git push`)).toEqual([`git commit -m "a && b"`, "git push"]);
    expect(subcommands("a | b; c\nd")).toEqual(["a", "b", "c", "d"]);
    expect(subcommands("echo `git push`")).toEqual(["echo `git push`", "git push"]);
  });
});

describe("events and tools", () => {
  test("only tool events evaluate `if`; on any other event the handler never runs", () => {
    expect(ifAccepts("Bash(git *)", "PreToolUse", "Bash", { command: "git push" })).toBe(true);
    expect(ifAccepts("Bash(git *)", "UserPromptSubmit", "Bash", { command: "git push" })).toBe(false);
  });

  test("the rule names its tool", () => {
    expect(ifAccepts("Bash(git *)", "PreToolUse", "Read", { file_path: "git" })).toBe(false);
    expect(ifAccepts("Bash", "PreToolUse", "Bash", { command: "ls" })).toBe(true);
    expect(ifAccepts("Edit(*.ts)", "PreToolUse", "Edit", { file_path: "a.ts" })).toBe(true);
  });
});
