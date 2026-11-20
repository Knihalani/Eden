/**
 * Eden as an opencode plugin — `<opencode-home>/plugins/eden.js` (D1991).
 *
 * The plugin does all of docs/INTEGRATION.md's obligations from opencode's V1 hook API:
 *  - `session_start` when a session first appears (D755);
 *  - each new message reported as `user_message` / `agent_message` / `tool_call` / `tool_result` from
 *    `experimental.chat.messages.transform` and `tool.execute.after` (the latest user message waits
 *    for its lookup; everything else waits 0), the turn's last reply on `session.idle`;
 *  - packets injected as `text` parts on the latest user message inside the transform (it rebuilds
 *    the prompt each call, so injections are re-applied — kept alive while the message is in the
 *    window, capped at 64KB — D336);
 *  - `ask_context` registered as a tool; never reported, never checked;
 *  - acting tool calls checked in `tool.execute.before` — a `finding` throws, blocking the call with
 *    the held result as its error (the held result is reported like a tool_result the agent saw);
 *  - fails open always (D14): Eden down or erroring never stops opencode.
 *
 * Where Eden lives: `EDEN_URL` (with `EDEN_API_KEY`/`EDEN_TENANT_ID`, `EDEN_USER_ID`) picks a hosted
 * Eden; otherwise the bundled `eden-local` binary is spawned — found at `EDEN_LOCAL_BINARY`, this
 * plugin's own `bin/eden-local`, or `<opencode-home>/plugins/eden/bin/eden-local` — with
 * `EDEN_SOURCES_FILE` / `EDEN_USER_SOURCES_FILE` for sources (a
 * `~/.config/opencode/eden/sources.json` is picked up automatically).
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { z } from "zod";
import {
  ASK_CONTEXT_DESCRIPTION,
  EdenClient,
  edenId,
  heldResult,
  LocalEden,
  resolveLocalEden,
  type Injection,
} from "@eden/client";

type Block = { type?: string; text?: string; name?: string; id?: string; arguments?: unknown };
type Part = {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: unknown; output?: string; error?: string };
};
type Info = { id?: string; role?: string; sessionID?: string };
type HookMessage = { info: Info; parts: Part[] };

const MAX_KEPT_BYTES = 64_000;
const MAX_SEEN = 4_000;
const ASK = "ask_context";

function envOf(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function textOf(content: string | Block[] | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function hashOf(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

/** The id given to injected parts: deterministic so a persisting list is not re-injected. */
function injectionId(text: string): string {
  return `eden-${hashOf(text)}`;
}

/**
 * A transform message's identity: message id when present (stable across part edits), else the
 * hash of role + every part's identity and text.
 */
function keyOf(m: HookMessage): string {
  if (m.info.id) return `id:${m.info.id}`;
  const parts = [
    m.info.role ?? "?",
    ...m.parts.map((p) => `${p.id ?? ""}:${p.type ?? ""}:${p.tool ?? ""}:${p.callID ?? ""}:${textOf(p.text)}`),
  ];
  return hashOf(...parts);
}

/** A message's content-only key: the same reply hashes the same whatever id opencode assigns. */
function contentKey(m: { role?: string; text?: string }): string {
  return hashOf(m.role ?? "?", m.text ?? "");
}

function eventsOf(m: HookMessage): {
  kind: string;
  text?: string;
  tool?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
}[] {
  const role = m.info.role ?? "user";
  if (role === "user") {
    const text = textOf(m.parts.map((p) => ({ type: p.type, text: p.text })));
    return text ? [{ kind: "user_message", text }] : [];
  }
  if (role !== "assistant") return [];
  // Tool parts are reported from the transform's callID-deduped pass below — emitting a
  // `tool_call` here too would report every call twice.
  const out: ReturnType<typeof eventsOf> = [];
  const text = textOf(m.parts.map((p) => ({ type: p.type, text: p.text })));
  if (text) out.push({ kind: "agent_message", text });
  return out;
}

interface Session {
  eden: EdenClient;
  options: Omit<import("@eden/client").EdenClientOptions, "sessionId">;
  sessionId: string; // kept for the client rebuild a sidecar replacement needs
  generation: number | string;
  seen: Map<string, number>;
  copyCounts: Map<string, number>; // content key -> transcript copies seen, so hook reports take the next copy
  reportedAssistant: Set<string>; // content keys already reported by the event hooks, for transform dedup
  kept: Map<string, { text: string; messageID: string }>; // injection id -> packet anchored to its user message
  trailing: string[]; // mid-turn packets appended after the last user message
  reported: Promise<unknown>;
  queued: Injection[];
  firstCall: boolean;
  local: LocalEden | null;
  reportedCalls: Set<string>; // callIDs already reported as tool_call
  reportedResults: Set<string>; // callIDs already reported as tool_result
}

// Not a named export: opencode's legacy plugin loader calls every export as a plugin function,
// so a Map export would reject the whole module. Tests seed stub clients through globalThis.
const sessions = new Map<string, Session>();
(globalThis as Record<string, unknown>).__edenOpencodeSessions = sessions;

let lastSession = "default";

function ocHome(): string {
  const envHome = envOf("OPENCODE_HOME");
  if (envHome === "~") return homedir();
  if (envHome) return envHome.startsWith("~/") ? join(homedir(), envHome.slice(2)) : envHome;
  // opencode's loader globs `plugins/*.{ts,js}`: an installed plugin is `<home>/plugins/eden.js`
  // (earlier layout: `plugins/eden/index.js`), so the opencode home is the parent of `plugins`.
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const pluginsDir = basename(pluginDir) === "eden" ? dirname(pluginDir) : pluginDir;
  if (basename(pluginsDir) === "plugins") return dirname(pluginsDir);
  const xdg = envOf("XDG_CONFIG_HOME");
  return join(xdg && xdg !== "" ? xdg : join(homedir(), ".config"), "opencode");
}

/** Client options minus the ids each session supplies, plus the sidecar to close at session end. */
async function clientOptions(): Promise<{
  options: Omit<import("@eden/client").EdenClientOptions, "sessionId">;
  local: LocalEden | null;
  generation: number | string;
} | null> {
  const home = ocHome();
  const resolved = resolveLocalEden(process.env as Record<string, string | undefined>, {
    pluginDir: dirname(fileURLToPath(import.meta.url)),
    home,
    fallbackDirs: [join(home, "plugins", "eden")],
  });
  if (!resolved) return null;
  if ("baseUrl" in resolved) {
    return {
      options: {
        userId: resolved.userId,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        tenantId: resolved.tenantId,
      },
      local: null,
      generation: 0,
    };
  }
  const users =
    envOf("EDEN_USER_SOURCES_FILE") ??
    (existsSync(join(home, "eden", "sources.json")) ? join(home, "eden", "sources.json") : undefined);
  const local = new LocalEden([resolved.binary], {
    home: join(home, "eden", "data"),
    sourcesFile: envOf("EDEN_SOURCES_FILE"),
    userSourcesFile: users,
    logPath: join(home, "eden", "logs", "eden-local.log"),
    sharePath: join(home, "eden", "local-endpoint.json"),
  });
  const endpoint = await local.endpoint();
  if (!endpoint) return null;
  return {
    options: {
      userId: envOf("EDEN_USER_ID") ?? "local",
      baseUrl: endpoint.url,
      apiKey: endpoint.token,
      tenantId: "local",
    },
    local,
    generation: endpoint.generation,
  };
}

async function sessionFor(sessionId: string): Promise<Session | null> {
  const key = edenId(sessionId);
  const existing = sessions.get(key);
  if (existing) return existing;
  const made = await clientOptions();
  if (!made) return null;
  const eden = new EdenClient({ ...made.options, sessionId: key });
  const session: Session = {
    eden,
    options: made.options,
    sessionId: key,
    generation: made.generation,
    local: made.local,
    seen: new Map(),
    copyCounts: new Map(),
    reportedAssistant: new Set(),
    kept: new Map(),
    trailing: [],
    queued: [],
    firstCall: true,
    reportedCalls: new Set(),
    reportedResults: new Set(),
    reported: eden.observe({ kind: "session_start" }, { waitMs: 0 }).then(
      () => undefined,
      () => undefined,
    ),
  };
  sessions.set(key, session);
  return session;
}

function sessionKey(sessionId: string | undefined): string {
  if (sessionId) lastSession = sessionId; // tracked for callers whose ctx lacks it (the ask_context tool)
  return sessionId ?? lastSession;
}

async function liveClient(s: Session): Promise<EdenClient | null> {
  if (!s.local) return s.eden;
  const ep = await s.local.endpoint();
  if (!ep) return null;
  // A restarted sidecar listens on a new port with a new token: rebuild the client on the new endpoint.
  if (ep.generation !== s.generation) {
    s.generation = ep.generation;
    s.eden = new EdenClient({ ...s.options, sessionId: s.sessionId, baseUrl: ep.url, apiKey: ep.token });
  }
  return s.eden;
}

async function closeSession(key: string): Promise<void> {
  const s = sessions.get(key);
  sessions.delete(key);
  try {
    await s?.reported.catch(() => undefined);
    s?.local?.close();
  } catch {
    // Closing is best effort.
  }
}

async function endAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map(closeSession));
}

function pushTrailing(s: Session, text: string): void {
  s.trailing.push(text);
  // Bound the replay list like kept placements (D336): drop the oldest over the byte cap.
  let bytes = 0;
  for (const t of s.trailing) bytes += t.length;
  while (bytes > MAX_KEPT_BYTES && s.trailing.length > 0) bytes -= s.trailing.shift()!.length;
}

/** The transform seam: report fresh messages and re-apply packet injections to the live prompt. */
async function transform(output: { messages: HookMessage[] }): Promise<void> {
  const messages = output.messages ?? [];
  const sid = messages.find((m) => m.info.sessionID)?.info.sessionID;
  const s = await sessionFor(sessionKey(sid));
  if (!s) return;
  if (!(await liveClient(s))) return;
  await s.reported.catch(() => undefined);
  const copies = new Map<string, number>();
  const contentCopies = new Map<string, number>();
  const keys = messages.map((m) => {
    const k = keyOf(m);
    const n = (copies.get(k) ?? 0) + 1;
    copies.set(k, n);
    const ck = contentKey({ role: m.info.role, text: textOf(m.parts.map((p) => ({ type: p.type, text: p.text }))) });
    const cn = (contentCopies.get(ck) ?? 0) + 1;
    contentCopies.set(ck, cn);
    s.copyCounts.set(ck, cn);
    return `${k}#${n}`;
  });
  const lastUser = messages.map((m) => m.info.role).lastIndexOf("user");
  let turnFresh = false;
  const got: Injection[] = [];
  for (const [i, m] of messages.entries()) {
    if (m.info.role === "system") continue;
    const k = keys[i]!;
    if (s.seen.has(k)) continue;
    s.seen.set(k, 1);
    if (s.seen.size > MAX_SEEN) s.seen.delete(s.seen.keys().next().value!);
    // A reply the event hooks already reported emits only its non-text events here — its tool
    // calls still reach Eden — even when its transcript id differs.
    const ck = contentKey({
      role: m.info.role,
      text: textOf(m.parts.map((p) => ({ type: p.type, text: p.text }))),
    });
    const hookSeen = m.info.role === "assistant" && s.reportedAssistant.has(ck);
    if (s.firstCall && i < lastUser) continue; // a resumed session reports only its latest user message
    const waits = m.info.role === "user" && i === lastUser;
    if (waits) turnFresh = true;
    for (const ev of eventsOf(m)) {
      if (hookSeen && ev.kind === "agent_message") continue;
      const w = ev.kind === "user_message" && waits;
      const { injection } = await s.eden.observe(ev, w ? {} : { waitMs: 0 });
      if (injection) got.push(injection);
    }
    for (const p of m.parts) {
      if (p.type !== "tool" || !p.callID || p.tool === ASK) continue;
      if (!s.reportedCalls.has(p.callID)) {
        s.reportedCalls.add(p.callID);
        const { injection } = await s.eden.observe(
          { kind: "tool_call", tool: p.tool ?? "tool", input: p.state?.input ?? {} },
          { waitMs: 0 },
        );
        if (injection) got.push(injection);
      }
      if ((p.state?.status === "completed" || p.state?.status === "error") && !s.reportedResults.has(p.callID)) {
        s.reportedResults.add(p.callID);
        const text = p.state.status === "error" ? (p.state.error ?? "") : (p.state.output ?? "");
        const { injection } = await s.eden.observe(
          {
            kind: "tool_result",
            tool: p.tool ?? "tool",
            output: text,
            isError: p.state.status === "error",
          },
          { waitMs: 0 },
        );
        if (injection) got.push(injection);
      }
    }
  }
  s.firstCall = false;
  got.push(...(await s.eden.pending()), ...s.queued.splice(0));
  if (got.length > 0 && lastUser >= 0) {
    const text = got.map((p) => p.text).join("\n\n");
    if (turnFresh) s.kept.set(injectionId(text), { text, messageID: messages[lastUser]!.info.id ?? "" });
    else pushTrailing(s, text);
  }
  // Injections live only for this call (the transform rebuilds the prompt): re-apply every kept
  // packet while under the byte cap, dropping the oldest first (D336).
  let bytes = 0;
  for (const t of s.kept.values()) bytes += t.text.length;
  for (const k of [...s.kept.keys()]) {
    if (bytes <= MAX_KEPT_BYTES) break;
    bytes -= s.kept.get(k)!.text.length;
    s.kept.delete(k);
  }
  if (lastUser < 0) return;
  // A kept packet anchors to the user message it followed: attaching it to the latest message
  // each call would rewrite earlier messages (prompt-prefix churn) and keep the packet alive
  // after its own message left the window.
  const byId = new Map(messages.map((m) => [m.info.id ?? "", m]));
  for (const [id, entry] of [...s.kept]) {
    const target = entry.messageID ? byId.get(entry.messageID) : messages[lastUser];
    if (!target) {
      s.kept.delete(id);
      continue;
    }
    pushPart(target, id, entry.text);
  }
  const last = messages[lastUser]!;
  for (const text of s.trailing) pushPart(last, injectionId(text), text);
}

function pushPart(target: HookMessage, id: string, text: string): void {
  if (target.parts.some((p) => p.id === id)) return;
  target.parts.push({
    id,
    type: "text",
    text,
    sessionID: target.info.sessionID,
    messageID: target.info.id,
  } as Part);
}

/** `session.idle` and `message.updated`: the turn's last reply, which no later transform carries. */
async function reportAssistant(text: string | undefined, sid: string | undefined) {
  try {
    if (!text) return;
    const s = await sessionFor(sessionKey(sid));
    if (!s) return;
    const hash = contentKey({ role: "assistant", text });
    const key = `${hash}#${(s.copyCounts.get(hash) ?? 0) + 1}`;
    if (s.seen.has(key)) return;
    s.seen.set(key, 1);
    s.reportedAssistant.add(hash);
    const client = await liveClient(s);
    if (!client) return;
    s.reported = s.reported.then(async () => {
      const { injection } = await client.observe({ kind: "agent_message", text }, { waitMs: 0 });
      if (injection) s.queued.push(injection);
    });
  } catch {
    // D14
  }
}

export const Eden = async (ctx: {
  client?: {
    session?: {
      messages?: (arg: { path: { id: string } }) => Promise<{ data?: { info: Info; parts: Part[] }[] }>;
    };
  };
}) => ({
  "experimental.chat.messages.transform": async (_input: object, output: { messages: HookMessage[] }) => {
    try {
      await transform(output);
    } catch {
      // D14: a failed transform never stops the prompt build.
    }
  },

  "tool.execute.before": async (
    input: { tool?: string; sessionID?: string; callID?: string },
    output: { args?: unknown },
  ) => {
    try {
      if (input.tool === ASK) return;
      const s = await sessionFor(sessionKey(input.sessionID));
      const client = s ? await liveClient(s) : null;
      if (!s || !client) return;
      if (input.callID && !s.reportedCalls.has(input.callID)) {
        s.reportedCalls.add(input.callID);
        const { injection } = await client.observe(
          { kind: "tool_call", tool: input.tool ?? "tool", input: output.args ?? {} },
          { waitMs: 0 },
        );
        if (injection) s.queued.push(injection);
      }
      const check = await client.check(input.tool ?? "tool", output.args ?? {});
      if (check.verdict !== "finding" || !check.finding) return;
      const held = heldResult(input.tool ?? "tool", check.finding);
      if (input.callID) {
        s.reportedResults.add(input.callID);
        s.reported = s.reported.then(async () => {
          const { injection } = await client.observe(
            { kind: "tool_result", tool: input.tool ?? "tool", output: held },
            { waitMs: 0 },
          );
          if (injection) s.queued.push(injection);
        });
      }
      throw new Error(held); // opencode's block seam: throwing stops the call.
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Not executed:")) throw e;
      return; // D14: a check that fails runs the tool.
    }
  },

  "tool.execute.after": async (
    input: { tool?: string; sessionID?: string; callID?: string; args?: unknown },
    output: { title?: string; output?: string; metadata?: unknown },
  ) => {
    try {
      if (input.tool === ASK || !input.callID) return;
      const s = await sessionFor(sessionKey(input.sessionID));
      if (!s || s.reportedResults.has(input.callID)) return;
      s.reportedResults.add(input.callID);
      const client = await liveClient(s);
      if (!client) return;
      const text =
        typeof output.output === "string" ? output.output : (output.title ?? JSON.stringify(output.output ?? ""));
      s.reported = s.reported.then(async () => {
        const { injection } = await client.observe(
          { kind: "tool_result", tool: input.tool ?? "tool", output: text },
          { waitMs: 0 },
        );
        if (injection) s.queued.push(injection);
      });
    } catch {
      // D14
    }
  },

  event: async (input: { event?: { type?: string; properties?: Record<string, any> } }) => {
    try {
      const event = input.event ?? {};
      const props = event.properties ?? {};
      if (event.type === "session.deleted") {
        await closeSession(edenId(props.info?.id ?? props.id ?? lastSession));
        return;
      }
      // The reply a part's `time.end` finalizes: reported now, not on a later transform that never comes.
      if (event.type === "message.part.updated") {
        const part = props.part as (Part & { time?: { end?: number } }) | undefined;
        if (part?.type === "text" && part.text && part.time?.end !== undefined) {
          await reportAssistant(part.text, props.part?.sessionID ?? props.sessionID);
        }
        return;
      }
      if (event.type === "session.idle") {
        const sid = props.sessionID ?? props.info?.id ?? lastSession;
        // Prefer the stored transcript (the SDK client lists it) for the last reply's real copy number.
        const list = await ctx.client?.session?.messages?.({ path: { id: sid } }).then(
          (r) => r.data,
          () => undefined,
        );
        const assistants = (list ?? []).filter((m) => m.info.role === "assistant");
        const last = assistants.at(-1);
        if (!last) return;
        const hash = contentKey({
          role: "assistant",
          text: textOf(last.parts.map((p) => ({ type: p.type, text: p.text }))),
        });
        const copy = assistants.filter(
          (m) =>
            contentKey({
              role: "assistant",
              text: textOf(m.parts.map((p) => ({ type: p.type, text: p.text }))),
            }) === hash,
        ).length;
        const text = textOf(last.parts.map((p) => ({ type: p.type, text: p.text })));
        const s = await sessionFor(sessionKey(sid));
        if (!s) return;
        const key = `${hash}#${copy || (s.copyCounts.get(hash) ?? 0) + 1}`;
        if (s.seen.has(key)) return;
        await reportAssistant(text, sid);
      }
    } catch {
      // D14: the event hook is observe-only; a failure here is silent by design.
    }
  },

  tool: {
    [ASK]: {
      description: ASK_CONTEXT_DESCRIPTION,
      args: { question: z.string().describe("The question, in plain words.") },
      async execute(args: { question: string }, toolCtx: { sessionID?: string }) {
        try {
          const s = await sessionFor(sessionKey(toolCtx.sessionID));
          if (!s) return "No context available.";
          const client = await liveClient(s);
          const answer = client ? await client.ask(args.question ?? "") : null;
          return answer?.answer ?? "No context available.";
        } catch {
          return "No context available.";
        }
      },
    },
  },

  dispose: async () => {
    await endAll();
  },
});

export default Eden;
