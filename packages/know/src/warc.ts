export type WetRecord = { uri: string; text: string };

/** Return true to skip UTF-8 decode (header-only reject). Body bytes are still consumed. */
export type WarcSkip = (uri: string, type: string, len: number) => boolean;

export type WarcStats = { scanned: number; decoded: number; skippedBodies: number; decodedBytes: number };

export function emptyWarcStats(): WarcStats {
  return { scanned: 0, decoded: 0, skippedBodies: 0, decodedBytes: 0 };
}

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8", { fatal: false });

/** WARC/1.0 or WARC/1.1 — one pass over the view length only (not the backing allocation). */
function indexOfWarc(buf: Uint8Array, start: number): number {
  const last = buf.length - 8;
  for (let i = start; i <= last; i++) {
    if (buf[i] !== 87) continue;
    if (
      buf[i + 1] === 65 &&
      buf[i + 2] === 82 &&
      buf[i + 3] === 67 &&
      buf[i + 4] === 47 &&
      buf[i + 5] === 49 &&
      buf[i + 6] === 46 &&
      (buf[i + 7] === 48 || buf[i + 7] === 49)
    ) {
      return i;
    }
  }
  return -1;
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

function nameIs(buf: Uint8Array, i: number, n: number, want: string): boolean {
  if (n !== want.length) return false;
  for (let k = 0; k < n; k++) {
    let c = buf[i + k]!;
    if (c >= 65 && c <= 90) c += 32;
    if (c !== want.charCodeAt(k)) return false;
  }
  return true;
}

function tokenEnd(buf: Uint8Array, v: number, lineEnd: number): number {
  let e = v;
  while (e < lineEnd && buf[e]! > 32) e++;
  return e;
}

function parseDec(buf: Uint8Array, v: number, lineEnd: number): number {
  let n = 0;
  let any = false;
  for (let i = v; i < lineEnd; i++) {
    const c = buf[i]!;
    if (c < 48 || c > 57) break;
    any = true;
    n = n * 10 + (c - 48);
    if (n > 5_000_000) return n;
  }
  return any ? n : 0;
}

function ciToken(buf: Uint8Array, v: number, e: number, want: string): boolean {
  if (e - v !== want.length) return false;
  for (let k = 0; k < want.length; k++) {
    let c = buf[v + k]!;
    if (c >= 65 && c <= 90) c += 32;
    if (c !== want.charCodeAt(k)) return false;
  }
  return true;
}

function parseWarcHeader(buf: Uint8Array, start: number, end: number): { len: number; type: string; uri: string } {
  let len = 0;
  let type = "";
  let uri = "";
  let i = start;
  while (i < end) {
    let eol = i;
    while (eol < end && buf[eol] !== 10) eol++;
    let lineEnd = eol;
    if (lineEnd > i && buf[lineEnd - 1] === 13) lineEnd--;
    let col = i;
    while (col < lineEnd && buf[col] !== 58) col++;
    if (col < lineEnd) {
      const nameLen = col - i;
      let v = col + 1;
      while (v < lineEnd && (buf[v] === 32 || buf[v] === 9)) v++;
      const te = tokenEnd(buf, v, lineEnd);
      if (nameIs(buf, i, nameLen, "content-length")) len = parseDec(buf, v, lineEnd);
      else if (nameIs(buf, i, nameLen, "warc-type")) {
        if (ciToken(buf, v, te, "conversion")) type = "conversion";
        else if (ciToken(buf, v, te, "response")) type = "response";
        else type = "";
      } else if (nameIs(buf, i, nameLen, "warc-target-uri")) uri = latin1.decode(buf.subarray(v, te));
      if (len > 0 && type && uri) {
        i = end;
        break;
      }
    }
    i = eol + 1;
  }
  return { len, type, uri };
}

/**
 * Incremental WARC/WET parser (conversion/response records). Content-Length is bytes.
 * `skip` is warcio `no_record_parse`: decide from URI/type/length, do not decode payload.
 */
export function pushWarcBytes(
  buf: Uint8Array,
  records: WetRecord[],
  max: number,
  skip?: WarcSkip,
  stats?: WarcStats,
): Uint8Array {
  let offset = 0;
  while (records.length < max) {
    const start = indexOfWarc(buf, offset);
    if (start < 0) {
      const unparsed = buf.subarray(offset);
      if (!unparsed.length) return unparsed;
      const keep = Math.min(unparsed.length, 4096);
      return unparsed.subarray(unparsed.length - keep);
    }
    const head = headerEnd(buf, start);
    if (!head) return buf.subarray(start);
    const restAt = head.end + head.sep;
    const { len, type, uri } = parseWarcHeader(buf, start, head.end);
    if (!Number.isFinite(len) || len < 0 || len > 5_000_000) {
      offset = restAt;
      continue;
    }
    if (buf.length < restAt + len) return buf.subarray(start);
    offset = restAt + len;
    if (stats) stats.scanned++;
    const useful = type === "conversion" || type === "response";
    if (!useful || !uri.startsWith("http") || skip?.(uri, type, len)) {
      if (stats) stats.skippedBodies++;
      continue;
    }
    const text = utf8.decode(buf.subarray(restAt, restAt + len)).trim();
    if (stats) {
      stats.decoded++;
      stats.decodedBytes += text.length;
    }
    if (text.length > 40) records.push({ uri, text });
  }
  return buf.subarray(offset);
}

/** Geometric grow + compact leftover. Replaces O(n²) `buf+chunk` copies. */
export class BytePipe {
  private raw: Uint8Array;
  private start = 0;
  private end = 0;
  copies = 0;

  constructor(cap = 131_072) {
    this.raw = new Uint8Array(Math.max(4096, cap));
  }

  append(value: Uint8Array) {
    if (!value.length) return;
    const used = this.end - this.start;
    const need = used + value.length;
    if (this.end + value.length > this.raw.length) {
      if (this.start > 0) {
        this.raw.copyWithin(0, this.start, this.end);
        this.copies += used;
        this.end = used;
        this.start = 0;
      }
      if (this.end + value.length > this.raw.length) {
        const n = new Uint8Array(Math.max(need, this.raw.length * 2));
        n.set(this.raw.subarray(this.start, this.end));
        this.copies += used;
        this.raw = n;
        this.end = used;
        this.start = 0;
      }
    }
    this.raw.set(value, this.end);
    this.end += value.length;
  }

  view(): Uint8Array {
    return this.raw.subarray(this.start, this.end);
  }

  /** `leftover` from pushWarcBytes (subarray of view, or a copy). */
  setLeftover(leftover: Uint8Array) {
    if (!leftover.length) {
      this.start = 0;
      this.end = 0;
      return;
    }
    if (leftover.buffer === this.raw.buffer) {
      const off = leftover.byteOffset - this.raw.byteOffset;
      this.start = off;
      this.end = off + leftover.length;
      return;
    }
    if (leftover.length > this.raw.length) this.raw = new Uint8Array(leftover.length);
    this.raw.set(leftover, 0);
    this.copies += leftover.length;
    this.start = 0;
    this.end = leftover.length;
  }
}

/** String helper for tests (ASCII fixtures). */
export function pushWarc(buf: string, records: WetRecord[], max: number, skip?: WarcSkip): string {
  const leftover = pushWarcBytes(Buffer.from(buf, "utf8"), records, max, skip);
  return utf8.decode(leftover);
}
