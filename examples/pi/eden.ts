/**
 * Eden in a Pi session — `~/.pi/agent/extensions/eden/index.ts` (or `pi -e eden.ts`).
 *
 * The extension does all of docs/INTEGRATION.md's obligations from Pi's extension API:
 *  - `session_start` when a session opens (D755);
 *  - each new message reported as `user_message` / `agent_message` / `tool_call` / `tool_result` from the `context`
 *    hook (the latest user message waits for its lookup; everything else waits 0);
 *  - packets placed as a leading text block on the user message they answer — mid-turn packets as a trailing
 *    message — and kept in place on later calls (D336, capped, keyed by content hash + copy number);
 *  - `ask_context` registered so the agent can pull context; never reported, never checked;
 *  - acting tool calls checked before they run (`tool_call`), a `finding` blocking the call with the held finding
 *    as its reason (the held result is reported like a tool_result the agent saw);
 *  - held or blocked results reported via `tool_execution_end` too, since a blocked call never reaches
 *    `tool_result`;
 *  - fails open always (D14): Eden down or erroring never stops Pi.
 *
 * Where Eden lives (D856-style): `EDEN_URL` (with `EDEN_API_KEY`/`EDEN_TENANT_ID`, `EDEN_USER_ID`) picks a hosted
 * Eden; otherwise the bundled `eden-local` binary is spawned — found at `EDEN_LOCAL_BINARY`, this extension's own
 * `bin/eden-local`, or `<pi-home>/plugins/eden/bin/eden-local` — with `EDEN_SOURCES_FILE` /
 * `EDEN_USER_SOURCES_FILE` for sources (a `~/.pi/eden/sources.json` is picked up automatically).
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  ASK_CONTEXT_DESCRIPTION,
  EdenClient,
  edenId,
  heldResult,
  LocalEden,
  resolveLocalEden,
  type Injection,
} from "@eden/client";

type Block = { type: string; text?: string; name?: string; id?: string; arguments?: unknown };
type PiMessage = {
  role?: string;
  content?: string | Block[];
  toolCallId?: string;
  toolName?: string;
  id?: string;
};

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

function keyOf(m: PiMessage): string {
  const calls = (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === "toolCall");
  const parts = [
    m.role ?? "?",
    textOf(m.content),
    m.toolCallId ?? "",
    ...(m.id ? [m.id] : []),
    ...calls.map((c) => `${c.name ?? ""}:${c.id ?? ""}`),
  ];
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

function eventsOf(m: PiMessage): {
  kind: string;
  text?: string;
  tool?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  draft?: boolean;
}[] {
  const text = textOf(m.content);
  switch (m.role) {
    case "user":
      return text ? [{ kind: "user_message", text }] : [];
    case "assistant": {
      const out: ReturnType<typeof eventsOf> = [];
      if (text) out.push({ kind: "agent_message", text });
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === "toolCall" && b.name && b.name !== ASK) {
          out.push({ kind: "tool_call", tool: b.name, input: b.arguments ?? {} });
        }
      }
      return out;
    }
    case "toolResult":
      return m.toolName === ASK ? [] : [{ kind: "tool_result", tool: m.toolName ?? "tool", output: text }];
    default:
      return [];
  }
}

interface Pi {
  on(event: string, handler: (event: never, ctx: never) => unknown): unknown;
  registerTool(tool: Record<string, unknown>): unknown;
}
interface PiCtx {
  sessionManager?: { getSessionId?(): string };
  signal?: AbortSignal;
  ui?: { notify?(msg: string, level: string): void };
}

interface Session {
  eden: EdenClient;
  options: Omit<import("@eden/client").EdenClientOptions, "sessionId">;
  sessionId: string; // kept for the client rebuild a sidecar replacement needs
  generation: number | string;
  seen: Map<string, number>;
  kept: Map<string, string>; // message key -> packet text placed before it
  trailing: string[]; // mid-turn packets appended after the last message
  reported: Promise<unknown>;
  queued: Injection[];
  firstCall: boolean;
  local: LocalEden | null;
  reportedResults: Set<string>;
}

/** Live sessions, exported for tests that seed a stub Eden client. */
export const sessions = new Map<string, Session>();

/** Client options minus the ids each session supplies, plus the sidecar to close at session end. */
async function clientOptions(): Promise<{
  options: Omit<import("@eden/client").EdenClientOptions, "sessionId">;
  local: LocalEden | null;
  generation: number | string;
} | null> {
  const resolved = resolveLocalEden(process.env as Record<string, string | undefined>, {
    pluginDir: dirname(fileURLToPath(import.meta.url)),
    home: join(homedir(), ".pi"),
    fallbackDirs: [join(homedir(), ".pi", "agent", "extensions", "eden")],
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
  const home = resolved.home;
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
    kept: new Map(),
    trailing: [],
    queued: [],
    firstCall: true,
    reportedResults: new Set(),
    reported: eden.observe({ kind: "session_start" }, { waitMs: 0 }).then(
      () => undefined,
      () => undefined,
    ),
  };
  sessions.set(key, session);
  return session;
}

function keep(map: Map<string, string>, key: string, text: string, live: Set<string>): void {
  map.set(key, text);
  // Drop placements whose message left the window, then oldest while over the byte cap (D336).
  for (const k of [...map.keys()]) if (!live.has(k)) map.delete(k);
  let bytes = 0;
  for (const t of map.values()) bytes += t.length;
  for (const k of map.keys()) {
    if (bytes <= MAX_KEPT_BYTES) break;
    bytes -= map.get(k)!.length;
    map.delete(k);
  }
}

function sessionKey(ctx: PiCtx): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "default";
  } catch {
    return "default";
  }
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

function report(s: Session, events: ReturnType<typeof eventsOf>, waits: boolean): Promise<Injection | null> {
  return s.reported.then(async () => {
    let last: Injection | null = null;
    for (const ev of events) {
      const { injection } = await s.eden.observe(ev, waits ? {} : { waitMs: 0 });
      if (injection) last = injection;
    }
    return last;
  });
}

export default function eden(pi: Pi): void {
  pi.registerTool({
    name: ASK,
    label: "Ask context",
    description: ASK_CONTEXT_DESCRIPTION,
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "The question, in plain words." } },
      required: ["question"],
    },
    async execute(_id: string, params: { question?: string }, _signal: AbortSignal, _update: unknown, ctx: PiCtx) {
      const text = async () => {
        const s = await sessionFor(sessionKey(ctx));
        if (!s) return "No context available.";
        const client = await liveClient(s);
        const answer = client ? await client.ask(params.question ?? "") : null;
        return answer?.answer ?? "No context available.";
      };
      try {
        return { content: [{ type: "text", text: await text() }], details: {} };
      } catch {
        return { content: [{ type: "text", text: "No context available." }], details: {} };
      }
    },
  });

  // Report each message and inject packets, before every model call.
  pi.on("context", async (event: { messages?: PiMessage[] }, ctx: PiCtx) => {
    const messages = event.messages ?? [];
    try {
      const s = await sessionFor(sessionKey(ctx));
      if (!s) return { messages };
      if (!(await liveClient(s))) return { messages };
      await s.reported.catch(() => undefined);
      const copies = new Map<string, number>();
      const keys = messages.map((m) => {
        const k = keyOf(m);
        const n = (copies.get(k) ?? 0) + 1;
        copies.set(k, n);
        return `${k}#${n}`;
      });
      const lastUser = messages.map((m) => m.role).lastIndexOf("user");
      let turnFresh = false;
      const got: Injection[] = [];
      for (const [i, m] of messages.entries()) {
        if (m.role === "system") continue;
        const k = keys[i]!;
        if (s.seen.has(k)) continue;
        s.seen.set(k, 1);
        if (s.seen.size > MAX_SEEN) s.seen.delete(s.seen.keys().next().value!);
        if (s.firstCall && i < lastUser) continue; // a restarted session reports only its latest user message
        const waits = m.role === "user" && i === lastUser;
        if (waits) turnFresh = true;
        for (const ev of eventsOf(m)) {
          const w = ev.kind === "user_message" && waits;
          const { injection } = await s.eden.observe(ev, w ? {} : { waitMs: 0 });
          if (injection) got.push(injection);
        }
        if (m.role === "toolResult" && m.toolCallId) s.reportedResults.add(m.toolCallId);
      }
      s.firstCall = false;
      got.push(...(await s.eden.pending()), ...s.queued.splice(0));
      if (got.length > 0 && lastUser >= 0) {
        const text = got.map((p) => p.text).join("\n\n");
        if (turnFresh) keep(s.kept, keys[lastUser]!, text, new Set(keys));
        else {
          s.trailing.push(text);
          // Bound the replay list like kept placements (D336): drop the oldest over the byte cap.
          let bytes = 0;
          for (const t of s.trailing) bytes += t.length;
          while (bytes > MAX_KEPT_BYTES && s.trailing.length > 0) {
            bytes -= s.trailing.shift()!.length;
          }
        }
      }
      const out: PiMessage[] = [];
      for (const [i, m] of messages.entries()) {
        const lead = m.role === "user" ? s.kept.get(keys[i]!) : undefined;
        out.push(
          lead
            ? {
                ...m,
                content: [
                  { type: "text", text: lead },
                  ...(typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? [])),
                ],
              }
            : m,
        );
      }
      for (const text of s.trailing) out.push({ role: "user", content: [{ type: "text", text }] });
      return { messages: out };
    } catch {
      return { messages }; // D14
    }
  });

  pi.on("tool_call", async (event: { toolName?: string; toolCallId?: string; input?: unknown }, ctx: PiCtx) => {
    try {
      if (event.toolName === ASK) return undefined;
      const s = await sessionFor(sessionKey(ctx));
      const client = s ? await liveClient(s) : null;
      if (!s || !client) return undefined;
      const check = await client.check(event.toolName ?? "tool", event.input ?? {});
      if (check.verdict !== "finding" || !check.finding) return undefined;
      const held = heldResult(event.toolName ?? "tool", check.finding);
      if (event.toolCallId) {
        s.reportedResults.add(event.toolCallId);
        s.reported = s.reported.then(async () => {
          const { injection } = await client.observe(
            { kind: "tool_result", tool: event.toolName ?? "tool", output: held },
            { waitMs: 0 },
          );
          if (injection) s.queued.push(injection);
        });
      }
      return { block: true, reason: held };
    } catch {
      return undefined; // D14: a check that fails runs the tool.
    }
  });

  const reportResult = async (
    event: {
      toolName?: string;
      toolCallId?: string;
      // tool_result carries `content` blocks; tool_execution_end carries the finished `result`.
      content?: unknown;
      result?: unknown;
      isError?: boolean;
    },
    ctx: PiCtx,
  ) => {
    try {
      if (event.toolName === ASK || !event.toolCallId) return;
      const s = await sessionFor(sessionKey(ctx));
      if (!s || s.reportedResults.has(event.toolCallId)) return;
      s.reportedResults.add(event.toolCallId);
      const client = await liveClient(s);
      if (!client) return;
      const payload = event.content ?? event.result;
      const text =
        typeof payload === "string"
          ? payload
          : Array.isArray(payload)
            ? textOf(payload as Block[])
            : textOf((payload as { content?: Block[] } | null | undefined)?.content);
      s.reported = s.reported.then(async () => {
        const { injection } = await client.observe(
          { kind: "tool_result", tool: event.toolName ?? "tool", output: text, isError: !!event.isError },
          { waitMs: 0 },
        );
        if (injection) s.queued.push(injection);
      });
    } catch {
      // D14
    }
  };
  pi.on("tool_result", reportResult);
  // A blocked or never-executed call reaches tool_execution_end only; report what the agent saw there.
  pi.on("tool_execution_end", reportResult);

  // The last assistant message of a one-shot agent must reach Eden even when no later call carries it.
  pi.on("turn_end", async (event: { message?: PiMessage }, ctx: PiCtx) => {
    try {
      const m = event.message;
      if (!m || m.role !== "assistant") return;
      const s = await sessionFor(sessionKey(ctx));
      if (!s) return;
      const k = `${keyOf(m)}#1`;
      if (s.seen.has(k)) return;
      s.seen.set(k, 1);
      s.reported = report(s, eventsOf(m), false).then((inj) => {
        if (inj) s.queued.push(inj);
      });
    } catch {
      // D14
    }
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: PiCtx) => {
    const key = edenId(sessionKey(ctx));
    const s = sessions.get(key);
    sessions.delete(key);
    try {
      await s?.reported.catch(() => undefined);
      s?.local?.close();
    } catch {
      // Closing is best effort.
    }
  });
}
