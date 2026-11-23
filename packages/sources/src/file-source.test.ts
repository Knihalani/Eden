import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSource } from "./file-source";

const scope = { tenantId: "local", userId: "u" };
const signal = new AbortController().signal;

function withDir(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "eden-filesrc-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("a directory's files are listed, searched and fetched; mtime rescan picks up edits", () =>
  withDir(async (dir) => {
    writeFileSync(join(dir, "renewal.md"), "Dana Lee wants 12% off the Globex renewal");
    writeFileSync(join(dir, "plumber.txt"), "The plumber repairs the kitchen sink for 85 pounds.");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "note.md"), "sub note about the attic");
    const s = new FileSource("docs", "local docs", { paths: [dir] });

    const page = await s.list(scope, undefined, 10, signal);
    expect(page.items.map((i) => i.title).sort()).toEqual(["note.md", "plumber.txt", "renewal.md"]);
    expect(page.next).toBeNull();
    expect(page.items[0]!.url).toMatch(/^file:\/\//);

    const hits = await s.search({ scope, text: "kitchen sink", entities: [], limit: 10 }, signal);
    expect(hits.map((h) => h.ref)).toEqual([join(dir, "plumber.txt")]);

    const one = await s.fetch(join(dir, "renewal.md"), scope, signal);
    expect(one?.text).toContain("12%");

    // mtime rescan: an edit with a new mtime is re-read; a deleted file reports gone.
    writeFileSync(join(dir, "renewal.md"), "Dana Lee now wants 15% off");
    utimesSync(join(dir, "renewal.md"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const hits2 = await s.search({ scope, text: "15%", entities: [], limit: 10 }, signal);
    expect(hits2.map((h) => h.text)).toEqual(["Dana Lee now wants 15% off"]);

    rmSync(join(dir, "plumber.txt"));
    const page2 = await s.list(scope, undefined, 10, signal);
    expect(page2.items.map((i) => i.title).sort()).toEqual(["note.md", "renewal.md"]);
    expect(await s.fetch(join(dir, "plumber.txt"), scope, signal)).toBeNull();
  }));

test("glob patterns, maxFiles bound and binary skipping", () =>
  withDir(async (dir) => {
    writeFileSync(join(dir, "a.md"), "alpha");
    writeFileSync(join(dir, "b.txt"), "beta");
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    const s = new FileSource("docs", "local docs", { paths: [join(dir, "*.md")], maxFiles: 1 });
    const page = await s.list(scope, undefined, 10, signal);
    expect(page.items.map((i) => i.title)).toEqual(["a.md"]);
    const s2 = new FileSource("docs", "local docs", { paths: [dir] });
    const page2 = await s2.list(scope, undefined, 10, signal);
    expect(page2.items.some((i) => i.title === "bin.dat")).toBe(false);
  }));

test("list pages by offset cursor", () =>
  withDir(async (dir) => {
    for (const n of ["f1.md", "f2.md", "f3.md"]) writeFileSync(join(dir, n), n);
    const s = new FileSource("docs", "d", { paths: [dir] });
    const p1 = await s.list(scope, undefined, 2, signal);
    expect(p1.items.length).toBe(2);
    expect(p1.next).toBe("2");
    const p2 = await s.list(scope, p1.next!, 2, signal);
    expect(p2.items.length).toBe(1);
    expect(p2.next).toBeNull();
  }));

test("a note with no dates of its own is placed on its modified day; a dated note keeps its days", () =>
  withDir(async (dir) => {
    const monday = new Date("2026-11-16T10:00:00Z");
    writeFileSync(join(dir, "plain.md"), "met Sam for coffee");
    writeFileSync(join(dir, "dated.md"), "the offsite is on 4 December");
    utimesSync(join(dir, "plain.md"), monday, monday);
    const s = new FileSource("docs", "d", { paths: [dir] });

    const items = (await s.list(scope, undefined, 10, signal)).items;
    // meta.day is the mtime as an instant: the engine resolves it to the user's day at their offset.
    expect(items.find((i) => i.title === "plain.md")?.meta?.day).toBe(monday.toISOString());
    const want = monday.toISOString().slice(0, 10);
    expect(items.find((i) => i.title === "plain.md")?.meta?.start).toBeUndefined();
    expect(items.find((i) => i.title === "dated.md")?.meta?.day).toBeUndefined();

    // The stamped day answers a dated lookup on the file's own day (the engine reads meta.day).
    const next = new Date(monday.getTime() + 86_400_000);
    const end = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
    const hits = await s.search({ scope, text: "", entities: [], limit: 10, window: { start: want, end } }, signal);
    expect(hits.map((h) => h.title)).toEqual(["plain.md"]);
  }));
