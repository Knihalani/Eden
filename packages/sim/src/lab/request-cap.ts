/**
 * Lab only: a hard cap on the model requests a run sends, and a pace between them, for free OpenRouter models, whose
 * limits are per account (about 20 requests a minute and 1,000 a day, shared by every run) and whose price is zero, so
 * the dollar cap (`--budget`) never binds. Every attempt counts, retries included: the account's limit counts them.
 *
 * `capped` wraps a fetch: a chat request past the cap fails at once with `RequestCapReached` (nothing is sent), and
 * each request starts at least `gapMs` after the previous one started. Other URLs pass through untouched.
 */
export class RequestCapReached extends Error {}

export interface RequestCap {
  readonly max: number;
  readonly gapMs: number;
  /** Requests sent so far (attempts, retries included). */
  sent: number;
  /** Requests refused at the cap. */
  refused: number;
}

const CHAT = /\/chat\/completions(?:\?|$)/;

export function capped(
  inner: typeof fetch,
  cap: RequestCap,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = () => performance.now(),
): typeof fetch {
  let next = 0;
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!CHAT.test(url)) return inner(input, init);
    if (cap.sent >= cap.max) {
      cap.refused++;
      throw new RequestCapReached(`request cap ${cap.max} reached`);
    }
    cap.sent++;
    // Reserve a start slot before waiting, so concurrent callers queue one gap apart.
    const at = Math.max(now(), next);
    next = at + cap.gapMs;
    const wait = at - now();
    if (wait > 0) await sleep(wait);
    return inner(input, init);
  };
  return Object.assign(wrapped, { preconnect: inner.preconnect }) as typeof fetch;
}
