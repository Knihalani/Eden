/**
 * The SDK an agent builder adds to their agent loop. Three calls cover the integration:
 *
 *   const eden = new EdenClient({ apiKey, userId, sessionId });
 *   const { injection } = await eden.observe({ kind: "user_message", text });   // each event
 *   messages = withContext(messages, await eden.collect(injection));            // before each model call
 *   await eden.ask("When is Dana's flight?");                                   // or expose ask as a tool
 *   const check = await eden.check("send_payment", args);                        // before an action runs
 *
 * Fails open by design: a network error, a timeout or a non-2xx response yields "no context", never an exception
 * in the agent's loop. Timeouts are short (default 800 ms) because the agent is waiting.
 */
import { createHash } from "node:crypto";
import {
  MAX_PUSHED_ITEMS,
  isId,
  type ActionCheck,
  type AgentEvent,
  type AskResponse,
  type ExplainedDecision,
  type Injection,
  type ObserveResult,
  type SourceChangedReason,
  type SourceChangedResult,
} from "@eden/protocol";

/**
 * A failure before any answer (refused connection, DNS, timeout) as an error that says where the client was sending
 * (D365): a runtime's own message ("Unable to connect. Is the computer able to access the url?") names neither the
 * URL nor the route, so a first-time integrator with the server down or on another port could not tell what failed.
 * The base URL is configuration, never the request or the key; no `cause` is kept, since a runtime's error may quote
 * the full URL.
 */
function transportError(path: string, baseUrl: string, timeoutMs: number, e: unknown): Error {
  const route = path.split("?")[0]!;
  const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
  const why = timedOut ? `no answer within ${timeoutMs} ms` : e instanceof Error ? e.message : String(e);
  return new Error(`eden ${route}: cannot reach ${redactUrls(baseUrl)} (${redactUrls(why)})`);
}

/**
 * Text with every URL's credentials and query removed (`user:password@`, `?token=…`, `#…`), so neither the
 * configured base URL nor a runtime message quoting it (Node's fetch quotes a URL that carries credentials) puts a
 * secret in a log.
 */
export function redactUrls(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/]*@)?([^\s?#)]*)(?:[?#][^\s)]*)?/gi, "$1$2");
}

/** The reasons `/v1/sources/changed` gives (`SourceChangedReason`); anything else from a server is dropped. */
const REASONS: ReadonlySet<string> = new Set<SourceChangedReason>(["push-off", "not-synced", "not-notifying"]);

/** The server's id rule (`isId` in @eden/protocol), as its 400s word it. */
const ID_RULE = "1-128 characters of [A-Za-z0-9._:@-]";
/** How much of an error response is read: enough for the server's `{error}`, never a proxy's whole page. */
const ERROR_BODY_BYTES = 2_048;
/** How much of the server's error text reaches `onError`. */
const ERROR_TEXT_CHARS = 300;
/** The server's own cap on an observe's `waitMs` (`/v1/events` clamps to it); the client clamps to the same range. */
const MAX_WAIT_MS = 5_000;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/**
 * Whether `v` can be handed to the agent as an injection: what `withContext` and an integration read (`id`, `text`)
 * are strings. Anything else from a server (a proxy's JSON, an older or broken server) is no context (D14).
 */
const isInjection = (v: unknown): v is Injection =>
  isRecord(v) && typeof v.id === "string" && typeof v.text === "string";

/**
 * Maps any string (an email, a path-like chat id, a long external id) to a valid Eden id, injectively: two different
 * inputs never share an id, because a shared id would merge two users' or sessions' state (D9).
 *
 * - A valid id that does not start with `e:` or `h:` is kept as is (`alice-work@x.com` stays itself).
 * - Otherwise, if it fits, `e:` + a reversible escape over UTF-16 code units: each one outside [A-Za-z0-9.:@-] (`_`
 *   included, it is the escape character) becomes `_` + two hex digits below 0x100, else `_u` + four hex digits, so
 *   `alice+work@x.com` is `e:alice_2bwork@x.com` and `\uD800` is `e:_ud800`. Code units, not UTF-8 bytes: UTF-8
 *   turns every lone surrogate into U+FFFD, which would merge `\uD800` with `\uFFFD`. `u` is not a hex digit, so
 *   the two escape forms cannot be confused.
 * - Otherwise `h:` + the SHA-256 of that escape (ASCII, so hashing it loses nothing) in hex: injective up to a
 *   SHA-256 collision.
 *
 * The three forms cannot meet: kept ids never start with `e:` or `h:`, and the other two differ in their prefix.
 * Map the same way everywhere: the id is how Eden finds the user's state next time.
 */
export function edenId(raw: string): string {
  if (isId(raw) && !raw.startsWith("e:") && !raw.startsWith("h:")) return raw;
  let escaped = "e:";
  for (let i = 0; i < raw.length; i++) {
    const unit = raw.charCodeAt(i);
    const c = raw[i]!;
    if (/[A-Za-z0-9.:@-]/.test(c)) escaped += c;
    else if (unit < 0x100) escaped += `_${unit.toString(16).padStart(2, "0")}`;
    else escaped += `_u${unit.toString(16).padStart(4, "0")}`;
  }
  return escaped.length <= 128 ? escaped : `h:${createHash("sha256").update(escaped).digest("hex")}`;
}

/** Reads at most `max` bytes of a body and cancels the rest; null when the body is longer or unreadable. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) return null;
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The server's `{error}` text on a failed response, bounded, with a leading space; "" when there is none. */
async function serverError(res: Response): Promise<string> {
  try {
    const text = await readCapped(res, ERROR_BODY_BYTES);
    if (text === null) return "";
    const error: unknown = (JSON.parse(text) as { error?: unknown } | null)?.error;
    return typeof error === "string" ? ` ${error.slice(0, ERROR_TEXT_CHARS)}` : "";
  } catch {
    return "";
  }
}

export interface EdenClientOptions {
  /** The tenant's API key. Omit it against a dev server (`EDEN_DEV=1`), which refuses any key. */
  apiKey?: string;
  tenantId?: string;
  userId: string;
  sessionId: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * Called on a swallowed error, for the integrator's logs. Set it: without it a misconfiguration (a refused key or
   * id, a wrong port) looks exactly like Eden's normal silence. A 4xx's message carries the server's reason.
   */
  onError?: (error: unknown) => void;
  /**
   * Shadow mode: what Eden returns is not given to the agent (a trial that only logs it). The server then learns
   * nothing from it as if the agent had been shown it (`?shadow=1` on events and pending).
   */
  shadow?: boolean;
  /**
   * `waitMs` sent on each sent `user_message` observe (not a draft) that passes none of its own (D105, D112).
   * Default `DEFAULT_WAIT_MS` (3,000), the wait the default was measured with: the push's packet (its candidates,
   * D237, after the search and on-demand poll; with `pushCandidates: 0`, the reader's reading, D98: a 1 s wait lost
   * 7.6–18.1 points) must land before the agent's first model call. The server replies as soon as the lookup is done,
   * so the wait is a cap, not a delay. 0 sends none: the server answers at once
   * and what is still running lands in `pending`, which a one-turn answer never reads. Other events never wait. The
   * request's timeout grows by the wait, as for an explicit one.
   */
  defaultWaitMs?: number;
}

/** One item a change notification carried, as the source gives it (`/v1/sources/items`). */
export interface PushedItem {
  /** The source's own id for the item (a message id, an event id): the same ref its listing gives. */
  ref: string;
  title?: string;
  text: string;
  url?: string;
  /** Epoch milliseconds. */
  updatedAt?: number;
  meta?: Record<string, string>;
}

/** What changed at a source, when the notification says (`sourceChanged`'s second argument). */
export interface SourceChange {
  /** Items new or changed, in full. */
  items?: PushedItem[];
  /** Refs the source no longer has (deleted, recalled). */
  removed?: string[];
  /**
   * Refs the source changed or added, when the notification names them but carries no content (a Gmail history's
   * message ids, a Graph or HubSpot webhook's resource id, a Drive changes list): Eden reads them itself, and puts
   * nothing else of the source in doubt (D347). Prefer `items` when the notice has them.
   */
  refs?: string[];
}

/** The observe wait on a sent user message when `defaultWaitMs` is unset (D112): the measured default's wait. */
export const DEFAULT_WAIT_MS = 3_000;

type EventInput = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, "tenantId" | "userId" | "sessionId" | "at"> & { at?: number }
    : never
  : never;

export class EdenClient {
  private readonly baseUrl: string;

  constructor(private readonly options: EdenClientOptions) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8790").replace(/\/$/, "");
    const bad = this.badIds();
    // Every call with a bad id would be refused (400); say so once, up front. The ids themselves stay out of the
    // message (they may be personal data, such as an email). No throw (D14): the calls still fail open.
    if (bad) this.report(new Error(bad));
  }

  /** Which configured ids the server would refuse, as an error message; null when all pass `isId`. */
  private badIds(): string | null {
    const { tenantId, userId, sessionId } = this.options;
    const bad = Object.entries({ tenantId, userId, sessionId })
      // A falsy tenantId is no tenantId, as in `who`: the call omits it and the server takes the tenant from the key.
      .filter(([f, v]) => (f !== "tenantId" || Boolean(v)) && !isId(v))
      .map(([f]) => f);
    return bad.length > 0 ? `eden: ${bad.join(", ")} must be ${ID_RULE} (map ids with edenId)` : null;
  }

  private get who() {
    const { tenantId, userId, sessionId } = this.options;
    return { ...(tenantId ? { tenantId } : {}), userId, sessionId };
  }

  private async post<T>(
    path: string,
    body: unknown,
    timeoutMs = this.options.timeoutMs ?? 800,
    failed?: (e: unknown) => void,
    /** The 2xx answer's expected shape; another is reported and treated as a failure, so callers never see it. */
    valid?: (v: unknown) => boolean,
  ): Promise<T | null> {
    let answered = false;
    try {
      const res = await (this.options.fetch ?? fetch)(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      answered = true;
      if (!res.ok) throw new Error(`eden ${path}: ${res.status}${await serverError(res)}`);
      const answer: unknown = await res.json();
      if (valid && !valid(answer)) {
        const route = path.split("?")[0]!;
        const name = route.slice("/v1/".length);
        throw new Error(`eden ${route}: not ${/^[aeiou]/.test(name) ? "an" : "a"} ${name} answer`);
      }
      return answer as T;
    } catch (e) {
      // An answer that arrived but could not be read is not "cannot reach" (D365).
      const unreadable = () => new Error(`eden ${path.split("?")[0]!}: an unreadable answer`);
      const err =
        e instanceof Error && e.message.startsWith("eden ")
          ? e
          : answered
            ? unreadable()
            : transportError(path, this.baseUrl, timeoutMs, e);
      failed?.(err);
      this.report(err);
      return null;
    }
  }

  private report(e: unknown): void {
    try {
      this.options.onError?.(e);
    } catch {
      // The integrator's logger failing is no reason to throw into the agent's loop.
    }
  }

  /**
   * Reports an event. Returns context to deliver now, if any. `waitMs` trades latency for a fresher answer; without
   * it a sent `user_message` (not a draft) uses `defaultWaitMs` (an explicit 0 sends none).
   */
  async observe(event: EventInput, options: { waitMs?: number } = {}): Promise<ObserveResult> {
    const sent = event.kind === "user_message" && !event.draft;
    const asked = options.waitMs ?? (sent ? (this.options.defaultWaitMs ?? DEFAULT_WAIT_MS) : 0);
    // Clamped to the server's own range: an Infinity, a negative or a NaN would otherwise make the request's timeout
    // invalid, so every observe would fail before it was sent. NaN > 0 is false, so it waits 0 like a negative.
    const waitMs = asked > 0 ? Math.min(MAX_WAIT_MS, asked) : 0;
    const query = [...(waitMs ? [`waitMs=${waitMs}`] : []), ...(this.options.shadow ? ["shadow=1"] : [])];
    const wait = query.length ? `?${query.join("&")}` : "";
    const timeout = (this.options.timeoutMs ?? 800) + waitMs;
    const body = { ...this.who, at: Date.now(), ...event };
    const res = await this.post<ObserveResult>(`/v1/events${wait}`, body, timeout, undefined, (v) => {
      return isRecord(v) && (v.injection === null || v.injection === undefined || isInjection(v.injection));
    });
    return { injection: res?.injection ?? null, pending: res?.pending === true };
  }

  /** Injections queued by slower lookups since the last call. */
  async pending(): Promise<Injection[]> {
    const path = this.options.shadow ? "/v1/pending?shadow=1" : "/v1/pending";
    const res = await this.post<{ injections: unknown[] }>(path, this.who, undefined, undefined, (v) => {
      return isRecord(v) && Array.isArray(v.injections);
    });
    // A malformed element is dropped, not the whole queue: the well-formed ones beside it are still context.
    return (res?.injections ?? []).filter(isInjection);
  }

  /** `observe`'s injection plus anything pending, in one list. */
  async collect(injection: Injection | null): Promise<Injection[]> {
    return [...(injection ? [injection] : []), ...(await this.pending())];
  }

  async ask(question: string, options: { maxItems?: number; timeoutMs?: number } = {}): Promise<AskResponse | null> {
    return this.post<AskResponse>(
      "/v1/ask",
      { ...this.who, question, maxItems: options.maxItems },
      options.timeoutMs ?? 8_000,
      undefined,
      // What an integration reads from an answer; a body without them (a proxy's JSON, `null`) is no answer.
      (v) => isRecord(v) && typeof v.answer === "string" && Array.isArray(v.citations),
    );
  }

  /**
   * The action firewall (`actionCheck` on the server): a tool call the agent is about to make, checked against what
   * Eden holds before it runs. `finding` carries held context that bears on it, as data; what to do with it is the
   * integration's choice (`heldResult` is one: hold the call and show the agent the finding). Fails open: any error,
   * timeout or a server without the flag is `proceed`.
   */
  async check(tool: string, input: unknown, options: { timeoutMs?: number } = {}): Promise<ActionCheck> {
    const body = { ...this.who, at: Date.now(), kind: "tool_call", tool, input };
    const unavailable: ActionCheck = { verdict: "proceed", finding: null, reason: "unavailable", latencyMs: 0 };
    const check = await this.post<ActionCheck>("/v1/check", body, options.timeoutMs);
    if (check === null) return unavailable;
    // An answer of another shape (a proxy's page, an older server) is no check: an integration that reads
    // `finding.text` on a finding must not throw in the agent's loop.
    const finding = check?.verdict === "finding" && typeof check.finding?.text === "string";
    if (!finding && check?.verdict !== "proceed") {
      this.report(new Error("eden /v1/check: not a check"));
      return unavailable;
    }
    return check;
  }

  /**
   * Whether this client's setup works end to end: the server answers and accepts the key, the tenant and the ids.
   * It calls `/v1/whoami`, which changes nothing (unlike `pending`, which drains the queue). Never throws; `error` is
   * the text `onError` also receives.
   */
  async health(options: { timeoutMs?: number } = {}): Promise<{ ok: boolean; error?: string }> {
    let error = "eden: unavailable";
    const res = await this.post<unknown>("/v1/whoami", this.who, options.timeoutMs, (e) => {
      error = e instanceof Error ? e.message : String(e);
    });
    return res === null ? { ok: false, error } : { ok: true };
  }

  /**
   * Why Eden spoke or stayed silent in this session (D277): its last decisions, oldest first, each with a plain
   * sentence (`why`), counts and the ids it delivered or cited; never content. For debugging and logs, not the agent's
   * loop. Never throws: a failure, or an answer of another shape, is `[]` (reported to `onError`).
   */
  async explain(options: { timeoutMs?: number } = {}): Promise<ExplainedDecision[]> {
    const res = await this.post<{ decisions: unknown[] }>(
      "/v1/explain",
      this.who,
      options.timeoutMs,
      undefined,
      (v) => isRecord(v) && Array.isArray(v.decisions),
    );
    return (res?.decisions ?? []).filter(
      (d): d is ExplainedDecision =>
        isRecord(d) && typeof d.decision === "string" && typeof d.why === "string" && Array.isArray(d.itemIds),
    );
  }

  /** Tells the partner whether the agent used an injection. Better than the partner's own inference. */
  async feedback(injectionId: string, used: boolean): Promise<void> {
    await this.post("/v1/feedback", { ...this.who, injectionId, used });
  }

  /**
   * Forwards a change notification for one of the user's sources (a Gmail watch, a Calendar or Drive channel, a Slack
   * event, a webhook). Never throws.
   *
   * Send what the notice names (D421): its refs where the connector reports changed ids (the default), its items
   * where it carries the content; the bare signal only where it names nothing (the slow path: A18, D347).
   *
   * - **With the changed items (`change.items`, deleted refs in `change.removed`; D210).** Eden
   *   holds the items as synced and drops the removed ones at once, with no call to the source: a signal makes the
   *   next lookup poll the source's listing, a payload does not (RealUse-1 part D: 0.22 connector calls a lookup
   *   with payloads, 0.91 with signals). Batches past `MAX_PUSHED_ITEMS` are split. Resolves true when every part
   *   reached the server and was taken, which is not the same as held: a server without `syncPush`, or a source not
   *   synced yet, takes the items and stores none (`sourceItems` resolves 0; `sourceNotice` says why). When a part
   *   did not reach it (unreachable, refused, an answer of another shape), the plain signal is sent as well, so Eden
   *   polls the source rather than miss the change, and it resolves false.
   * - **With the changed refs only (`change.refs`, D347; the default for a notice that names ids, D421):** for a
   *   notice that names what changed but carries no content. Eden reads those refs itself in the background and
   *   puts nothing else of the source in doubt, so the agent's next request waits on no re-read; a ref it cannot read
   *   falls back to the signal on the server. A part not taken (unreachable, or the source not synced and notifying)
   *   sends the plain signal and resolves false.
   * - **Without items (a signal):** with the server's `syncPush`, the source is polled at its next use instead of on a
   *   guess. Resolves false when the partner could not be reached or does not sync that source (`sourceNotice` says
   *   why).
   */
  async sourceChanged(sourceId: string, change?: SourceChange): Promise<boolean> {
    // A JS caller can pass anything: what is not an array sends nothing, so it is read as none (a plain signal).
    const items = Array.isArray(change?.items) ? change.items : [];
    const removed = Array.isArray(change?.removed) ? change.removed : [];
    const refs = Array.isArray(change?.refs) ? change.refs : [];
    if (items.length === 0 && removed.length === 0 && refs.length === 0)
      return (await this.sourceNotice(sourceId))?.synced === true;
    let delivered = true;
    for (let i = 0; i < refs.length; i += MAX_PUSHED_ITEMS) {
      // Not taken as refs (unreachable, or the source is not synced and notifying): the signal below covers it.
      const r = await this.sourceRefsReached(sourceId, refs.slice(i, i + MAX_PUSHED_ITEMS));
      if (r === null || !r.synced) delivered = false;
    }
    for (let i = 0; i < items.length; i += MAX_PUSHED_ITEMS) {
      if ((await this.sourceItemsReached(sourceId, items.slice(i, i + MAX_PUSHED_ITEMS))) === null) delivered = false;
    }
    for (let i = 0; i < removed.length; i += MAX_PUSHED_ITEMS) {
      if ((await this.sourceRemovedReached(sourceId, removed.slice(i, i + MAX_PUSHED_ITEMS))) === null) {
        delivered = false;
      }
    }
    // A part Eden did not take: the signal, so the source's listing is read at its next use instead.
    if (!delivered) await this.sourceNotice(sourceId);
    return delivered;
  }

  /**
   * `sourceChanged` with the server's reason when nothing was synced: "push-off", "not-synced" (an unknown user or
   * source id, a search-only source, or one not synced yet) or "not-notifying" (the source is not declared
   * `notifies`). Never throws; resolves null when the partner could not be reached (reported to `onError`). An older
   * server sends no reason.
   */
  async sourceNotice(sourceId: string): Promise<SourceChangedResult | null> {
    const { tenantId, userId } = this.options;
    const res = await this.post<{ synced?: unknown; reason?: unknown }>("/v1/sources/changed", {
      ...(tenantId ? { tenantId } : {}),
      userId,
      sourceId,
    });
    if (!res) return null;
    const reason = typeof res.reason === "string" && REASONS.has(res.reason) ? res.reason : undefined;
    return { synced: res.synced === true, ...(reason ? { reason: reason as SourceChangedReason } : {}) };
  }

  /** `/v1/sources/refs` (D347): the server's answer, or null when it did not take the call. */
  private async sourceRefsReached(sourceId: string, refs: string[]): Promise<SourceChangedResult | null> {
    const { tenantId, userId } = this.options;
    const res = await this.post<{ synced: boolean; reason?: unknown }>(
      "/v1/sources/refs",
      { ...(tenantId ? { tenantId } : {}), userId, sourceId, refs },
      undefined,
      undefined,
      (v) => isRecord(v) && typeof v.synced === "boolean",
    );
    if (!res) return null;
    const reason = typeof res.reason === "string" && REASONS.has(res.reason) ? res.reason : undefined;
    return { synced: res.synced, ...(reason ? { reason: reason as SourceChangedReason } : {}) };
  }

  /**
   * Forwards a deletion notification: the source no longer has these refs (a message deleted or recalled, a doc or
   * event removed). Eden drops them at once and holds them as gone, so nothing delivers them again. Never throws;
   * resolves to how many cached items were dropped: 0 is a success when none were cached (the hold still stands), and
   * 0 too when the partner could not be reached, which is reported to `onError`.
   */
  async sourceRemoved(sourceId: string, refs: string[]): Promise<number> {
    return (await this.sourceRemovedReached(sourceId, refs)) ?? 0;
  }

  /** `/v1/sources/removed`: how many were dropped, or null when the server did not take the call. */
  private async sourceRemovedReached(sourceId: string, refs: string[]): Promise<number | null> {
    const { tenantId, userId } = this.options;
    const res = await this.post<{ removed: number }>(
      "/v1/sources/removed",
      { ...(tenantId ? { tenantId } : {}), userId, sourceId, refs },
      undefined,
      undefined,
      (v) => isRecord(v) && typeof v.removed === "number",
    );
    return res ? res.removed : null;
  }

  /**
   * Forwards the items a change notification carried (a Slack event's message, a trigger's payload): held as synced,
   * with no source call. Never throws; resolves to how many were stored new or changed (0 when unreachable).
   */
  async sourceItems(sourceId: string, items: PushedItem[]): Promise<number> {
    return (await this.sourceItemsReached(sourceId, items)) ?? 0;
  }

  /** `/v1/sources/items`: how many were stored new or changed, or null when the server did not take the call. */
  private async sourceItemsReached(sourceId: string, items: PushedItem[]): Promise<number | null> {
    const { tenantId, userId } = this.options;
    const res = await this.post<{ stored: number }>(
      "/v1/sources/items",
      { ...(tenantId ? { tenantId } : {}), userId, sourceId, items },
      undefined,
      undefined,
      (v) => isRecord(v) && typeof v.stored === "number",
    );
    return res ? res.stored : null;
  }
}
