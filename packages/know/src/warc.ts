export type WetRecord = { uri: string; text: string };

const WARC10 = Buffer.from("WARC/1.0");
const WARC11 = Buffer.from("WARC/1.1");

function indexOfSub(buf: Uint8Array, start: number, needle: Uint8Array): number {
  const first = needle[0]!;
  const nlen = needle.length;
  outer: for (let i = start; i <= buf.length - nlen; i++) {
    if (buf[i] !== first) continue;
    for (let j = 1; j < nlen; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function indexOfWarc(buf: Uint8Array, start: number): number {
  const a = indexOfSub(buf, start, WARC10);
  const b = indexOfSub(buf, start, WARC11);
  if (a < 0) return b;
  if (b < 0) return a;
  return a < b ? a : b;
}

function headerEnd(buf: Uint8Array, start: number): { end: number; sep: number } | undefined {
  for (let i = start; i < buf.length - 3; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
      return { end: i, sep: 4 };
    }
    if (buf[i] === 10 && buf[i + 1] === 10) return { end: i, sep: 2 };
  }
  return undefined;
}

function headerText(buf: Uint8Array, start: number, end: number): string {
  return new TextDecoder("latin1").decode(buf.subarray(start, end));
}

/** Incremental WARC/WET parser (conversion/response records). Content-Length is bytes. */
export function pushWarcBytes(buf: Uint8Array, records: WetRecord[], max: number): Uint8Array {
  let offset = 0;
  while (records.length < max) {
    const start = indexOfWarc(buf, offset);
    if (start < 0) {
      const keep = Math.min(buf.length, 4096);
      return buf.subarray(buf.length - keep);
    }
    const head = headerEnd(buf, start);
    if (!head) return buf.subarray(start);
    const header = headerText(buf, start, head.end);
    const restAt = head.end + head.sep;
    const lenM = header.match(/Content-Length:\s*(\d+)/i);
    const typeM = header.match(/WARC-Type:\s*(\S+)/i);
    const uriM = header.match(/WARC-Target-URI:\s*(\S+)/i);
    const len = lenM ? Number(lenM[1]) : 0;
    if (!Number.isFinite(len) || len < 0 || len > 5_000_000) {
      offset = restAt;
      continue;
    }
    if (buf.length < restAt + len) return buf.subarray(start);
    const body = buf.subarray(restAt, restAt + len);
    offset = restAt + len;
    const type = (typeM?.[1] || "").toLowerCase();
    const uri = uriM?.[1] || "";
    const text = new TextDecoder("utf-8", { fatal: false }).decode(body).trim();
    if ((type === "conversion" || type === "response") && uri.startsWith("http") && text.length > 40) {
      records.push({ uri, text });
    }
  }
  return buf.subarray(offset);
}

/** String helper for tests (ASCII fixtures). */
export function pushWarc(buf: string, records: WetRecord[], max: number): string {
  const leftover = pushWarcBytes(Buffer.from(buf, "utf8"), records, max);
  return new TextDecoder().decode(leftover);
}
