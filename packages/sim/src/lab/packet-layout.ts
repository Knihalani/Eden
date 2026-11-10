/**
 * A16 (D336): how an integration keeps Eden's packets across a session's requests, as the Pi harness (`--days`,
 * `--day`) emulates it on the wire. Anthropic's prompt cache writes an entry only at a breakpoint (pi-ai puts one on
 * the last tool, the system prompt and the last message), so a packet removed from the transcript changes every later
 * request's prefix from where it stood (`session-cache-probe.ts`):
 *
 * - `kept`: each request's packets stay in the transcript where the agent saw them (the harness's default);
 * - `ephemeral`: only the current request's packets (`@eden/client`'s `withContext`, `@eden/proxy`): every earlier
 *   request is rewritten to the cache on each new request;
 * - `ephemeralBp`: as `ephemeral`, plus a breakpoint on the request's user turn (`userTurnBreakpoint`), so the entry
 *   that ends there outlives the packet after it;
 * - `compact`, `compactUsed` (N3, trial, D517): each request's packets stay, and from the next request on they stay
 *   in their short form (`compactPacket`): every packet, or only one the agent's answer used (`packetUsed`). A packet
 *   changes once, when its request is over, so the prefix is rewritten from there once and is stable again after.
 */
export type PacketLayout = "kept" | "ephemeral" | "ephemeralBp" | "compact" | "compactUsed";

/** The earlier requests' packets a layout keeps in the transcript (`placePackets`' `earlier`). */
export function earlierPackets(layout: PacketLayout, day: readonly (readonly string[])[]): (readonly string[])[] {
  return layout === "ephemeral" || layout === "ephemeralBp" ? day.map(() => []) : [...day];
}

/**
 * `compact`, `compactUsed`: a breakpoint on the last assistant message before the request's user turn. Everything up
 * to it (earlier packets already in their short form) is the same on the next request, while the entry pi-ai writes
 * at the last message holds this request's packet in full and will not match once that is shortened: without this
 * mark every request re-wrote the whole day (a ten-request smoke: cache writes 6.1k → 14.3k tokens).
 */
export function priorTurnBreakpoint(body: { messages?: unknown }): void {
  const msgs = (body.messages ?? []) as Msg[];
  let at = -1;
  for (let k = msgs.length - 1; k >= 0 && at < 0; k--) {
    const m = msgs[k]!;
    if (m.role !== "user") continue;
    const blocks = typeof m.content === "string" ? null : (m.content as Block[]);
    if (blocks === null || (blocks.some((b) => b.type === "text") && !blocks.some((b) => b.type === "tool_result")))
      at = k;
  }
  let prior = at - 1;
  while (prior >= 0 && msgs[prior]!.role !== "assistant") prior--;
  if (prior < 0) return;
  if (JSON.stringify(body).split('"cache_control"').length - 1 >= MAX_BREAKPOINTS) return;
  const m = msgs[prior]!;
  if (typeof m.content === "string") m.content = [{ type: "text", text: m.content }];
  const blocks = m.content as Block[];
  const last = blocks[blocks.length - 1];
  if (last && !last.cache_control) last.cache_control = { type: "ephemeral" };
}

/** Eden's fixed line in a shortened packet (inside the data envelope, like every lead). */
export const COMPACT_NOTE = "Eden: shown in full for the request below when it was made; shortened since.";
/** What a shortened packet keeps of each item line: its source tag, its title and the first words. */
export const COMPACT_ITEM_CHARS = 72;

/**
 * A packet's short form: its envelope, `COMPACT_NOTE` and each item line (`- [source] …`) cut to
 * `COMPACT_ITEM_CHARS`. Eden's own lead lines go (they framed a request that is over). A text that is not an
 * envelope with item lines, or whose short form is not shorter, is returned as it is.
 */
export function compactPacket(text: string): string {
  const lines = text.split("\n");
  const items = lines.filter((l) => l.startsWith("- ["));
  if (lines.length < 3 || !lines[0]!.startsWith("<context") || lines.at(-1) !== "</context>" || !items.length) {
    return text;
  }
  const cut = (l: string) => {
    if (l.length <= COMPACT_ITEM_CHARS) return l;
    const head = l.slice(0, COMPACT_ITEM_CHARS).replace(/[\uD800-\uDBFF]$/, "");
    return `${head.trimEnd()}…`;
  };
  const out = [lines[0]!, COMPACT_NOTE, ...items.map(cut), "</context>"].join("\n");
  return out.length < text.length ? out : text;
}

const WORDS = /[a-z0-9][a-z0-9'’.:/-]*[a-z0-9]|[a-z0-9]/g;
const wordsOf = (text: string) => new Set(text.toLowerCase().match(WORDS) ?? []);

/**
 * `compactUsed`: whether the agent's answer repeated the packet's items: a token of four or more characters with a
 * digit (a date, an amount, an id), or two words of five letters or more, that the request itself did not hold.
 * Eden's own lines and the `[source]` tags are not the items' words.
 */
export function packetUsed(packet: string, request: string, answer: string): boolean {
  const shown = wordsOf(
    packet
      .split("\n")
      .filter((l) => l.startsWith("- ["))
      .map((l) => l.replace(/^- \[[^\]]*\] /, ""))
      .join("\n"),
  );
  const asked = wordsOf(request);
  let hits = 0;
  for (const w of wordsOf(answer)) {
    if (!shown.has(w) || asked.has(w)) continue;
    if (/\d/.test(w) && w.length >= 4) return true;
    if (w.length >= 5 && ++hits >= 2) return true;
  }
  return false;
}

/** A finished request's packets as the layout keeps them for the rest of the session. */
export function keptForm(layout: PacketLayout, packets: readonly string[], request: string, answer: string): string[] {
  if (layout === "compact") return packets.map(compactPacket);
  if (layout === "compactUsed") return packets.map((p) => (packetUsed(p, request, answer) ? compactPacket(p) : p));
  return [...packets];
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
