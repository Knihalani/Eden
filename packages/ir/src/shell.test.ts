import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpolateShell, interpolateSlots, isShellCommand } from "./index";

// Issue #74: slot values filled from upstream output must reach a shell command as data.
const PAYLOADS = [
  "x; touch pwned",
  "$(touch pwned)",
  "`touch pwned`",
  "a' ; touch pwned; echo '",
  'a" ; touch pwned; echo "',
  "a\n touch pwned",
  "\\'; touch pwned; '",
  "*",
  "~",
  "",
];

/** Runs `command` with a real shell in an empty directory; returns stdout and what the directory holds after. */
function sh(command: string): { stdout: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "eden-shell-slot-"));
  try {
    const r = spawnSync(command, { cwd: dir, shell: true, encoding: "utf8" });
    return { stdout: r.stdout, files: readdirSync(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("interpolateShell: slot values are data", () => {
  // printf prints its format once per argument, so `<v>` twice would mean the value split into two words.
  const contexts = [
    { expr: "printf '<%s>' {v}", out: (v: string) => `<${v}>` },
    { expr: "printf '<%s>' '{v}'", out: (v: string) => `<${v}>` },
    { expr: `printf '<%s>' "{v}"`, out: (v: string) => `<${v}>` },
    { expr: "printf '<%s>' pre{v}post", out: (v: string) => `<pre${v}post>` },
    { expr: "printf '<%s>' 'pre {v} post'", out: (v: string) => `<pre ${v} post>` },
    { expr: `printf '<%s>' "pre {v} post"`, out: (v: string) => `<pre ${v} post>` },
  ];
  for (const { expr, out } of contexts) {
    test(`every payload is one literal argument in ${expr}`, () => {
      for (const v of PAYLOADS) {
        const command = interpolateShell(expr, { v });
        expect(command).not.toBeNull();
        expect(sh(command!)).toEqual({ stdout: out(v), files: [] });
      }
    });
  }

  test("quoting follows POSIX single quotes: ' becomes '\\''", () => {
    expect(interpolateShell("echo {v}", { v: "a' ; touch pwned; echo '" })).toBe(
      "echo 'a'\\'' ; touch pwned; echo '\\'''",
    );
    expect(interpolateShell("echo {v}", { v: "$(touch pwned)" })).toBe("echo '$(touch pwned)'");
    // Inside the template's own quotes: close them, splice the quoted value, reopen them.
    expect(interpolateShell("echo '{v}'", { v: "it's" })).toBe("echo '''it'\\''s'''");
    expect(interpolateShell('echo "{v}"', { v: "`id`" })).toBe(`echo ""'\`id\`'""`);
  });

  test("values that cannot change the parse are spliced byte for byte, as interpolateSlots does", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["kubectl logs {app} -n {namespace}", { app: "api-7f9", namespace: "prod" }],
      ["curl -s https://api.example.com/v1/{path}?id={id}", { path: "users/42", id: "a.b_c-d" }],
      ["kubectl scale deploy/{name} --replicas={n}", { name: "web", n: 3 }],
      ["gh issue view {id} -R {repo}", { id: 74, repo: "Knihalani/Eden" }],
      ["grep -rn '{pattern}' src", { pattern: "TODO: fix (later)" }],
      ['git commit -m "{msg}"', { msg: "fix the bug, again" }],
      [
        "echo {user}@{host}:{port} {pct}% {sum}+1 {flag}",
        { user: "u", host: "h", port: 22, pct: 5, sum: 1, flag: "-v" },
      ],
      ["echo {missing} {v}", { v: "ok" }],
    ];
    for (const [expr, record] of cases) {
      expect(interpolateShell(expr, record)).toBe(interpolateSlots(expr, record));
    }
  });

  test("a value is refused where quoting cannot be trusted, and plain values still pass", () => {
    const opaque = [
      "echo $(printf %s {v})",
      "echo `printf %s {v}`",
      "echo ${X:-{v}}",
      "cat <<EOF\n{v}\nEOF",
      "echo hi # {v}",
      "[[ {v} -eq 1 ]]",
      "(( {v} + 1 ))",
      "echo $[ {v} + 1 ]",
      "echo \"$(printf %s {v})\"",
    ];
    for (const expr of opaque) {
      expect(interpolateShell(expr, { v: "a b" })).toBeNull();
      expect(interpolateShell(expr, { v: "a[$(touch pwned)]" })).toBeNull();
      expect(interpolateShell(expr, { v: "plain-1.0" })).toBe(interpolateSlots(expr, { v: "plain-1.0" }));
    }
  });

  test("a slot glued to a backslash, a $name or a ~name is refused whatever its value", () => {
    for (const expr of ["echo \\{v}", "echo $HOME{v}", "echo ${v}", 'echo "$X{v}"', "ls ~{v}/.ssh"]) {
      expect(interpolateShell(expr, { v: "HOME" })).toBeNull();
      expect(interpolateShell(expr, { v: "x; touch pwned" })).toBeNull();
    }
    expect(interpolateShell("echo '$X{v}'", { v: "HOME" })).toBe("echo '$XHOME'");
  });
});

describe("isShellCommand", () => {
  test("names the command line of a shell tool, including shape-derived names", () => {
    for (const tool of ["Bash", "bash", "shell", "Shell", "Bash:kubectl.get.pods.n.{v0}"]) {
      expect(isShellCommand(tool, "command")).toBe(true);
    }
    expect(isShellCommand("Bash", "description")).toBe(false);
    expect(isShellCommand("Read", "command")).toBe(false);
    expect(isShellCommand("", "command")).toBe(false);
  });
});
