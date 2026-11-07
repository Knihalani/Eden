/**
 * A16 (D336): how an integration keeps Eden's packets across a session's requests, as the Pi harness (`--days`, `--day`)
 * emulates it on the wire. Pi's prompt cache writes an entry only at a breakpoint (pi-ai puts one on the last tool, the
 * system prompt and the last message), so a packet removed from the transcript changes every later request's prefix
 * from where it stood (`session-cache-probe.ts`):
 *
 * - `kept`: each request's packets stay in the transcript where the agent saw them (the harness's default);
 * - `ephemeral`: only the current request's packets (`@eden/client`'s `withContext`, `@eden/proxy`): every earlier
 *   request is rewritten to the cache on each new request;
 * - `ephemeralBp`: as `ephemeral`, plus a breakpoint on the request's user turn (`userTurnBreakpoint`), so the entry
 *   that ends there outlives the packet after it.
 */
export type PacketLayout = "kept" | "ephemeral" | "ephemeralBp";

/** The earlier requests' packets a layout keeps in the transcript (`placePackets`' `earlier`). */
export function earlierPackets(layout: PacketLayout, day: readonly (readonly string[])[]): (readonly string[])[] {
  return layout === "kept" ? [...day] : day.map(() => []);
}

/** Anthropic's limit on `cache_control` breakpoints in one request. */
const MAX_BREAKPOINTS = 4;

type Block = Record<string, unknown>;
type Msg = { role: string; content: unknown };

/**
 * `ephemeralBp`: a breakpoint on the latest user message that holds text (the request, not a tool result), when
 * something follows it. Nothing is added past Anthropic's four, nor where that turn is already the last message (pi-ai
 * marks the last message itself).
 */
export function userTurnBreakpoint(body: { messages?: unknown }): void {
  const msgs = (body.messages ?? []) as Msg[];
  let at = -1;
  for (let k = msgs.length - 1; k >= 0 && at < 0; k--) {
    const m = msgs[k]!;
    if (m.role !== "user") continue;
    const blocks = typeof m.content === "string" ? null : (m.content as Block[]);
    if (blocks === null || (blocks.some((b) => b.type === "text") && !blocks.some((b) => b.type === "tool_result")))
      at = k;
  }
  if (at < 0 || at === msgs.length - 1) return;
  if (JSON.stringify(body).split('"cache_control"').length - 1 >= MAX_BREAKPOINTS) return;
  const m = msgs[at]!;
  if (typeof m.content === "string") m.content = [{ type: "text", text: m.content }];
  const blocks = m.content as Block[];
  const last = blocks[blocks.length - 1]!;
  if (!last.cache_control) last.cache_control = { type: "ephemeral" };
}
