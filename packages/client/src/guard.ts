/**
 * Check before acting, in one line (D376, D420): wrap the agent's acting tools so each call goes through
 * `EdenClient.check` first, and a finding comes back to the agent as the tool's result instead of the call.
 *
 *   const tools = guardTools(eden, { send_email: sendEmail, book_meeting: bookMeeting });
 *   // each tools.send_email(args) checks first; on a finding it returns heldResult(...) and does not send
 *
 * Eden's party check (`partyCheck`, on in the default) only acts on calls it is shown: an agent that sends, books or
 * pays without `check` gets none of A25's protection (12 followed attacks in 576 tasks, 0 with it). Repeating the
 * same call proceeds (the server keeps a digest of each call it answered with a finding), which is what `heldResult`
 * tells the agent.
 *
 * Fails open (D14): a check that errors, times out or throws, and a `held` policy that throws, all run the tool as if
 * Eden were absent. Errors from the tool itself are the tool's: they reach the caller unchanged.
 */
import type { ActionCheck, Injection } from "@eden/protocol";
import { heldResult } from "./messages";

/** What a guard needs from a client: `EdenClient` has it; a test or a wrapper may pass anything with `check`. */
export interface Checker {
  check(tool: string, input: unknown, options?: { timeoutMs?: number }): Promise<ActionCheck>;
}

export interface GuardOptions<H = string> {
  /**
   * What the agent gets instead of the call when Eden has a finding. Default `heldResult` (hold, show the finding,
   * say how to go ahead). Return something else to ask the user instead, or to log and let the call run.
   */
  held?: (tool: string, finding: Injection, input: unknown) => H | Promise<H>;
  /** The check's timeout (ms); the client's own (800 ms) when unset. */
  timeoutMs?: number;
  /** Called with anything the guard swallowed (a throwing checker or `held`), for the integrator's logs. */
  onError?: (error: unknown) => void;
}

type AnyTool = (input: any) => unknown;
type Guarded<F extends AnyTool, H> = (input: Parameters<F>[0]) => Promise<Awaited<ReturnType<F>> | H>;

function report(onError: ((e: unknown) => void) | undefined, e: unknown): void {
  try {
    onError?.(e);
  } catch {
    // A logger failing is no reason to throw into the agent's loop.
  }
}

/** One tool, checked before it runs. `name` is what Eden is told the tool is called (as the agent calls it). */
export function guardTool<F extends AnyTool, H = string>(
  eden: Checker,
  name: string,
  run: F,
  options: GuardOptions<H> = {},
): Guarded<F, H> {
  return async (input): Promise<Awaited<ReturnType<F>> | H> => {
    let check: ActionCheck | null = null;
    try {
      check = await eden.check(name, input, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
    } catch (e) {
      report(options.onError, e);
    }
    const finding = check?.verdict === "finding" ? check.finding : null;
    if (finding && typeof finding.text === "string") {
      try {
        return options.held ? await options.held(name, finding, input) : (heldResult(name, finding) as H);
      } catch (e) {
        report(options.onError, e);
      }
    }
    const result: Awaited<ReturnType<F>> = await (run(input) as Awaited<ReturnType<F>>);
    return result;
  };
}

/**
 * Every tool in `tools`, each checked before it runs under its own key as its name. Wrap the tools that act (send,
 * book, pay, share, order); a read-only tool gains nothing from a check.
 */
export function guardTools<T extends Record<string, AnyTool>, H = string>(
  eden: Checker,
  tools: T,
  options: GuardOptions<H> = {},
): { [K in keyof T]: Guarded<T[K], H> } {
  const out = {} as { [K in keyof T]: Guarded<T[K], H> };
  for (const name of Object.keys(tools) as (keyof T & string)[]) {
    out[name] = guardTool(eden, name, tools[name]!, options);
  }
  return out;
}
