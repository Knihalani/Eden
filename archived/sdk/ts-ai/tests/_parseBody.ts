import { gunzipSync } from "node:zlib";

/** zstd frame magic — matches the gateway's providers.py sniff (N2). */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function decodeBytes(buf: Buffer, enc: string): unknown {
  if (enc.includes("zstd") || (buf.length >= 4 && [...buf.subarray(0, 4)].every((b, i) => b === ZSTD_MAGIC[i]))) {
    const dec = (
      globalThis as {
        Bun?: { zstdDecompressSync?: (d: Uint8Array) => Uint8Array };
      }
    ).Bun?.zstdDecompressSync;
    if (!dec) throw new Error("zstd body but no Bun.zstdDecompressSync");
    return JSON.parse(new TextDecoder().decode(dec(buf)).toString("utf8"));
  }
  if (enc.includes("gzip") || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
    return JSON.parse(gunzipSync(buf).toString("utf8"));
  }
  return JSON.parse(buf.toString("utf8"));
}

export function parseFetchBody(init?: RequestInit): unknown {
  if (!init?.body) return null;
  const headers = new Headers(init.headers as HeadersInit);
  const enc = (headers.get("content-encoding") || "").toLowerCase();
  try {
    const raw = init.body;
    let buf: Buffer | null = null;
    if (typeof raw === "string") {
      buf = Buffer.from(raw, "utf8");
    } else if (Buffer.isBuffer(raw)) {
      buf = raw;
    } else if (raw instanceof ArrayBuffer) {
      buf = Buffer.from(raw);
    } else if (ArrayBuffer.isView(raw)) {
      buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    }
    if (buf) return decodeBytes(buf, enc);
    return JSON.parse(String(raw));
  } catch {
    return init.body;
  }
}
