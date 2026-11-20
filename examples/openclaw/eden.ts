/**
 * Eden as an OpenClaw plugin — `<openclaw-home>/extensions/eden/index.js` with `openclaw.plugin.json`.
 *
 * The plugin does all of docs/INTEGRATION.md's obligations from OpenClaw's typed hook API:
 *  - `session_start` when a session opens (D755);
 *  - each new message reported as `user_message` / `agent_message` / `tool_call` / `tool_result` from
 *    `before_prompt_build`, `after_tool_call` and `agent_end`/`llm_output` (the latest user message
 *    waits for its lookup; everything else waits 0);
 *  - packets placed ahead of the turn that needs them via `prependContext`, mid-turn packets via
 *    `appendContext`, kept in place on later calls (D336, capped, keyed by content hash + copy number);
 *  - `ask_context` registered so the agent can pull context; never reported, never checked;
 *  - acting tool calls checked before they run (`before_tool_call`), a `finding` blocking the call
 *    with the held finding as `blockReason` (the held result is reported like a tool_result the agent
 *    saw);
 *  - fails open always (D14): Eden down or erroring never stops OpenClaw.
 *
 * Conversation hooks need a grant in `openclaw.json`:
 *   {"plugins": {"entries": {"eden": {"enabled": true, "hooks": {"allowConversationAccess": true}}}}}
 *
 * Where Eden lives (D856-style): `EDEN_URL` (with `EDEN_API_KEY`/`EDEN_TENANT_ID`, `EDEN_USER_ID`)
 * picks a hosted Eden; otherwise the bundled `eden-local` binary is spawned — found at
 * `EDEN_LOCAL_BINARY`, this plugin's own `bin/eden-local`, or `<openclaw-home>/extensions/eden/bin/eden-local`
 * — with `EDEN_SOURCES_FILE` / `EDEN_USER_SOURCES_FILE` for sources (a
 * `~/.openclaw/eden/sources.json` is picked up automatically).
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

type Block = { type?: string; text?: string; name?: string; id?: string; arguments?: unknown };
type HookMessage = {
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

function keyOf(m: HookMessage): string {
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

/** A message's content-only key: the same reply hashes the same with or without a transcript id. */
function contentKey(m: { role?: string; content?: string | Block[] }): string {
  return keyOf({ role: m.role, content: textOf(m.content) });
}

function eventsOf(m: HookMessage): {
  kind: string;
  text?: string;
  tool?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
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

interface ClawApi {
  on(event: string, handler: (event: never, ctx: never) => unknown, opts?: unknown): unknown;
  registerTool(factory: (ctx: unknown) => Record<string, unknown>, opts?: unknown): unknown;
}
interface HookCtx {
  sessionKey?: string;
  sessionId?: string;
}

interface Session {
  eden: EdenClient;
  options: Omit<import("@eden/client").EdenClientOptions, "sessionId">;
  generation: number | string;
  seen: Map<string, number>;
  copyCounts: Map<string, number>; // content key -> transcript copies seen, so hook reports take the next copy
  reportedAssistant: Set<string>; // content keys already reported by the reply hooks, for transcript dedup
  kept: Map<string, string>; // user-message key -> packet text prepended while it is live
  trailing: string[]; // mid-turn packets appended to context on later calls
  reported: Promise<unknown>;
  queued: Injection[];
  firstCall: boolean;
  local: LocalEden | null;
  reportedResults: Set<string>;
}

/** Live sessions, exported for tests that seed a stub Eden client. */
export const sessions = new Map<string, Session>();

let lastSession = "default";

function clawHome(): string {
  const envHome = envOf("OPENCLAW_HOME");
  // '~' is not expanded for env values; a literal tilde home would resolve under the cwd.
  if (envHome === "~") return homedir();
  if (envHome) return envHome.startsWith("~/") ? join(homedir(), envHome.slice(2)) : envHome;
  // An installed plugin sits at `<home>/extensions/eden/index.js` (or `plugins/eden` on older layouts):
  // its grandparent is the OpenClaw home, so sources/data beside it are found on custom installs.
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const grandparent = dirname(dirname(pluginDir));
  if (pluginDir === join(grandparent, "extensions", "eden") || pluginDir === join(grandparent, "plugins", "eden")) {
    return grandparent;
  }
  return join(homedir(), ".openclaw");
}

/** Client options minus the ids each session supplies, plus the sidecar to close at session end. */
async function clientOptions(): Promise<{
  options: Omit<import("@eden/client").EdenClientOptions, "sessionId">;
  local: LocalEden | null;
} | null> {
  const home = clawHome();
  const resolved = resolveLocalEden(process.env as Record<string, string | undefined>, {
    pluginDir: dirname(fileURLToPath(import.meta.url)),
    home,
    fallbackDirs: [join(home, "extensions", "eden"), join(home, "plugins", "eden")],
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
    generation: 1,
    local: made.local,
    seen: new Map(),
    copyCounts: new Map(),
    reportedAssistant: new Set(),
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

function pushTrailing(s: Session, text: string): void {
  s.trailing.push(text);
  // Bound the replay list like kept placements (D336): drop the oldest over the byte cap.
  let bytes = 0;
  for (const t of s.trailing) bytes += t.length;
  while (bytes > MAX_KEPT_BYTES && s.trailing.length > 0) bytes -= s.trailing.shift()!.length;
}

function sessionKey(ctx: HookCtx | undefined): string {
  const key = ctx?.sessionKey ?? ctx?.sessionId;
  if (key) lastSession = key; // tracked for hooks whose ctx lacks it (e.g. the ask_context tool)
  return key ?? lastSession;
}

async function liveClient(s: Session): Promise<EdenClient | null> {
  if (!s.local) return s.eden;
  const ep = await s.local.endpoint();
  if (!ep) return null;
  // A restarted sidecar listens on a new port with a new token: rebuild the client on the new endpoint.
  if (ep.generation !== s.generation) {
    s.generation = ep.generation;
    s.eden = new EdenClient({ ...s.options, baseUrl: ep.url, apiKey: ep.token });
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

// The entry object matches `definePluginEntry`'s normalized shape without depending on the
// plugin-sdk package, so the bundled index.js runs with no external imports.
const entry = {
  id: "eden",
  name: "Eden",
  description: "Eden context partner: read-only context injection, ask_context, and the party check.",
  configSchema: { type: "object", additionalProperties: false },
  register(api: ClawApi): void {
    api.registerTool(
      (toolCtx: unknown) => ({
        name: ASK,
        label: "Ask context",
        description: ASK_CONTEXT_DESCRIPTION,
        parameters: {
          type: "object",
          properties: { question: { type: "string", description: "The question, in plain words." } },
          required: ["question"],
        },
        execute: async (_id: string, params: { question?: string }) => {
          try {
            // The tool's ctx carries the conversation's session when OpenClaw provides one; the last
            // hook-seen session is the fallback so answers land where the party check looks (SEC).
            const s = await sessionFor(sessionKey(toolCtx as HookCtx));
            if (!s) return { content: [{ type: "text", text: "No context available." }] };
            const client = await liveClient(s);
            const answer = client ? await client.ask(params.question ?? "") : null;
            return { content: [{ type: "text", text: answer?.answer ?? "No context available." }] };
          } catch {
            return { content: [{ type: "text", text: "No context available." }] };
          }
        },
      }),
      { name: ASK },
    );

    // Report each message and inject packets, before every prompt build.
    api.on("before_prompt_build", async (event: { prompt?: string; messages?: HookMessage[] }, ctx: HookCtx) => {
      const prompt = typeof event.prompt === "string" ? event.prompt : "";
      const messages: HookMessage[] = [
        ...(event.messages ?? []),
        ...(prompt ? [{ role: "user", content: prompt }] : []),
      ];
      try {
        const s = await sessionFor(sessionKey(ctx));
        if (!s) return undefined;
        if (!(await liveClient(s))) return undefined;
        await s.reported.catch(() => undefined);
        const copies = new Map<string, number>();
        const contentCopies = new Map<string, number>();
        const keys = messages.map((m) => {
          const k = keyOf(m);
          const n = (copies.get(k) ?? 0) + 1;
          copies.set(k, n);
          const ck = contentKey(m);
          const cn = (contentCopies.get(ck) ?? 0) + 1;
          contentCopies.set(ck, cn);
          s.copyCounts.set(ck, cn);
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
          // A reply the hooks already reported emits only its non-text events here — its tool calls
          // still reach Eden — even when its transcript key differs (a transcript id the hook never
          // sees changes keyOf, but not the content key).
          const hookSeen = m.role === "assistant" && s.reportedAssistant.has(contentKey(m));
          if (s.firstCall && i < lastUser) continue; // a resumed session reports only its latest user message
          const waits = m.role === "user" && i === lastUser;
          if (waits) turnFresh = true;
          for (const ev of eventsOf(m)) {
            if (hookSeen && ev.kind === "agent_message") continue;
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
          else pushTrailing(s, text);
        }
        const live = new Set(
          messages.map((m, i) => (m.role === "user" ? keys[i]! : null)).filter((k): k is string => k !== null),
        );
        for (const k of [...s.kept.keys()]) if (!live.has(k)) s.kept.delete(k);
        const prependContext = [...s.kept.values()].join("\n\n") || undefined;
        const appendContext = s.trailing.join("\n\n") || undefined;
        if (!prependContext && !appendContext) return undefined;
        return { prependContext, appendContext };
      } catch {
        return undefined; // D14
      }
    });

    api.on(
      "before_tool_call",
      async (event: { toolName?: string; toolCallId?: string; params?: unknown }, ctx: HookCtx) => {
        try {
          if (event.toolName === ASK) return undefined;
          const s = await sessionFor(sessionKey(ctx));
          const client = s ? await liveClient(s) : null;
          if (!s || !client) return undefined;
          const check = await client.check(event.toolName ?? "tool", event.params ?? {});
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
          return { block: true, blockReason: held };
        } catch {
          return undefined; // D14: a check that fails runs the tool.
        }
      },
    );

    api.on(
      "after_tool_call",
      async (event: { toolName?: string; toolCallId?: string; result?: unknown; error?: string }, ctx: HookCtx) => {
        try {
          if (event.toolName === ASK || !event.toolCallId) return;
          const s = await sessionFor(sessionKey(ctx));
          if (!s || s.reportedResults.has(event.toolCallId)) return;
          s.reportedResults.add(event.toolCallId);
          const client = await liveClient(s);
          if (!client) return;
          const payload = event.result;
          const text =
            typeof payload === "string"
              ? payload
              : Array.isArray(payload)
                ? textOf(payload as Block[])
                : textOf((payload as { content?: Block[] } | null | undefined)?.content) || (event.error ?? "");
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
      },
    );

    const reportAssistant = async (text: string | undefined, ctx: HookCtx, copy?: number) => {
      try {
        if (!text) return;
        // A hook-seen reply gets the copy number after every transcript copy (or the real copy the
        // caller counted in the transcript), so a repeated reply is reported (not dropped as `#1`),
        // the same reply fired by llm_output and agent_end dedups, and a failed run's stale last
        // assistant message — a copy already counted — is not reported again.
        const s = await sessionFor(sessionKey(ctx));
        if (!s) return;
        const hash = contentKey({ role: "assistant", content: text });
        const key = `${hash}#${copy ?? (s.copyCounts.get(hash) ?? 0) + 1}`;
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
    };

    // Each model call's assistant texts reach Eden mid-turn, not just at run end.
    api.on("llm_output", async (event: { assistantTexts?: string[] }, ctx: HookCtx) => {
      for (const text of event.assistantTexts ?? []) await reportAssistant(text, ctx);
    });

    // The last assistant message of a run must reach Eden even when no later call carries it.
    api.on("agent_end", async (event: { messages?: HookMessage[] }, ctx: HookCtx) => {
      const assistants = (event.messages ?? []).filter((m) => m?.role === "assistant");
      const last = assistants.at(-1);
      // The last reply's real copy number in this transcript: a failed run's stale reply is a copy
      // already seen, a fresh identical reply is the next one.
      const hash = last ? contentKey(last) : "";
      const copy = assistants.filter((m) => contentKey(m) === hash).length;
      await reportAssistant(last ? textOf(last.content) : undefined, ctx, copy);
    });

    api.on("session_end", async (_event: unknown, ctx: HookCtx) => {
      await closeSession(edenId(sessionKey(ctx)));
    });
    api.on("gateway_stop", async () => {
      await endAll();
    });
  },
};

export default entry;
