/**
 * The streamable HTTP client transport (D1704): each message is one POST; a request's answer comes back as
 * `application/json` (one message or an array) or as a `text/event-stream` read until the response to that request
 * arrives; a notification or response is answered 202. The server's `Mcp-Session-Id` is kept and sent back, and after
 * `initialize` the negotiated version goes in `Mcp-Protocol-Version`.
 *
 * Bounded and defensive, since the server is a third party (D7: trusted to be read-only, not to be well-behaved):
 * - every POST has a deadline (`timeoutMs`) and is aborted at it or at `close`;
 * - a reply's body is read up to `maxResponseBytes` (JSON and SSE alike) and the read is aborted past it; JSON is
 *   shape-checked before it is parsed (`parseJsonBytes`); a JSON body whose only framing is a declared length under
 *   the cap is read natively, which reads exactly that length (`declaredOnly`, D1860);
 * - only the response whose id is the POSTed request's is delivered from that POST; a response to any other id is
 *   dropped (server requests and notifications on the stream go to the client, which answers `ping` only unless the
 *   caller set a handler);
 * - malformed messages and server requests on one reply are budgeted (`ReplyLimits`, D1872): past the budget the reply
 *   fails, so a flood costs a bounded amount of CPU and POSTs;
 * - a redirect is followed only to the same origin (307/308, so the POST stays a POST): the user's credentials never
 *   reach another host;
 * - an error names the HTTP status and Retry-After, never the reply's body or a header that was sent.
 *
 * Opt-in, and off on Eden's own path: resuming a broken SSE reply by `Last-Event-ID` (`resume`, D1873), the standalone
 * GET stream for server-initiated messages (`openServerStream`, D1873), and a bearer token from an `AuthHook` such as
 * `oauth.ts`'s (`auth`, D1874), which `http.ts` does not import. Left out: JSON-RPC batches (removed from MCP in
 * 2025-06-18). The DELETE that ends a session is `terminateSession`, for a caller that wants it (D1860); `close` sends
 * none (the SDK's sends none either), and Eden never calls it. A session the server no longer knows (404 while one is
 * held) closes the transport, so `McpSource` connects again with a fresh `initialize`, as the spec asks.
 */
import { deadlines, type Deadline } from "./deadlines";
import { parseJsonBytes, parseJsonText } from "./json";
import { SseParser } from "./sse";
import { answers, asMessage, isRequest, type JsonRpcId, type JsonRpcMessage, type Transport } from "./types";

export interface StreamableHttpOptions {
  /** Sent on every request, over the protocol's own headers of the same name: the user's credentials. */
  headers?: Record<string, string>;
  /** Largest reply body read, in bytes (default `MAX_RESPONSE_BYTES`). */
  maxResponseBytes?: number;
  /** Deadline of each POST, its reply's body included (default 60 s, the client's request timeout). */
  timeoutMs?: number;
  /** Budgets for what one reply may carry besides its response (`DEFAULT_LIMITS`, D1872). */
  limits?: Partial<ReplyLimits>;
  /**
   * Resume an SSE reply that breaks before its response, with a GET carrying `Last-Event-ID` (D1873), and reconnect
   * the GET stream. Off by default: `true` takes `DEFAULT_RESUME`.
   */
  resume?: boolean | Partial<ResumeOptions>;
  /** A bearer token for every request, renewed on a 401 (`oauth.ts` makes one, D1874). */
  auth?: AuthHook;
  /** Tests. */
  fetch?: typeof fetch;
}

/**
 * What one reply (a POST's, or one connection of the GET stream) may carry besides its response, before it is failed.
 * Budgets, not counts: a server that asks for things as it works, or sends a large reply, gets room in proportion;
 * a flood does not.
 */
export interface ReplyLimits {
  /** Server requests at once (each `ping`, or each request a handler answers, costs a POST). */
  serverRequests: number;
  /** Server requests added to the budget for each second the reply has been open. */
  serverRequestsPerSecond: number;
  /** Messages that are not JSON, not JSON-RPC, or a response to another request, at once. */
  badMessages: number;
  /** Bad messages added to the budget for each MiB the reply has carried. */
  badMessagesPerMiB: number;
}

/**
 * Defaults (D1872). Well-behaved servers send no bad message, and ask at most a few requests a tool call (the SDK's
 * example servers: 0-4, each awaited before the next, so a model's round trip apart); 100 at once and 10 more a second
 * is past any of them. A flood still fails at once: 20,000 pings sent together fail after 100, 2,000,000 junk events
 * of 8 bytes after ~115, and a junk reply's CPU stays proportional to its bytes (a bad message per KiB at most).
 */
export const DEFAULT_LIMITS: ReplyLimits = {
  serverRequests: 100,
  serverRequestsPerSecond: 10,
  badMessages: 100,
  badMessagesPerMiB: 1024,
};

export interface ResumeOptions {
  /** Reconnects of one reply, or failed reconnects in a row of the GET stream, before giving up. */
  maxRetries: number;
  /** The first wait before a reconnect; it doubles each time, unless the server's `retry:` says otherwise. */
  initialDelayMs: number;
  /** The longest wait, whatever `retry:` asks. */
  maxDelayMs: number;
}

export const DEFAULT_RESUME: ResumeOptions = { maxRetries: 3, initialDelayMs: 1_000, maxDelayMs: 30_000 };

/** Where a transport gets a bearer token (D1874). `oauth.ts`'s `OAuthClientProvider` is one. */
export interface AuthHook {
  /** The `Authorization` header for the next request (`Bearer …`), or undefined when there is no token yet. */
  authorization(signal?: AbortSignal): Promise<string | undefined> | string | undefined;
  /**
   * Told of a 401 (or a 403 asking for more scope) with its `WWW-Authenticate`; resolves true when a retry may succeed
   * (a token was obtained or refreshed). Called at most once per request.
   */
  unauthorized(challenge: {
    status: number;
    wwwAuthenticate: string | null;
    url: URL;
    signal?: AbortSignal;
  }): Promise<boolean>;
}

/**
 * Default cap on one reply: twice Eden's own request cap (D100), and far above a tool page (`MAX_LIST_ROWS` rows of a
 * few KB each).
 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * Cap on one `tools/list` reply: a page of tool descriptions, far below the general cap (a 16 MiB page held ~240,000
 * tools). `McpSource` caps what it keeps across pages too. The other listings (`extras.ts`) are pages of the same kind
 * and take the same cap.
 */
export const MAX_TOOLS_LIST_BYTES = 4 * 1024 * 1024;
const LISTS = new Set(["tools/list", "resources/list", "resources/templates/list", "prompts/list"]);
/** Cap on one SSE line or event: Eden's replies are a tool page or a search's rows, far below the whole stream's. */
export const MAX_EVENT_BYTES = 4 * 1024 * 1024;

/** What one reply carried besides its response: counted so a flood fails the reply instead of costing per message. */
interface Tally {
  bad: number;
  asks: number;
  /** Bytes of the messages the reply has carried (a JSON body's, an SSE event's data), for the bad-message budget. */
  bytes: number;
  /** When the reply began (`performance.now()`), for the server-request budget. */
  start: number;
  /** Why the reply is failed, once a count passes its budget. */
  failed: string | null;
}
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
  /** The POST's deadline, on the process's one MCP timer (`deadlines.ts`). */
  deadline: Deadline;
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
  private readonly limits: ReplyLimits;
  private readonly resume: ResumeOptions | null;
  /** The GET stream's connection, while one is open (`openServerStream`); aborted by `close`. */
  private serverStream: AbortController | null = null;
  /**
   * The runtime's own `fetch`, not a caller's nor a replaced global's (an APM agent, a mock, a polyfill): its body
   * framing is the HTTP client's, which the native read trusts.
   */
  private readonly ownFetch: boolean;

  constructor(
    private readonly url: URL,
    private readonly options: StreamableHttpOptions = {},
  ) {
    this.maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
    this.ownFetch = options.fetch === undefined && this.fetchFn === RUNTIME_FETCH && runtimeIsNative;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.resume = options.resume ? { ...DEFAULT_RESUME, ...(options.resume === true ? {} : options.resume) } : null;
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

  /**
   * Ends the session on the server: a DELETE with its id, within the POST deadline and never redirected. A 405 is the
   * server saying it keeps sessions until they expire. Call it before `close` when done; Eden never does (D1860).
   */
  async terminateSession(): Promise<void> {
    if (!this.sessionId || this.state !== "open") return;
    // A flight like any POST: cut at its deadline or by `close`.
    const flight: Flight = { abort: new AbortController(), deadline: undefined as never };
    flight.deadline = deadlines.add(this.timeoutMs, () =>
      cut(flight, new StreamableHttpError(-1, "Request timed out")),
    );
    this.flights.add(flight);
    try {
      const auth = this.options.auth ? await this.options.auth.authorization(flight.abort.signal) : undefined;
      const res = await this.fetchFn(this.url, {
        method: "DELETE",
        headers: auth ? { ...this.headers, authorization: auth } : this.headers,
        signal: flight.abort.signal,
        redirect: "manual",
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok && res.status !== 405) {
        throw new StreamableHttpError(res.status, `Error ending the session (HTTP ${res.status})`);
      }
      this.sessionId = undefined;
      this.headers = this.buildHeaders();
    } catch (e) {
      // Cut at the deadline: say so, as a POST would; cut by `close`, the abort itself.
      const reason = flight.abort.signal.reason;
      throw reason instanceof StreamableHttpError ? reason : e;
    } finally {
      this.land(flight, false);
    }
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    for (const f of this.flights) this.land(f, true);
    this.byId.clear();
    this.serverStream?.abort();
    this.serverStream = null;
    this.onclose?.();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.state !== "open") throw new Error("Not connected");
    const id = isRequest(message) ? message.id : undefined;
    const flight: Flight = { abort: new AbortController(), deadline: undefined as never };
    flight.deadline = deadlines.add(this.timeoutMs, () =>
      cut(flight, new StreamableHttpError(-1, "Request timed out")),
    );
    this.flights.add(flight);
    if (id !== undefined) this.byId.set(id, flight);
    // A cancelled request's POST is cut first, whatever becomes of the notification's own POST: a server that hangs
    // every request must not hold the cancelled one's connection until its deadline.
    if ("method" in message && message.method === "notifications/cancelled") {
      const target = message.params?.requestId;
      const f = typeof target === "string" || typeof target === "number" ? this.byId.get(target) : undefined;
      if (f) this.land(f, true);
    }
    const cap =
      "method" in message && LISTS.has(message.method) ? Math.min(this.maxBytes, MAX_TOOLS_LIST_BYTES) : this.maxBytes;
    let draining = false;
    try {
      draining = await this.post(message, id, flight, cap);
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

  /**
   * Opens the standalone GET stream, on which the server sends requests and notifications outside any request
   * (D1873). Resolves true once it is open, false when the server offers none (405). Its messages go to `onmessage`
   * under the same caps and budgets as a reply's (each connection is a reply: the per-event cap, the reply cap, after
   * which the connection is closed and opened again, and `ReplyLimits`); a response on it is unasked, so dropped and
   * counted. A connection that ends or breaks is opened again with `Last-Event-ID`, waiting as `resume` says (its
   * defaults when unset), until `maxRetries` connections in a row deliver nothing; a reply failed by a budget is not
   * opened again (`onerror` says why). `close` ends it. Eden never opens it.
   */
  async openServerStream(): Promise<boolean> {
    if (this.state !== "open") throw new Error("Not connected");
    if (this.serverStream) return true;
    const stop = new AbortController();
    this.serverStream = stop;
    const resume = this.resume ?? DEFAULT_RESUME;
    let lastEventId: string | null = null;
    let retryMs: number | null = null;
    const connect = async () => {
      const extra: Record<string, string> = { accept: "text/event-stream" };
      if (lastEventId) extra["last-event-id"] = lastEventId;
      return this.fetchAuthed("GET", undefined, stop.signal, extra);
    };
    let res: Response;
    try {
      res = await connect();
    } catch (e) {
      if (this.serverStream === stop) this.serverStream = null;
      throw e;
    }
    if (res.status === 405 || !res.ok || mediaType(res.headers.get("content-type")) !== "text/event-stream") {
      await res.body?.cancel().catch(() => {});
      if (this.serverStream === stop) this.serverStream = null;
      if (res.status === 405) return false;
      throw new StreamableHttpError(res.status, `Error opening the event stream (HTTP ${res.status})`);
    }
    void (async () => {
      let misses = 0;
      while (!stop.signal.aborted && this.state === "open") {
        const got = await this.readServerStream(res, stop.signal, lastEventId, retryMs);
        lastEventId = got.lastEventId;
        retryMs = got.retryMs;
        if (got.failed || stop.signal.aborted) break;
        misses = got.delivered ? 0 : misses + 1;
        if (misses > resume.maxRetries) break;
        try {
          await sleep(delayFor(resume, Math.max(1, misses), retryMs), stop.signal);
          res = await connect();
        } catch {
          misses++;
          continue;
        }
        if (!res.ok || mediaType(res.headers.get("content-type")) !== "text/event-stream") {
          await res.body?.cancel().catch(() => {});
          // The server no longer offers one: stop trying.
          if (res.status === 405 || res.status === 404) break;
          misses++;
          if (misses > resume.maxRetries) break;
        }
      }
      if (this.serverStream === stop) this.serverStream = null;
    })();
    return true;
  }

  /** One connection of the GET stream, read to its end, its cap, its budget or the stop. */
  private async readServerStream(
    res: Response,
    signal: AbortSignal,
    lastEventId: string | null,
    retryMs: number | null,
  ): Promise<{ lastEventId: string | null; retryMs: number | null; delivered: boolean; failed: boolean }> {
    const tally: Tally = { bad: 0, asks: 0, bytes: 0, start: performance.now(), failed: null };
    let delivered = false;
    const parser = new SseParser(
      Math.min(this.maxBytes, MAX_EVENT_BYTES),
      (data) => {
        tally.bytes += data.length;
        const m = parseJsonBytes(data);
        if (m === undefined) this.countBad(tally, "Event stream");
        else if (this.deliver(m, null, tally) || !tally.failed) delivered = true;
        return tally.failed !== null;
      },
      this.ownFetch && isBun,
      true,
    );
    parser.lastEventId = lastEventId;
    parser.retryMs = retryMs;
    if (!res.body) return { lastEventId, retryMs, delivered, failed: false };
    let read = 0;
    const reader = res.body.getReader();
    const onStop = () => void reader.cancel().catch(() => {});
    signal.addEventListener("abort", onStop, { once: true });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        read += value.length;
        // Past the reply cap the connection is closed and opened again: nothing is held across events, so this
        // bounds only how long one connection lives.
        if (read > this.maxBytes || parser.push(value) === "too-large") {
          void reader.cancel().catch(() => {});
          break;
        }
        if (tally.failed) {
          void reader.cancel().catch(() => {});
          this.onerror?.(new StreamableHttpError(-1, tally.failed));
          break;
        }
      }
    } catch {
      // A broken connection: opened again by the caller.
    } finally {
      signal.removeEventListener("abort", onStop);
      this.report(tally);
    }
    return { lastEventId: parser.lastEventId, retryMs: parser.retryMs, delivered, failed: tally.failed !== null };
  }

  /** Ends a flight: its deadline cancelled, and its fetch aborted when `abort` (a body still being read). */
  private land(f: Flight, abort: boolean): void {
    deadlines.cancel(f.deadline);
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
  private async post(
    message: JsonRpcMessage,
    id: JsonRpcId | undefined,
    flight: Flight,
    cap: number,
  ): Promise<boolean> {
    const heldSession = this.sessionId !== undefined;
    const res = await this.fetchAuthed("POST", JSON.stringify(message), flight.abort.signal);
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
      // A request accepted with nothing to read will never be answered here: fail it now, not at the client's 60 s
      // timeout (a server that answers on the GET stream instead does not follow the spec).
      if (id !== undefined) throw new StreamableHttpError(202, "Server accepted the request without answering it");
      return false;
    }
    const type = mediaType(res.headers.get("content-type"));
    const tally: Tally = { bad: 0, asks: 0, bytes: 0, start: performance.now(), failed: null };
    if (type === "application/json") {
      const length = res.headers.get("content-length");
      const declared = Number(length ?? "0");
      if (declared > cap) throw await this.tooLarge(res, cap);
      let data: unknown;
      if (this.ownFetch && length !== null && declaredOnly(res.headers, length)) {
        // The runtime's HTTP client reads exactly the declared length here (no encoding to inflate, no chunked
        // framing to contradict it), so a native read is capped by the check above, at the cost of an uncapped one
        // (D1860). Its deadline still holds: the flight's abort ends the read.
        data = isBun ? parseJsonText(await res.text()) : parseJsonBytes(new Uint8Array(await res.arrayBuffer()));
        tally.bytes = declared;
      } else {
        const bytes = await readCapped(res, cap, flight);
        if (!bytes) throw await this.tooLarge(res, cap);
        data = parseJsonBytes(bytes);
        tally.bytes = bytes.length;
      }
      if (data === undefined) throw new StreamableHttpError(-1, "Reply is not JSON");
      let answered = false;
      for (const m of Array.isArray(data) ? data : [data]) {
        answered = this.deliver(m, id, tally) || answered;
        if (tally.failed) break;
      }
      this.report(tally);
      if (tally.failed) throw new StreamableHttpError(-1, tally.failed);
      if (!answered) throw new StreamableHttpError(-1, "Reply did not answer the request");
      return false;
    }
    if (type === "text/event-stream") return this.readStream(res, id, flight, cap, tally);
    await res.body?.cancel().catch(() => {});
    throw new StreamableHttpError(-1, `Unexpected content type: ${type || "none"}`);
  }

  private async tooLarge(res: Response, cap: number): Promise<StreamableHttpError> {
    await res.body?.cancel().catch(() => {});
    return new StreamableHttpError(-1, `Reply larger than ${cap} bytes`);
  }

  /** One error for what a reply carried that was dropped, however much it was. */
  private report(t: Tally): void {
    if (t.bad > 0) this.onerror?.(new StreamableHttpError(-1, `Reply carried ${t.bad} malformed or unasked messages`));
  }

  /**
   * A request with the auth hook's token, if there is one: on a 401 (or a 403 asking for more scope) the hook is told
   * once, and the request is sent again if it says a new token may succeed. Without a hook, `fetchWithinOrigin`.
   */
  private async fetchAuthed(
    method: string,
    body: string | undefined,
    signal: AbortSignal,
    extra?: Record<string, string>,
  ): Promise<Response> {
    const auth = this.options.auth;
    if (!auth) return this.fetchWithinOrigin(method, body, signal, extra);
    for (let retried = false; ; retried = true) {
      const token = await auth.authorization(signal);
      const res = await this.fetchWithinOrigin(
        method,
        body,
        signal,
        token ? { ...extra, authorization: token } : extra,
      );
      const challenge = res.headers.get("www-authenticate");
      const askedScope = res.status === 403 && challenge !== null && /insufficient_scope/i.test(challenge);
      if (retried || (res.status !== 401 && !askedScope)) return res;
      if (!(await auth.unauthorized({ status: res.status, wwwAuthenticate: challenge, url: this.url, signal }))) {
        return res;
      }
      await res.body?.cancel().catch(() => {});
    }
  }

  /** `fetch` without following a redirect to another origin, which would carry the user's credentials there. */
  private async fetchWithinOrigin(
    method: string,
    body: string | undefined,
    signal: AbortSignal,
    extra?: Record<string, string>,
  ): Promise<Response> {
    let url = this.url;
    const headers = extra ? { ...this.headers, ...extra } : this.headers;
    for (let hop = 0; ; hop++) {
      const res = await this.fetchFn(url, { method, headers, body, signal, redirect: "manual" });
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
   * pool instead of being torn down; true when that drain is running. With `resume`, a stream that ends or breaks
   * before the response is resumed by a GET with the last event's id (D1873), within the same deadline, cap (counted
   * across connections) and budgets.
   */
  private async readStream(res: Response, id: JsonRpcId, flight: Flight, cap: number, tally: Tally): Promise<boolean> {
    if (!res.body) throw new StreamableHttpError(-1, "Empty event stream");
    let reader: Reader = res.body.getReader();
    flight.reader = reader;
    let answered = false;
    // Bun's fetch hands out a new array each read and changes none after: the parser keeps views of them, not copies.
    // A caller's own fetch may reuse one buffer for every chunk, so its chunks are copied as before.
    const parser = () =>
      new SseParser(
        Math.min(cap, MAX_EVENT_BYTES),
        (data) => {
          tally.bytes += data.length;
          const m = parseJsonBytes(data);
          if (m === undefined) this.countBad(tally, "Event stream");
          else answered = this.deliver(m, id, tally);
          return answered || tally.failed !== null;
        },
        this.ownFetch && isBun,
        this.resume !== null,
      );
    let events = parser();
    let read = 0;
    let retries = 0;
    try {
      for (;;) {
        let broken: unknown = null;
        for (;;) {
          let chunk: { done: boolean; value?: Uint8Array };
          try {
            chunk = await reader.read();
          } catch (e) {
            broken = e;
            break;
          }
          if (chunk.done) break;
          const value = chunk.value!;
          read += value.length;
          const step = read > cap ? "too-large" : events.push(value);
          if (step === "too-large") {
            void reader.cancel().catch(() => {});
            throw new StreamableHttpError(-1, `Event stream larger than ${read > cap ? cap : MAX_EVENT_BYTES} bytes`);
          }
          if (tally.failed) {
            void reader.cancel().catch(() => {});
            throw new StreamableHttpError(-1, tally.failed);
          }
          if (step === "stop") {
            void this.drain(reader, read, flight, cap);
            return true;
          }
        }
        const from = events.lastEventId;
        if (!this.resume || !from || retries >= this.resume.maxRetries || flight.abort.signal.aborted) {
          if (broken !== null) throw broken;
          break;
        }
        retries++;
        await sleep(delayFor(this.resume, retries, events.retryMs), flight.abort.signal);
        const again = await this.fetchAuthed("GET", undefined, flight.abort.signal, {
          accept: "text/event-stream",
          "last-event-id": from,
        });
        if (!again.ok || mediaType(again.headers.get("content-type")) !== "text/event-stream" || !again.body) {
          await again.body?.cancel().catch(() => {});
          throw new StreamableHttpError(again.status, `Could not resume the event stream (HTTP ${again.status})`);
        }
        // A new connection starts a new parse (a line cut by the break is gone), from the place it resumed.
        const retryMs = events.retryMs;
        events = parser();
        events.lastEventId = from;
        events.retryMs = retryMs;
        reader = again.body.getReader();
        flight.reader = reader;
      }
    } finally {
      this.report(tally);
    }
    if (!answered) throw new StreamableHttpError(-1, "Event stream ended before the response");
    return false;
  }

  /** Reads what is left of a stream without delivering it; its flight lands when the stream ends or is cut. */
  private async drain(reader: Reader, read: number, flight: Flight, cap: number): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        read += value?.length ?? 0;
        if (read > cap) {
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

  /** Counts a bad message against the reply's budget (`ReplyLimits`). */
  private countBad(tally: Tally, what: "Reply" | "Event stream"): void {
    const allowed = this.limits.badMessages + Math.floor((tally.bytes * this.limits.badMessagesPerMiB) / 1_048_576);
    if (++tally.bad > allowed) tally.failed = `${what} carried over ${allowed} bad messages`;
  }

  /**
   * Delivers one message from a reply; true when it is the response to `id` (`null`: the GET stream, where no response
   * is asked for). A message that is not JSON-RPC, or a response to another id, is dropped and counted; past the
   * budgets the reply is failed (`tally.failed`).
   */
  private deliver(x: unknown, id: JsonRpcId | null, tally: Tally): boolean {
    const m = asMessage(x);
    if (!m || (!("method" in m) && (id === null || !answers(m.id, id)))) {
      this.countBad(tally, "Reply");
      return false;
    }
    if ("method" in m && "id" in m) {
      tally.asks++;
      // The clock is read only when a request comes, which a well-behaved reply holds few of.
      if (tally.asks > this.limits.serverRequests) {
        const open = (performance.now() - tally.start) / 1000;
        const allowed = this.limits.serverRequests + Math.floor(open * this.limits.serverRequestsPerSecond);
        if (tally.asks > allowed) {
          tally.failed = `Reply carried over ${allowed} server requests`;
          return false;
        }
      }
    }
    this.onmessage?.(m);
    return !("method" in m);
  }
}

type Reader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };

/** The wait before reconnect `n` (1 for the first): the server's `retry:` if it gave one, else doubling; capped. */
function delayFor(o: ResumeOptions, n: number, retryMs: number | null): number {
  const ms = retryMs ?? o.initialDelayMs * 2 ** (n - 1);
  return Math.max(0, Math.min(ms, o.maxDelayMs));
}

/** Waits `ms`, or rejects with the signal's reason when it aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The media type of a Content-Type, lower-cased, without parameters. */
function mediaType(contentType: string | null): string {
  if (!contentType) return "";
  const semi = contentType.indexOf(";");
  return (semi < 0 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
}

/** Bun's `fetch` hands out a new array for each read and reads a `text()` as `TextDecoder` does (one BOM dropped). */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * The global `fetch` as this module found it. A transport whose `fetch` is anything else (the global replaced later)
 * reads every body through the capped stream reader. On Bun the one found must also be the native one, so a global
 * replaced before this module loaded is caught too; on Node the runtime's own `fetch` is JavaScript (undici), so there
 * only a replacement made after this module loaded can be told apart.
 */
const RUNTIME_FETCH = globalThis.fetch;
const runtimeIsNative = !isBun || /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(RUNTIME_FETCH));

/**
 * Whether a body's length is the declared one and nothing else: one decimal `Content-Length`, no `Content-Encoding`
 * (the runtime would inflate it past the declared length: 8 KB declared, 8 MB read) and no `Transfer-Encoding` (Bun
 * read a chunked body past a `Content-Length` sent beside it, and until the deadline when it was short, D1840).
 */
function declaredOnly(headers: Headers, length: string): boolean {
  return /^\d{1,10}$/.test(length) && !headers.has("content-encoding") && !headers.has("transfer-encoding");
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
