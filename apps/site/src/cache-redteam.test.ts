/**
 * Red-team the run cache: zip-bombs, unique-GET storms, hostile envelopes.
 * A miss or a refuse — never a throw into the caller.
 */
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { openDb } from "./db";
import {
  ADMISSION_WINDOW_CAP,
  ENVELOPE_REV,
  GUNZIP_MAX_BYTES,
  packCacheBody,
  readEntry,
  readResult,
  resetCacheAdmission,
  unpackCacheBody,
  writeResult,
} from "./cache";

describe("cache red-team", () => {
  const dbP = openDb(`/tmp/eden-cache-redteam-${Date.now()}.db`);

  test("truncated gzip and zip-bomb envelopes are misses, never throws", async () => {
    const d = await dbP;
    const truncated = JSON.stringify({ __eden_cache: ENVELOPE_REV, z: "H4sIAAAA" });
    expect(unpackCacheBody(truncated)).toBeUndefined();
    await d.run(`INSERT OR REPLACE INTO result_cache (cache_key, body, expires_at) VALUES (?, ?, ?)`, [
      "k-trunc",
      truncated,
      Date.now() + 60_000,
    ]);
    expect(await readEntry(d, "k-trunc")).toBeUndefined();
    expect(await readResult(d, "k-trunc")).toBeUndefined();

    // 10 MiB of zeros gzip to a few KB and would expand past the cap.
    const bombRaw = Buffer.alloc(GUNZIP_MAX_BYTES + 1024 * 1024, 0);
    const bomb = JSON.stringify({
      __eden_cache: ENVELOPE_REV,
      z: gzipSync(bombRaw).toString("base64"),
    });
    expect(unpackCacheBody(bomb)).toBeUndefined();
    await d.run(`INSERT OR REPLACE INTO result_cache (cache_key, body, expires_at) VALUES (?, ?, ?)`, [
      "k-bomb",
      bomb,
      Date.now() + 60_000,
    ]);
    expect(await readResult(d, "k-bomb")).toBeUndefined();
  });

  test("__proto__ / hostile JSON envelopes miss-or-return, never crash", async () => {
    const hostile = [
      '{"__eden_cache":3,"__proto__":{"polluted":true},"v":{"ok":1}}',
      '{"__eden_cache":3,"z":null,"v":{"ok":1}}',
      '{"__eden_cache":3,"z":{"not":"a string"}}',
      '{"__eden_cache":2,"etag":{"not":"a string"},"v":1}',
      "null",
      "[]",
      "{not json",
    ];
    for (const body of hostile) {
      expect(() => unpackCacheBody(body)).not.toThrow();
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    const proto = unpackCacheBody('{"__eden_cache":3,"__proto__":{"polluted":true},"v":{"ok":1}}');
    expect(proto?.value).toEqual({ ok: 1 });
  });

  test("unique-GET storm does not persist write-all volume", async () => {
    resetCacheAdmission();
    const d = await dbP;
    const before = (await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache`))?.c ?? 0;
    const n = 1000;
    for (let i = 0; i < n; i++) {
      await writeResult(d, `rc:storm-${i}`, { i, once: true }, 60_000);
    }
    const after = (await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache`))?.c ?? 0;
    const persisted = after - before;
    expect(persisted).toBeLessThanOrEqual(ADMISSION_WINDOW_CAP);
    expect(persisted).toBeLessThan(n * 0.2);
    expect(persisted).toBeGreaterThan(0);
  });

  test("one tenant's unique-GET storm does not fill another tenant's admission window", async () => {
    resetCacheAdmission();
    const d = await dbP;
    for (let i = 0; i < 1000; i++) {
      await writeResult(d, `rc:tenant-a-${i}`, { i }, 60_000, undefined, { method: "GET", workspaceId: "ws-a" });
    }
    await writeResult(d, "rc:tenant-b-first", { ok: 1 }, 60_000, undefined, { method: "GET", workspaceId: "ws-b" });
    expect(await readResult<{ ok: number }>(d, "rc:tenant-b-first")).toEqual({ ok: 1 });
  });

  test("writeResult never throws on a broken db handle (fail open)", async () => {
    const broken = {
      run: async () => {
        throw new Error("db down");
      },
      get: async () => {
        throw new Error("db down");
      },
    };
    await expect(
      writeResult(broken as never, "rc:x", { a: 1 }, 1000, undefined, { method: "GET" }),
    ).resolves.toBeUndefined();
    await expect(readResult(broken as never, "rc:x")).resolves.toBeUndefined();
    await expect(readEntry(broken as never, "rc:x")).resolves.toBeUndefined();
  });

  test("repeating keys after a storm are still admitted (frequency bypass)", async () => {
    resetCacheAdmission();
    const d = await dbP;
    // Fill the window with one-shots so it cannot accept more first-seens.
    for (let i = 0; i < ADMISSION_WINDOW_CAP + 8; i++) {
      await writeResult(d, `rc:fill-${i}`, { i }, 60_000);
    }
    const hot = "rc:hot-repeat";
    await writeResult(d, hot, { n: 1 }, 60_000); // first sight, window full → reject
    expect(await readResult(d, hot)).toBeUndefined();
    await writeResult(d, hot, { n: 2 }, 60_000); // sketch predicts a repeat → admit
    expect(await readResult<{ n: number }>(d, hot)).toEqual({ n: 2 });
  });

  test("pack/unpack of a gzipped body is lossless", () => {
    const value = {
      comments: Array.from({ length: 40 }, (_, i) => ({
        id: i,
        body: "pin the lockfile and rerun the pipeline. ".repeat(6),
      })),
    };
    const packed = packCacheBody(value, '"e"');
    const env = JSON.parse(packed) as { z?: string };
    expect(typeof env.z).toBe("string");
    expect(unpackCacheBody(packed)?.value).toEqual(value);
  });
});
