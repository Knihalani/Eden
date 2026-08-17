import { describe, expect, test } from "bun:test";
import { codingRegistry } from "../src/coding";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

describe("coding registry", () => {
  test("Read returns file contents", async () => {
    const dir = join(import.meta.dir, "../../.tmp-coding");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "note.txt");
    writeFileSync(path, "hello-eden");
    const reg = codingRegistry(dir);
    const out = (await reg.execute("Read", { path })) as { content: string };
    expect(out.content).toBe("hello-eden");
  });

  test("Read refuses paths outside cwd", async () => {
    const dir = join(import.meta.dir, "../../.tmp-coding");
    mkdirSync(dir, { recursive: true });
    const reg = codingRegistry(dir);
    await expect(reg.execute("Read", { path: "../package.json" })).rejects.toThrow(/outside/);
  });

  test("Bash refuses an empty command", async () => {
    const dir = join(import.meta.dir, "../../.tmp-coding");
    mkdirSync(dir, { recursive: true });
    const reg = codingRegistry(dir);
    await expect(reg.execute("Bash", { command: "   " })).rejects.toThrow(/empty command/);
  });

  test("Write stays inside cwd and Edit refuses missing old_string", async () => {
    const dir = join(import.meta.dir, "../../.tmp-coding");
    mkdirSync(dir, { recursive: true });
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
    const dir = join(import.meta.dir, "../../.tmp-coding");
    mkdirSync(dir, { recursive: true });
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
    const dir = join(import.meta.dir, "../../.tmp-coding");
    mkdirSync(dir, { recursive: true });
    const reg = codingRegistry(dir);
    await expect(reg.execute("Bash", { command: "cat $(pwd)/../package.json" })).rejects.toThrow(/outside/);
    await expect(reg.execute("Bash", { command: 'cd ".." && ls' })).rejects.toThrow(/outside/);
    await expect(reg.execute("Bash", { command: "cat $HOME/.zshrc" })).rejects.toThrow(/outside/);
  });
});
