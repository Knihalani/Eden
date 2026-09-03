import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactAndPublish, s3Configured, s3PublicUrl } from "./s3";
import { openStore } from "./store";

function mockAws(dir: string) {
  const mock = join(dir, "mock");
  mkdirSync(mock, { recursive: true });
  const bin = join(dir, "aws");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const root = process.env.EDEN_KNOW_S3_MOCK!;
const store = root + "/obj.kpk";
const etagFile = root + "/etag";
const cmd = (args[0] || "") + " " + (args[1] || "");
async function exists(p: string) {
  return Bun.file(p).exists();
}
if (cmd === "s3api head-object") {
  if (!(await exists(store))) {
    console.error("An error occurred (404) when calling the HeadObject operation: Not Found");
    process.exit(254);
  }
  console.log(JSON.stringify({ ETag: '"' + (await Bun.file(etagFile).text()).trim() + '"' }));
  process.exit(0);
}
if (cmd === "s3api get-object") {
  const dest = args[args.length - 1]!;
  await Bun.write(dest, await Bun.file(store).arrayBuffer());
  console.log(JSON.stringify({ ETag: '"' + (await Bun.file(etagFile).text()).trim() + '"' }));
  process.exit(0);
}
if (cmd === "s3api put-object") {
  const ifMatch = args.includes("--if-match") ? args[args.indexOf("--if-match") + 1] : "";
  const ifNone = args.includes("--if-none-match") ? args[args.indexOf("--if-none-match") + 1] : "";
  const body = args[args.indexOf("--body") + 1]!;
  const nfile = root + "/nput";
  let n = 0;
  try { n = Number((await Bun.file(nfile).text()).trim()); } catch { n = 0; }
  n++;
  await Bun.write(nfile, String(n));
  const had = await exists(store);
  const cur = had ? (await Bun.file(etagFile).text()).trim() : "";
  if (process.env.EDEN_KNOW_S3_CONFLICT === "1" && n === 1) {
    await Bun.write(store, await Bun.file(body).arrayBuffer());
    await Bun.write(etagFile, "racer");
    console.error("PreconditionFailed 412");
    process.exit(1);
  }
  if (ifNone === "*" && had) {
    console.error("PreconditionFailed");
    process.exit(1);
  }
  if (ifMatch && had && ifMatch !== cur) {
    console.error("PreconditionFailed 412");
    process.exit(1);
  }
  await Bun.write(store, await Bun.file(body).arrayBuffer());
  const next = "etag-" + Date.now();
  await Bun.write(etagFile, next);
  console.log(JSON.stringify({ ETag: '"' + next + '"' }));
  process.exit(0);
}
console.error("unknown " + args.join(" "));
process.exit(2);
`,
  );
  chmodSync(bin, 0o755);
  return { mock };
}

describe("s3 publish", () => {
  test("public URL is virtual-hosted on Impossible Cloud", () => {
    expect(s3PublicUrl("eden-know", "graph.kpk")).toBe(
      "https://eden-know.us-east-1.storage.impossibleapi.net/graph.kpk",
    );
  });

  test("without credentials compact stays local", async () => {
    const saved = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      EDEN_KNOW_S3_ACCESS_KEY: process.env.EDEN_KNOW_S3_ACCESS_KEY,
      EDEN_KNOW_S3_SECRET_KEY: process.env.EDEN_KNOW_S3_SECRET_KEY,
      EDEN_KNOW_S3: process.env.EDEN_KNOW_S3,
    };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.EDEN_KNOW_S3_ACCESS_KEY;
    delete process.env.EDEN_KNOW_S3_SECRET_KEY;
    process.env.EDEN_KNOW_S3 = "0";
    expect(s3Configured()).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "eden-know-s3off-"));
    const s = openStore(dir);
    s.putNodes("https://example.org/a", [{ s: "France", p: "capital", o: "Paris", e: "", url: "" }], 30);
    const r = await compactAndPublish(s);
    expect(r.compacted).toBe(true);
    expect(r.uploaded).toBe(false);
    expect(s.search("France")[0]?.o).toBe("Paris");
    s.close();
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("fetch 404 then If-None-Match put uploads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-s3-"));
    const { mock } = mockAws(dir);
    const prevPath = process.env.PATH;
    const saved = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      EDEN_KNOW_S3: process.env.EDEN_KNOW_S3,
      EDEN_KNOW_S3_MOCK: process.env.EDEN_KNOW_S3_MOCK,
    };
    process.env.PATH = `${dir}:${prevPath}`;
    process.env.EDEN_KNOW_S3_MOCK = mock;
    process.env.EDEN_KNOW_S3 = "1";
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    try {
      const s = openStore(join(dir, "g"));
      s.putNodes("https://example.org/a", [{ s: "France", p: "capital", o: "Paris", e: "", url: "" }], 30);
      const r = await compactAndPublish(s);
      expect(r.uploaded).toBe(true);
      expect(r.bytes).toBeGreaterThan(4);
      expect(r.url).toContain("eden-know");
      s.close();
    } finally {
      process.env.PATH = prevPath;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("412 refetch remarge uploads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-s3412-"));
    const { mock } = mockAws(dir);
    const prevPath = process.env.PATH;
    const saved = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      EDEN_KNOW_S3: process.env.EDEN_KNOW_S3,
      EDEN_KNOW_S3_MOCK: process.env.EDEN_KNOW_S3_MOCK,
      EDEN_KNOW_S3_CONFLICT: process.env.EDEN_KNOW_S3_CONFLICT,
    };
    process.env.PATH = `${dir}:${prevPath}`;
    process.env.EDEN_KNOW_S3_MOCK = mock;
    process.env.EDEN_KNOW_S3_CONFLICT = "1";
    process.env.EDEN_KNOW_S3 = "1";
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    try {
      const s = openStore(join(dir, "g"));
      s.putNodes("https://example.org/a", [{ s: "France", p: "capital", o: "Paris", e: "", url: "" }], 30);
      const r = await compactAndPublish(s);
      expect(r.uploaded).toBe(true);
      expect(s.search("France")[0]?.o).toBe("Paris");
      s.close();
    } finally {
      process.env.PATH = prevPath;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
