/**
 * N2 — wire-compression unit tests for `compressJsonBody`.
 *
 * Verifies the two branches independently of the HTTP layer:
 *   - zstd fast path (Bun runtime): emits zstd frame magic 28 B5 2F FD
 *     and reports `encoding: "zstd"` (the gateway sniffs this magic in
 *     providers.py when a proxy strips the header).
 *   - gzip fallback (runtime without Bun zstd): reports `encoding:
 *     "gzip"` and round-trips through `gunzipSync`.
 *   - never-throws guarantee: a broken zstd compressor falls through to
 *     gzip instead of killing the send path.
 *
 * Bun's `Bun.zstdCompressSync` is a non-configurable property, so the
 * tests drive the probe through the exported `_setZstdProbeForTests`
 * hook instead of mutating `globalThis.Bun` (which would throw).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import { _setZstdProbeForTests, compressJsonBody } from "../src/client.js";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** Real Bun zstd compressor, if the runtime provides one. */
function bunZstd(): ((d: Uint8Array) => Uint8Array) | undefined {
  const g = globalThis as {
    Bun?: { zstdCompressSync?: (d: Uint8Array) => Uint8Array };
  };
  return g.Bun?.zstdCompressSync;
}

/** Real Bun zstd decompressor, if the runtime provides one. */
function bunZstdDecompress(): ((d: Uint8Array) => Uint8Array) | undefined {
  const g = globalThis as {
    Bun?: { zstdDecompressSync?: (d: Uint8Array) => Uint8Array };
  };
  return g.Bun?.zstdDecompressSync;
}

describe("compressJsonBody", () => {
  let hadZstd: boolean;

  beforeEach(() => {
    hadZstd = bunZstd() !== undefined;
    _setZstdProbeForTests(undefined); // restore the live probe
  });

  afterEach(() => {
    _setZstdProbeForTests(undefined);
  });

  it("uses zstd with the gateway magic when Bun zstd is available", async () => {
    if (!hadZstd) return; // nothing to test on a zstd-less runtime
    const { body, encoding } = await compressJsonBody({ a: 1 });
    expect(encoding).toBe("zstd");
    // First 4 bytes must be the zstd frame magic the gateway sniffs.
    expect([...body.subarray(0, 4)]).toEqual(ZSTD_MAGIC);
  });

  it("falls back to gzip when the runtime has no zstd", async () => {
    _setZstdProbeForTests(null);
    const { body, encoding } = await compressJsonBody({ hello: "world" });
    expect(encoding).toBe("gzip");
    expect(JSON.parse(gunzipSync(body).toString("utf8"))).toEqual({
      hello: "world",
    });
  });

  it("falls through to gzip when zstd compression throws", async () => {
    _setZstdProbeForTests(() => {
      throw new Error("zstd blew up");
    });
    const { body, encoding } = await compressJsonBody({ ok: true });
    expect(encoding).toBe("gzip");
    expect(JSON.parse(gunzipSync(body).toString("utf8"))).toEqual({
      ok: true,
    });
  });

  it("round-trips a realistic telemetry payload in the active encoding", async () => {
    const payload = {
      trace_id: "t-1",
      spans: Array.from({ length: 20 }, (_, i) => ({
        name: `span-${i}`,
        dur_ms: i * 1.5,
        tags: { a: "b" },
      })),
      ok: true,
    };
    const { body, encoding } = await compressJsonBody(payload);
    expect(["zstd", "gzip"]).toContain(encoding);
    const text =
      encoding === "zstd"
        ? new TextDecoder().decode(bunZstdDecompress()!(body))
        : gunzipSync(body).toString("utf8");
    expect(JSON.parse(text)).toEqual(payload);
  });
});
