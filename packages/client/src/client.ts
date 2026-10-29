/**
 * The SDK an agent builder adds to their agent loop. Three calls cover the integration:
 *
 *   const eden = new EdenClient({ apiKey, userId, sessionId });
 *   const { injection } = await eden.observe({ kind: "user_message", text });   // each event
 *   messages = withContext(messages, await eden.collect(injection));            // before each model call
 *   await eden.ask("When is Dana's flight?");                                   // or expose ask as a tool
 *
 * Fails open by design: a network error, a timeout or a non-2xx response yields "no context", never an exception
 * in the agent's loop. Timeouts are short (default 800 ms) because the agent is waiting.
 */
import type { AgentEvent, AskResponse, Injection, ObserveResult } from "@eden/protocol";

export interface EdenClientOptions {
  /** The tenant's API key. Omit it against a dev server (`EDEN_DEV=1`), which refuses any key. */
  apiKey?: string;
  tenantId?: string;
  userId: string;
  sessionId: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Called on a swallowed error, for the integrator's logs. */
  onError?: (error: unknown) => void;
}

type EventInput = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, "tenantId" | "userId" | "sessionId" | "at"> & { at?: number }
    : never
  : never;

export class EdenClient {
  private readonly baseUrl: string;

  constructor(private readonly options: EdenClientOptions) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8790").replace(/\/$/, "");
  }

  private get who() {
    const { tenantId, userId, sessionId } = this.options;
    return { ...(tenantId ? { tenantId } : {}), userId, sessionId };
  }

  private async post<T>(path: string, body: unknown, timeoutMs = this.options.timeoutMs ?? 800): Promise<T | null> {
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
      if (!res.ok) throw new Error(`eden ${path}: ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      try {
        this.options.onError?.(e);
      } catch {
        // The integrator's logger failing is no reason to throw into the agent's loop.
      }
      return null;
    }
  }

  /** Reports an event. Returns context to deliver now, if any. `waitMs` trades latency for a fresher answer. */
  async observe(event: EventInput, options: { waitMs?: number } = {}): Promise<ObserveResult> {
    const wait = options.waitMs ? `?waitMs=${options.waitMs}` : "";
    const timeout = (this.options.timeoutMs ?? 800) + (options.waitMs ?? 0);
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

  /** Tells the partner whether the agent used an injection. Better than the partner's own inference. */
  async feedback(injectionId: string, used: boolean): Promise<void> {
    await this.post("/v1/feedback", { ...this.who, injectionId, used });
  }
}
