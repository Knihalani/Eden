import { gunzipSync } from "node:zlib";

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
    if (buf && (enc.includes("gzip") || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b))) {
      return JSON.parse(gunzipSync(buf).toString("utf8"));
    }
    if (buf) {
      return JSON.parse(buf.toString("utf8"));
    }
    return JSON.parse(String(raw));
  } catch {
    return init.body;
  }
}
