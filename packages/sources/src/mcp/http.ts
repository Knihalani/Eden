/**
 * The streamable HTTP client transport, as far as Eden uses it (D1704): each message is one POST; a request's answer
 * comes back as `application/json` (one message or an array) or as a `text/event-stream` read until the response to
 * that request arrives; a notification or response is answered 202. The server's `Mcp-Session-Id` is kept and sent
 * back, and after `initialize` the negotiated version goes in `Mcp-Protocol-Version`.
 *
 * Bounded and defensive, since the server is a third party (D7: trusted to be read-only, not to be well-behaved):
 * - every POST has a deadline (`timeoutMs`) and is aborted at it or at `close`;
 * - a reply's body is read up to `maxResponseBytes` (JSON and SSE alike) and the read is aborted past it; JSON is
 *   shape-checked before it is parsed (`parseJsonBytes`);
 * - only the response whose id is the POSTed request's is delivered from that POST; a response to any other id is
 *   dropped (server requests and notifications on the stream go to the client, which answers `ping` only);
 * - a redirect is followed only to the same origin (307/308, so the POST stays a POST): the user's credentials never
 *   reach another host;
 * - an error names the HTTP status and Retry-After, never the reply's body or a header Eden sent.
 *
 * Left out, as Eden needs none of them: the standalone GET stream (server-initiated messages outside a request),
 * resuming a broken stream by `Last-Event-ID`, OAuth (credentials are the operator's static headers), JSON-RPC
 * batches (removed from MCP in 2025-06-18), and the DELETE that ends a session (the SDK's `close` sends none either).
 * A session the server no longer knows (404 while one is held) closes the transport, so `McpSource` connects again
 * with a fresh `initialize`, as the spec asks.
 */
import { parseJsonBytes } from "./json";
import { SseParser } from "./sse";
import { answers, asMessage, isRequest, type JsonRpcId, type JsonRpcMessage, type Transport } from "./types";

export interface StreamableHttpOptions {
  /** Sent on every request, over the protocol's own headers of the same name: the user's credentials. */
  headers?: Record<string, string>;
  /** Largest reply body read, in bytes (default `MAX_RESPONSE_BYTES`). */
  maxResponseBytes?: number;
  /** Deadline of each POST, its reply's body included (default 60 s, the client's request timeout). */
  timeoutMs?: number;
  /** Tests. */
  fetch?: typeof fetch;
}

/**
 * Default cap on one reply: twice Eden's own request cap (D100), and far above a tool page (`MAX_LIST_ROWS` rows of a
 * few KB each).
 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Same-origin redirects followed per request, at most. */
const MAX_REDIRECTS = 5;

/** An HTTP failure, with its status (`-1` when the reply was not a status error). */
export class StreamableHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Streamable HTTP error: ${message}`);
    this.name = "StreamableHttpError";
  }
}

/** One POST in flight: aborted at its deadline, by a cancellation of its request, or by `close`. */
interface Flight {
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
  /**
   * The body being read, cancelled with the abort: a `fetch` errors its body when its signal aborts, but a body that
   * is not the fetch's own (a test's stream, an embedding's fetch) would leave the read waiting.
   */
  reader?: Reader;
}

/** Aborts a flight's fetch and the read of its body, if one is under way. */
function cut(f: Flight, reason?: unknown): void {
  f.abort.abort(reason);
  void f.reader?.cancel().catch(() => {});
}

export class StreamableHttpTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private state: "new" | "open" | "closed" = "new";
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  /** The headers of every POST, built once and again only when the session or the version changes. */
  private headers: Record<string, string>;
  private readonly flights = new Set<Flight>();
  /** Request POSTs by JSON-RPC id, so a `notifications/cancelled` can end that request's stream. */
  private readonly byId = new Map<JsonRpcId, Flight>();
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly url: URL,
    private readonly options: StreamableHttpOptions = {},
  ) {
    this.maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
    this.headers = this.buildHeaders();
  }

  async start(): Promise<void> {
    if (this.state !== "new") throw new Error("StreamableHttpTransport already started");
    this.state = "open";
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
    this.headers = this.buildHeaders();
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    for (const f of this.flights) this.land(f, true);
    this.byId.clear();
    this.onclose?.();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.state !== "open") throw new Error("Not connected");
    const id = isRequest(message) ? message.id : undefined;
    const flight: Flight = { abort: new AbortController(), timer: undefined as never };
    flight.timer = setTimeout(() => cut(flight, new StreamableHttpError(-1, "Request timed out")), this.timeoutMs);
    this.flights.add(flight);
    if (id !== undefined) this.byId.set(id, flight);
    // A cancelled request's POST is cut first, whatever becomes of the notification's own POST: a server that hangs
    // every request must not hold the cancelled one's connection until its deadline.
    if ("method" in message && message.method === "notifications/cancelled") {
      const target = message.params?.requestId;
      const f = typeof target === "string" || typeof target === "number" ? this.byId.get(target) : undefined;
      if (f) this.land(f, true);
    }
    let draining = false;
    try {
      draining = await this.post(message, id, flight);
    } catch (e) {
      const reason = flight.abort.signal.reason;
      const error = reason instanceof StreamableHttpError ? reason : e instanceof Error ? e : new Error(String(e));
      // A request we cancelled, or a close, ends its POST with an abort no one needs to hear about.
      const cancelled = flight.abort.signal.aborted && !(reason instanceof StreamableHttpError);
      if (this.state === "open" && !cancelled) this.onerror?.(error);
      throw error;
    } finally {
      if (!draining) this.land(flight, false);
      if (id !== undefined && this.byId.get(id) === flight) this.byId.delete(id);
    }
  }

  /** Ends a flight: its timer cleared, and its fetch aborted when `abort` (a body still being read). */
  private land(f: Flight, abort: boolean): void {
    clearTimeout(f.timer);
    this.flights.delete(f);
    if (abort) cut(f);
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) h["mcp-protocol-version"] = this.protocolVersion;
    // Lower-cased, so an operator's `Content-Type` replaces ours instead of being sent beside it.
    for (const [k, v] of Object.entries(this.options.headers ?? {})) h[k.toLowerCase()] = v;
    return h;
  }

  /** POSTs one message and reads its reply; true when an SSE stream is left draining in the background. */
  private async post(message: JsonRpcMessage, id: JsonRpcId | undefined, flight: Flight): Promise<boolean> {
    const heldSession = this.sessionId !== undefined;
    const res = await this.fetchWithinOrigin(JSON.stringify(message), flight.abort.signal);
    const sid = res.headers.get("mcp-session-id");
    if (sid && sid !== this.sessionId) {
      // The spec allows visible ASCII only; anything else is not sent back (a header with a line break in it would
      // make every later request fail, or split a header where a runtime let it through).
      if (/^[\x21-\x7e]{1,512}$/.test(sid)) {
        this.sessionId = sid;
        this.headers = this.buildHeaders();
      } else this.onerror?.(new StreamableHttpError(-1, "Server sent a session id that is not visible ASCII"));
    }
    if (!res.ok) {
      // The status, Retry-After and fixed words only: the body is the server's text, and may quote what was sent.
      // D212 reads a 429 and its delay from this message; a 403 or 503 whose text says it is a rate limit (GitHub's
      // way) is marked so too, from the body's first bytes, without quoting them.
      const limited = res.status !== 429 && RATE_LIMIT_TEXT.test(await headText(res, 512, flight));
      await res.body?.cancel().catch(() => {});
      const retry = res.headers.get("retry-after");
      const hint = retry && /^\d{1,6}$/.test(retry.trim()) ? `, retry after ${retry.trim()}` : "";
      const why = `HTTP ${res.status}${limited ? ", rate limited" : ""}${hint}`;
      const error = new StreamableHttpError(res.status, `Error POSTing to endpoint (${why})`);
      if (res.status === 404 && heldSession) setTimeout(() => void this.close(), 0); // after the request has failed
      throw error;
    }
    if (res.status === 202 || id === undefined) {
      await res.body?.cancel().catch(() => {});
      return false;
    }
    const type = mediaType(res.headers.get("content-type"));
    if (type === "application/json") {
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > this.maxBytes) throw await this.tooLarge(res);
      const bytes = await readCapped(res, this.maxBytes, flight);
      if (!bytes) throw await this.tooLarge(res);
      const data = parseJsonBytes(bytes);
      if (data === undefined) throw new StreamableHttpError(-1, "Reply is not JSON");
      let answered = false;
      for (const m of Array.isArray(data) ? data : [data]) answered = this.deliver(m, id) || answered;
      if (!answered) throw new StreamableHttpError(-1, "Reply did not answer the request");
      return false;
    }
    if (type === "text/event-stream") return this.readStream(res, id, flight);
    await res.body?.cancel().catch(() => {});
    throw new StreamableHttpError(-1, `Unexpected content type: ${type || "none"}`);
  }

  private async tooLarge(res: Response): Promise<StreamableHttpError> {
    await res.body?.cancel().catch(() => {});
    return new StreamableHttpError(-1, `Reply larger than ${this.maxBytes} bytes`);
  }

  /** `fetch` without following a redirect to another origin, which would carry the user's credentials there. */
  private async fetchWithinOrigin(body: string, signal: AbortSignal): Promise<Response> {
    let url = this.url;
    for (let hop = 0; ; hop++) {
      const res = await this.fetchFn(url, { method: "POST", headers: this.headers, body, signal, redirect: "manual" });
      if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get("location");
      let target: URL | null = null;
      try {
        target = location ? new URL(location, url) : null;
      } catch {
        target = null;
      }
      // Only 307 and 308 keep the method and body; the others would turn the POST into a GET.
      const follow = target && target.origin === this.url.origin && (res.status === 307 || res.status === 308);
      if (!follow || hop >= MAX_REDIRECTS) {
        const where = target ? `${target.origin}${target.pathname}` : "an unreadable location";
        throw new StreamableHttpError(res.status, `Redirect (HTTP ${res.status}) to ${where} not followed`);
      }
      url = target!;
    }
  }

  /**
   * Reads server-sent events until the response to `id` arrives. The rest of the stream (servers end it right after)
   * is drained in the background within the POST's deadline and cap, so the connection goes back to the keep-alive
   * pool instead of being torn down; true when that drain is running.
   */
  private async readStream(res: Response, id: JsonRpcId, flight: Flight): Promise<boolean> {
    if (!res.body) throw new StreamableHttpError(-1, "Empty event stream");
    const reader = res.body.getReader();
    flight.reader = reader;
    let answered = false;
    const parser = new SseParser(this.maxBytes, (data) => {
      const m = parseJsonBytes(data);
      if (m === undefined) {
        this.onerror?.(new StreamableHttpError(-1, "Event stream carried data that is not JSON"));
        return false;
      }
      answered = this.deliver(m, id);
      return answered;
    });
    let read = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      read += value.length;
      const step = read > this.maxBytes ? "too-large" : parser.push(value);
      if (step === "too-large") {
        void reader.cancel().catch(() => {});
        throw new StreamableHttpError(-1, `Event stream larger than ${this.maxBytes} bytes`);
      }
      if (step === "stop") {
        void this.drain(reader, read, flight);
        return true;
      }
    }
    if (!answered) throw new StreamableHttpError(-1, "Event stream ended before the response");
    return false;
  }

  /** Reads what is left of a stream without delivering it; its flight lands when the stream ends or is cut. */
  private async drain(reader: Reader, read: number, flight: Flight): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        read += value?.length ?? 0;
        if (read > this.maxBytes) {
          void reader.cancel().catch(() => {});
          break;
        }
      }
    } catch {
      // Aborted at the deadline or by close: nothing was waiting on it.
    } finally {
      this.land(flight, false);
    }
  }

  /** Delivers one message from a reply; true when it is the response to `id`. A response to another id is dropped. */
  private deliver(x: unknown, id: JsonRpcId): boolean {
    const m = asMessage(x);
    if (!m) {
      this.onerror?.(new StreamableHttpError(-1, "Server sent a message that is not JSON-RPC 2.0"));
      return false;
    }
    if (!("method" in m) && !answers(m.id, id)) {
      this.onerror?.(new StreamableHttpError(-1, "Server answered a request it was not sent on this reply"));
      return false;
    }
    this.onmessage?.(m);
    return !("method" in m);
  }
}

type Reader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };

/** The media type of a Content-Type, lower-cased, without parameters. */
function mediaType(contentType: string | null): string {
  if (!contentType) return "";
  const semi = contentType.indexOf(";");
  return (semi < 0 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
}

/** The phrases the fan-out reads as a connector's rate limit (`guarded.ts`, D212). */
const RATE_LIMIT_TEXT = /rate.?limit|too many requests/i;

/** At most the first `max` bytes of a body, decoded; "" when there is none or it cannot be read. */
async function headText(res: Response, max: number, flight: Flight): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  flight.reader = reader;
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (text.length < max) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value.subarray(0, max), { stream: true });
    }
  } catch {
    // An error reply that cannot be read says nothing more than its status.
  }
  void reader.cancel().catch(() => {});
  return text.slice(0, max);
}

/** The body's bytes, or null once it passes `max` (the read is cancelled there). */
async function readCapped(res: Response, max: number, flight: Flight): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  flight.reader = reader;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
