/**
 * A server-sent events parser over bytes, one pass (D1704). Lines end in LF, CRLF or CR, also when the CR and LF
 * arrive in different chunks; `data:` lines of one event are joined by LF; comments, `id:` and `retry:` are skipped
 * (Eden does not resume streams); a leading byte-order mark is dropped. Bytes are decoded once per event, never per
 * chunk or line. A line split across chunks is kept as a list of its parts and joined once, at its end: joining at
 * every chunk made a long unended line quadratic (an 8 MiB line in 4 KB chunks took 1.6 s). Bounded: a line or an
 * event's data past `maxBytes` fails the parse instead of growing, and nothing here throws on any input.
 */

const LF = 0x0a;
const CR = 0x0d;
const COLON = 0x3a;
const SPACE = 0x20;
const DATA = [0x64, 0x61, 0x74, 0x61]; // "data"
const EVENT = [0x65, 0x76, 0x65, 0x6e, 0x74]; // "event"
const MESSAGE = [0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65]; // "message"

/** What `push` reports: keep reading, or stop (the handler asked to, or a bound was passed). */
export type SseStep = "more" | "stop" | "too-large";

export class SseParser {
  /** The parts of a line not yet ended (empty most of the time: lines rarely straddle chunks), and their bytes. */
  private parts: Uint8Array[] = [];
  private carried = 0;
  /** No line has been read yet: the first may start with a byte-order mark. */
  private atStart = true;
  private skipLf = false;
  private data: Uint8Array = new Uint8Array(1024);
  private dataLen = 0;
  private hasData = false;
  /** The event's type is "message" (or unset): the only one that carries JSON-RPC. */
  private isMessage = true;

  /**
   * @param onEvent Called with each message event's data bytes (a view, valid only during the call); returns true to
   *   stop the parse (the awaited response has arrived).
   */
  constructor(
    private readonly maxBytes: number,
    private readonly onEvent: (data: Uint8Array) => boolean,
  ) {}

  push(chunk: Uint8Array): SseStep {
    let start = 0;
    let i = 0;
    if (this.skipLf && chunk.length > 0) {
      this.skipLf = false;
      if (chunk[0] === LF) start = i = 1;
    }
    for (; i < chunk.length; i++) {
      const c = chunk[i]!;
      if (c !== LF && c !== CR) continue;
      let line = chunk.subarray(start, i);
      if (this.parts.length > 0) {
        if (this.carried + line.length > this.maxBytes) return "too-large";
        line = join(this.parts, this.carried, line);
        this.parts = [];
        this.carried = 0;
      }
      if (c === CR) {
        if (i + 1 < chunk.length) {
          if (chunk[i + 1] === LF) i++;
        } else this.skipLf = true;
      }
      start = i + 1;
      const step = this.line(line);
      if (step !== "more") return step;
    }
    if (start < chunk.length) {
      if (this.carried + chunk.length - start > this.maxBytes) return "too-large";
      // Copied: the caller may reuse its chunk.
      this.parts.push(chunk.slice(start));
      this.carried += chunk.length - start;
    }
    return "more";
  }

  private line(line: Uint8Array): SseStep {
    if (this.atStart) {
      this.atStart = false;
      if (line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) line = line.subarray(3);
    }
    if (line.length > this.maxBytes) return "too-large";
    if (line.length === 0) return this.dispatch();
    if (line[0] === COLON) return "more";
    let colon = line.indexOf(COLON);
    if (colon < 0) colon = line.length;
    let value = colon + 1;
    if (value < line.length && line[value] === SPACE) value++;
    if (startsField(line, colon, DATA)) {
      const v = value <= line.length ? line.subarray(value) : line.subarray(line.length);
      const need = this.dataLen + (this.hasData ? 1 : 0) + v.length;
      if (need > this.maxBytes) return "too-large";
      if (need > this.data.length) {
        const grown = new Uint8Array(Math.min(this.maxBytes, Math.max(need, this.data.length * 2)));
        grown.set(this.data.subarray(0, this.dataLen));
        this.data = grown;
      }
      if (this.hasData) this.data[this.dataLen++] = LF;
      this.data.set(v, this.dataLen);
      this.dataLen += v.length;
      this.hasData = true;
    } else if (startsField(line, colon, EVENT)) {
      const v = value <= line.length ? line.subarray(value) : line.subarray(line.length);
      this.isMessage = v.length === 0 || equals(v, MESSAGE);
    }
    return "more";
  }

  private dispatch(): SseStep {
    const deliver = this.hasData && this.isMessage && this.dataLen > 0;
    const data = this.data.subarray(0, this.dataLen);
    this.dataLen = 0;
    this.hasData = false;
    this.isMessage = true;
    return deliver && this.onEvent(data) ? "stop" : "more";
  }
}

function startsField(line: Uint8Array, colon: number, name: number[]): boolean {
  if (colon !== name.length) return false;
  for (let k = 0; k < name.length; k++) if (line[k] !== name[k]) return false;
  return true;
}

function equals(v: Uint8Array, name: number[]): boolean {
  if (v.length !== name.length) return false;
  for (let k = 0; k < name.length; k++) if (v[k] !== name[k]) return false;
  return true;
}

/** The carried parts of a line and its last piece, in one array. */
function join(parts: Uint8Array[], carried: number, last: Uint8Array): Uint8Array {
  const out = new Uint8Array(carried + last.length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  out.set(last, at);
  return out;
}
