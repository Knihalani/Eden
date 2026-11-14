/**
 * A server-sent events parser over bytes, one pass (D1704). Lines end in LF, CRLF or CR, also when the CR and LF
 * arrive in different chunks; `data:` lines of one event are joined by LF; comments are skipped, and so are `id:` and
 * `retry:` unless `track` is set (a transport that resumes streams, D1873; Eden's own path does not); a leading
 * byte-order mark is dropped. Bytes are decoded once per event, never per
 * chunk or line. A line split across chunks is held in `Pieces` and joined once, at its end: joining at every chunk
 * made a long unended line quadratic (an 8 MiB line in 4 KB chunks took 1.6 s), and holding each tiny read as its
 * own array made a line dripped a byte at a time cost ~57 bytes of RSS a byte (D1860). Bounded: a line or an event's
 * data past `maxBytes` fails the parse instead of growing, and nothing here throws on any input.
 */
import { Pieces } from "./pieces";

const LF = 0x0a;
const CR = 0x0d;
const COLON = 0x3a;
const SPACE = 0x20;
const DATA = [0x64, 0x61, 0x74, 0x61]; // "data"
const EVENT = [0x65, 0x76, 0x65, 0x6e, 0x74]; // "event"
const MESSAGE = [0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65]; // "message"
const ID = [0x69, 0x64]; // "id"
const RETRY = [0x72, 0x65, 0x74, 0x72, 0x79]; // "retry"
/** Longest event id kept: it is sent back as a header, so it is visible ASCII and short, or it is not kept. */
const MAX_ID = 512;
const EMPTY = new Uint8Array(0);

/** What `push` reports: keep reading, or stop (the handler asked to, or a bound was passed). */
export type SseStep = "more" | "stop" | "too-large";

export class SseParser {
  /** The bytes of a line not yet ended (none most of the time: lines rarely straddle chunks). */
  private readonly pending = new Pieces();
  /** No line has been read yet: the first may start with a byte-order mark. */
  private atStart = true;
  private skipLf = false;
  /**
   * The event's data while it is one line: a view of that line, not copied (`singleOwned` false while it is a view of
   * the chunk being pushed, which the caller may reuse after `push` returns; it is copied then). A second data line
   * copies it into `data`, where the event's lines are joined. Most events are one line, so most are never copied.
   */
  private single: Uint8Array | null = null;
  private singleOwned = false;
  private data: Uint8Array = EMPTY;
  private dataLen = 0;
  private hasData = false;
  /** The event's type is "message" (or unset): the only one that carries JSON-RPC. */
  private isMessage = true;
  /** With `track`: the id of the last event dispatched (the stream's place, to resume from), or null. */
  lastEventId: string | null = null;
  /** With `track`: the last `retry:` the server asked for, in ms, or null. */
  retryMs: number | null = null;
  /** The id field seen since the last dispatch, committed at the dispatch, as an EventSource does. */
  private idBuffer: string | null = null;

  /**
   * @param onEvent Called with each message event's data bytes (a view, valid only during the call); returns true to
   *   stop the parse (the awaited response has arrived).
   * @param chunksKept The caller never changes a chunk after pushing it (a `fetch` body's reader hands out a new
   *   array each read), so the parser keeps views of it where it would otherwise keep copies (D1840). Default false.
   * @param track Read `id:` and `retry:` into `lastEventId` and `retryMs` (D1873). Default false.
   */
  constructor(
    private readonly maxBytes: number,
    private readonly onEvent: (data: Uint8Array) => boolean,
    private readonly chunksKept = false,
    private readonly track = false,
  ) {}

  push(chunk: Uint8Array): SseStep {
    let start = 0;
    let i = 0;
    if (this.skipLf && chunk.length > 0) {
      this.skipLf = false;
      if (chunk[0] === LF) start = i = 1;
    }
    // Line ends are found with the native `indexOf` (a byte loop here cost eight times the JSON parse it fed: 159 µs
    // a 64 KB event against 19, D1840). A bare CR ends a line too. The next LF and the next CR are each searched once
    // and again only after they are passed, so each byte is read by at most one search for each: searching for LF
    // again at every CR-ended line would read the chunk's rest once a line.
    const n = chunk.length;
    let nextLf = -1;
    let nextCr = -1;
    for (; i < n; i++) {
      if (nextLf < i) {
        nextLf = chunk.indexOf(LF, i);
        if (nextLf < 0) nextLf = n;
      }
      if (nextCr < i) {
        nextCr = chunk.indexOf(CR, i);
        if (nextCr < 0) nextCr = n;
      }
      i = nextLf < nextCr ? nextLf : nextCr;
      if (i >= n) break;
      const c = chunk[i]!;
      let line = chunk.subarray(start, i);
      let owned = false;
      if (this.pending.bytes > 0) {
        if (this.pending.bytes + line.length > this.maxBytes) return "too-large";
        line = this.pending.take(line);
        owned = true;
      }
      if (c === CR) {
        if (i + 1 < n) {
          if (chunk[i + 1] === LF) i++;
        } else this.skipLf = true;
      }
      start = i + 1;
      const step = this.line(line, owned);
      if (step !== "more") return this.keep(step);
    }
    if (start < n) {
      if (this.pending.bytes + n - start > this.maxBytes) return "too-large";
      // A long tail is kept as a view when the caller keeps its chunks as they are (it may reuse one otherwise).
      this.pending.add(chunk.subarray(start), this.chunksKept, this.maxBytes);
    }
    return this.keep("more");
  }

  /** Before `push` returns: an event's one data line still viewing the chunk is copied, as the chunk may be reused. */
  private keep(step: SseStep): SseStep {
    if (this.single && !this.singleOwned && !this.chunksKept) {
      this.single = this.single.slice();
      this.singleOwned = true;
    }
    return step;
  }

  /** One line; `owned` when it is not a view of the pushed chunk (it was joined from parts). */
  private line(line: Uint8Array, owned: boolean): SseStep {
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
      if (!this.hasData) {
        this.single = v;
        this.singleOwned = owned;
        this.dataLen = v.length;
        this.hasData = true;
        return "more";
      }
      const need = this.dataLen + 1 + v.length;
      if (need > this.maxBytes) return "too-large";
      if (this.single) this.spill(need);
      else if (need > this.data.length) {
        const grown = new Uint8Array(Math.min(this.maxBytes, Math.max(need, this.data.length * 2)));
        grown.set(this.data.subarray(0, this.dataLen));
        this.data = grown;
      }
      this.data[this.dataLen++] = LF;
      this.data.set(v, this.dataLen);
      this.dataLen += v.length;
    } else if (startsField(line, colon, EVENT)) {
      const v = value <= line.length ? line.subarray(value) : line.subarray(line.length);
      this.isMessage = v.length === 0 || equals(v, MESSAGE);
    } else if (this.track) this.field(line, colon, value);
    return "more";
  }

  /** `id:` and `retry:`, when tracked. An id that is not short visible ASCII is ignored (it would be sent back). */
  private field(line: Uint8Array, colon: number, value: number): void {
    const v = value <= line.length ? line.subarray(value) : line.subarray(line.length);
    if (startsField(line, colon, ID)) {
      if (v.length > MAX_ID) return;
      for (let k = 0; k < v.length; k++) if (v[k]! < 0x21 || v[k]! > 0x7e) return;
      this.idBuffer = String.fromCharCode(...v);
    } else if (startsField(line, colon, RETRY) && v.length > 0 && v.length <= 9) {
      let ms = 0;
      for (let k = 0; k < v.length; k++) {
        if (v[k]! < 0x30 || v[k]! > 0x39) return;
        ms = ms * 10 + v[k]! - 0x30;
      }
      this.retryMs = ms;
    }
  }

  /** Moves the one-line data into `data`, with room for `need` bytes. */
  private spill(need: number): void {
    const single = this.single!;
    if (need > this.data.length) {
      this.data = new Uint8Array(Math.min(this.maxBytes, Math.max(need, this.data.length * 2, 1024)));
    }
    this.data.set(single, 0);
    this.single = null;
  }

  private dispatch(): SseStep {
    if (this.idBuffer !== null) this.lastEventId = this.idBuffer;
    const deliver = this.hasData && this.isMessage && this.dataLen > 0;
    const data = this.single ?? this.data.subarray(0, this.dataLen);
    this.single = null;
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
