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
  isId,
  type ActionCheck,
  type AgentEvent,
  type AskResponse,
  type Injection,
  type ObserveResult,
  type SourceChangedReason,
  type SourceChangedResult,
} from "@eden/protocol";

/** The reasons `/v1/sources/changed` gives (`SourceChangedReason`); anything else from a server is dropped. */
const REASONS: ReadonlySet<string> = new Set<SourceChangedReason>(["push-off", "not-synced", "not-notifying"]);

/** The server's id rule (`isId` in @eden/protocol), as its 400s word it. */
const ID_RULE = "1-128 characters of [A-Za-z0-9._:@-]";
/** How much of an error response is read: enough for the server's `{error}`, never a proxy's whole page. */
const ERROR_BODY_BYTES = 2_048;
/** How much of the server's error text reaches `onError`. */
const ERROR_TEXT_CHARS = 300;

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
   * `waitMs` sent on each sent `user_message` observe (not a draft) that passes none of its own (D105, D112).
   * Default `DEFAULT_WAIT_MS` (3,000), the wait the default was measured with: the reader's reading of the request
   * must land before the agent's first model call (D98: a 1 s wait lost 7.6–18.1 points). The server replies as soon
   * as the lookup and reading are done, so the wait is a cap, not a delay. 0 sends none: the server answers at once
   * and what is still running lands in `pending`, which a one-turn answer never reads. Other events never wait. The
   * request's timeout grows by the wait, as for an explicit one.
   */
  defaultWaitMs?: number;
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
  ): Promise<T | null> {
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
      if (!res.ok) throw new Error(`eden ${path}: ${res.status}${await serverError(res)}`);
      return (await res.json()) as T;
    } catch (e) {
      failed?.(e);
      this.report(e);
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
    const waitMs = options.waitMs ?? (sent ? (this.options.defaultWaitMs ?? DEFAULT_WAIT_MS) : undefined);
    const wait = waitMs ? `?waitMs=${waitMs}` : "";
    const timeout = (this.options.timeoutMs ?? 800) + (waitMs ?? 0);
    const body = { ...this.who, at: Date.now(), ...event };
    return (await this.post<ObserveResult>(`/v1/events${wait}`, body, timeout)) ?? { injection: null, pending: false };
  }

  /** Injections queued by slower lookups since the last call. */
  async pending(): Promise<Injection[]> {
    return (await this.post<{ injections: Injection[] }>("/v1/pending", this.who))?.injections ?? [];
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

  /** Tells the partner whether the agent used an injection. Better than the partner's own inference. */
  async feedback(injectionId: string, used: boolean): Promise<void> {
    await this.post("/v1/feedback", { ...this.who, injectionId, used });
  }

  /**
   * Forwards a change notification for one of the user's sources (a Gmail watch, a Calendar or Drive channel, a
   * webhook): with the server's `syncPush`, the source is polled at its next use instead of on a guess. Never throws;
   * resolves false when the partner could not be reached or does not sync that source (`sourceNotice` says why).
   */
  async sourceChanged(sourceId: string): Promise<boolean> {
    return (await this.sourceNotice(sourceId))?.synced === true;
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

  /**
   * Forwards a deletion notification: the source no longer has these refs (a message deleted or recalled, a doc or
   * event removed). Eden drops them at once and holds them as gone, so nothing delivers them again. Never throws;
   * resolves to how many cached items were dropped: 0 is a success when none were cached (the hold still stands), and
   * 0 too when the partner could not be reached, which is reported to `onError`.
   */
  async sourceRemoved(sourceId: string, refs: string[]): Promise<number> {
    const { tenantId, userId } = this.options;
    const res = await this.post<{ removed?: number }>("/v1/sources/removed", {
      ...(tenantId ? { tenantId } : {}),
      userId,
      sourceId,
      refs,
    });
    return typeof res?.removed === "number" ? res.removed : 0;
  }

  /**
   * Forwards the items a change notification carried (a Slack event's message, a trigger's payload): held as synced,
   * with no source call. Never throws; resolves to how many were stored new or changed (0 when unreachable).
   */
  async sourceItems(
    sourceId: string,
    items: {
      ref: string;
      title?: string;
      text: string;
      url?: string;
      updatedAt?: number;
      meta?: Record<string, string>;
    }[],
  ): Promise<number> {
    const { tenantId, userId } = this.options;
    const res = await this.post<{ stored?: number }>("/v1/sources/items", {
      ...(tenantId ? { tenantId } : {}),
      userId,
      sourceId,
      items,
    });
    return typeof res?.stored === "number" ? res.stored : 0;
  }
}
