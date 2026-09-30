import { afterAll, describe, expect, test } from "bun:test";
import { codingRegistry } from "../src/coding";
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A throwaway workspace: the tests write and edit files, and must never touch the repo tree.
const dir = mkdtempSync(join(tmpdir(), "eden-coding-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("coding registry", () => {
  test("Read returns file contents", async () => {
    const path = join(dir, "note.txt");
    writeFileSync(path, "hello-eden");
    const reg = codingRegistry(dir);
    const out = (await reg.execute("Read", { path })) as { content: string };
    expect(out.content).toBe("hello-eden");
  });

  test("Read refuses paths outside cwd", async () => {
    const reg = codingRegistry(dir);
    await expect(reg.execute("Read", { path: "../package.json" })).rejects.toThrow(/outside/);
  });

  test("Bash refuses an empty command", async () => {
    const reg = codingRegistry(dir);
    await expect(reg.execute("Bash", { command: "   " })).rejects.toThrow(/empty command/);
  });

  test("Write stays inside cwd and Edit refuses missing old_string", async () => {
    const reg = codingRegistry(dir);
    await expect(reg.execute("Write", { path: "../escape.txt", contents: "nope" })).rejects.toThrow(/outside/);
    const out = (await reg.execute("Write", { path: "note2.txt", contents: "alpha" })) as { ok: boolean };
    expect(out.ok).toBe(true);
    await expect(reg.execute("Edit", { path: "note2.txt", old_string: "missing", new_string: "x" })).rejects.toThrow(/old_string/);
    await reg.execute("Edit", { path: "note2.txt", old_string: "alpha", new_string: "beta" });
    const read = (await reg.execute("Read", { path: "note2.txt" })) as { content: string };
    expect(read.content).toBe("beta");
    const ls = (await reg.execute("LS", { path: "." })) as { entries: Array<{ name: string }> };
    expect(ls.entries.some((e) => e.name === "note2.txt")).toBe(true);
  });

  test("Grep and Glob stay inside cwd", async () => {
    writeFileSync(join(dir, "note.txt"), "hello-eden");
    const reg = codingRegistry(dir);
    expect(reg.has?.("Grep")).toBe(true);
    const grepped = (await reg.execute("Grep", { pattern: "hello", path: "." })) as {
      matches: Array<{ text: string }>;
    };
    expect(grepped.matches.some((m) => m.text.includes("hello-eden"))).toBe(true);
    const globbed = (await reg.execute("Glob", { pattern: "*.txt" })) as { files: string[] };
    expect(globbed.files.some((f) => f.endsWith("note.txt") || f === "note.txt")).toBe(true);
  });

  test("Bash refuses command substitution and quoted cd", async () => {
    const reg = codingRegistry(dir);
    await expect(reg.execute("Bash", { command: "cat $(pwd)/../package.json" })).rejects.toThrow(/outside/);
    await expect(reg.execute("Bash", { command: 'cd ".." && ls' })).rejects.toThrow(/outside/);
    await expect(reg.execute("Bash", { command: "cat $HOME/.zshrc" })).rejects.toThrow(/outside/);
  });

  test("Edit splices literally instead of expanding $ patterns", async () => {
    const reg = codingRegistry(dir);

    const dollarAmp = join(dir, "amp.ts");
    writeFileSync(dollarAmp, "const price = PLACEHOLDER;\n");
    await reg.execute("Edit", { path: dollarAmp, old_string: "PLACEHOLDER", new_string: "cost * $& + 1" });
    expect(readFileSync(dollarAmp, "utf8")).toBe("const price = cost * $& + 1;\n");

    const dollarTick = join(dir, "tick.txt");
    writeFileSync(dollarTick, "HEAD\nMARK\nTAIL\n");
    await reg.execute("Edit", { path: dollarTick, old_string: "MARK", new_string: "x$'y" });
    expect(readFileSync(dollarTick, "utf8")).toBe("HEAD\nx$'y\nTAIL\n");
  });

  test("Edit refuses an ambiguous old_string rather than picking one", async () => {
    const path = join(dir, "dupe.txt");
    writeFileSync(path, "foo\nfoo\n");
    const reg = codingRegistry(dir);
    await expect(reg.execute("Edit", { path, old_string: "foo", new_string: "bar" })).rejects.toThrow(/not unique/);
    expect(readFileSync(path, "utf8")).toBe("foo\nfoo\n");
  });

  test("Edit without old_string does not truncate the file", async () => {
    const path = join(dir, "keep.txt");
    writeFileSync(path, "important existing content\n");
    const reg = codingRegistry(dir);
    await expect(reg.execute("Edit", { path, new_string: "tiny" })).rejects.toThrow(/old_string is required/);
    expect(readFileSync(path, "utf8")).toBe("important existing content\n");
  });

  test("PTC complement: allowed_callers is guidance, execute still works direct", async () => {
    writeFileSync(join(dir, "ptc.txt"), "ok");
    const reg = codingRegistry(dir);
    expect(reg.allowed_callers).toEqual(["direct", "code_execution_20260120"]);
    const out = (await reg.execute("Read", { path: "ptc.txt" })) as { content: string };
    expect(out.content).toBe("ok");
    expect(JSON.stringify(reg)).not.toMatch(/forbidden|denied|unauthorized/i);
  });
});
