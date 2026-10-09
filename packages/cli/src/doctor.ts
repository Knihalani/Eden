import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rolloutPartition, toolsInventoryLine } from "@eden/ir";
import { autoApproveCheck, renderTreeLetter, treeCheck, treeSnapshot } from "@eden/measure";
export { autoApproveCheck, renderTreeLetter, treeCheck, treeSnapshot };
import { liveToolsPath, readConfig, wrapPlaneUrl, keyFingerprint, edenHome } from "./home";
import { hookdPidAlive, readHookdPid } from "./hookd";
import { memoryConsent } from "../../../src/memory-consent";
import {
  breakerCheck,
  claudeConfigDir,
  fallbackCheck,
  findMemoryPlugin,
  flagsCheck,
  killSwitchesCheck,
  modulesCheck,
  pluginCheck,
  pluginHookEvents,
  storeChecks,
} from "./doctor-memory";

export type DoctorCheck = { name: string; ok: boolean; detail: string; count?: number | null };

export const FUNNEL_STAGES = ["install", "record", "mine", "knock", "approve", "serving"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

const WRAP_DOWN = "unknown · wrap is down";

type InboxCandidate = { verdict?: string; refusal?: { reason?: string } | null };
type InboxLive = { stats?: { n?: number } };

export function funnelCheck(name: FunnelStage, ok: boolean, count: number | null, fix: string): DoctorCheck {
  if (count === null) return { name, ok, detail: WRAP_DOWN, count: null };
  return { name, ok, detail: `${count} · ${fix}`, count };
}

export function funnelSnapshot(checks: DoctorCheck[]): Array<{ name: FunnelStage; count: number | null }> {
  return FUNNEL_STAGES.map((name) => {
    const c = checks.find((x) => x.name === name);
    return { name, count: typeof c?.count === "number" ? c.count : null };
  });
}

export function doctorPayload(checks: DoctorCheck[]): {
  checks: DoctorCheck[];
  funnel: Array<{ name: FunnelStage; count: number | null }>;
} {
  return { checks, funnel: funnelSnapshot(checks) };
}

export function parseNetAllow(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const NET_ALLOW_EMPTY = "EDEN_NET_ALLOW empty · piped network binaries stay refused";
const SURFACE_JIT = "EDEN_SURFACE jit · default after soak PASS precision=1.000 n=38";
const SURFACE_ALL = "EDEN_SURFACE all · opt-out · default jit after soak PASS precision=1.000 n=38";
export const PROBE_MS = 800;

export async function probeJson(
  url: string,
  fetchFn: typeof fetch = fetch,
  ms = PROBE_MS,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown } | null> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error("probe-deadline"));
    }, ms);
  });
  try {
    const pending = fetchFn(url, { ...init, signal: ac.signal });
    void pending.catch(() => {});
    const r = await Promise.race([pending, deadline]);
    const text = await Promise.race([r.text(), deadline]);
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    return { ok: r.ok, status: r.status, body };
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function surfaceModeOf(
  raw: string | undefined = process.env.EDEN_SURFACE,
): "all" | "none" | "jit" | "jit-shadow" {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "none") return "none";
  if (v === "all") return "all";
  if (v === "jit-shadow" || v === "shadow") return "jit-shadow";
  if (v === "jit") return "jit";
  if (!v) return "jit";
  return "all";
}

export function surfaceCheck(raw: string | undefined = process.env.EDEN_SURFACE): DoctorCheck {
  const mode = surfaceModeOf(raw);
  const v = String(raw ?? "").trim();
  if (!v) {
    return { name: "surface", ok: true, detail: SURFACE_JIT };
  }
  if (mode === "all") {
    return { name: "surface", ok: true, detail: SURFACE_ALL };
  }
  return {
    name: "surface",
    ok: true,
    detail: `EDEN_SURFACE ${mode} · soak PASS precision=1.000 n=38 · default jit`,
  };
}

export function hookdOrphanDetail(healthPid: number | null, filePid: number | null): string {
  const live = healthPid != null ? String(healthPid) : "?";
  const recorded = filePid != null ? String(filePid) : "missing";
  return `orphan · /health pid ${live} · pid file ${recorded} · eden hookd --stop`;
}

export function netAllowCheck(raw: string | undefined = process.env.EDEN_NET_ALLOW): DoctorCheck {
  const names = parseNetAllow(raw);
  if (names.length === 0) {
    return { name: "net-allow", ok: true, count: 0, detail: NET_ALLOW_EMPTY };
  }
  return { name: "net-allow", ok: true, count: names.length, detail: `EDEN_NET_ALLOW ${names.join(", ")}` };
}

/** Same 7 events as `memory-hook.ts` MEMORY_EVENTS. Compile PreToolUse / PostToolBatch are not memory. */
export const MEMORY_HOOK_EVENTS = [
  "UserPromptSubmit",
  "SessionStart",
  "PreCompact",
  "Stop",
  "SessionEnd",
  "PostToolUse",
  "SubagentStop",
] as const;

export type MemoryHookEvent = (typeof MEMORY_HOOK_EVENTS)[number];

const MEMORY_HOOK_EVENT_SET = new Set<string>(MEMORY_HOOK_EVENTS);

function asSettingsRec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Claude settings `{ hooks }` or a bare hooks map (`UserPromptSubmit: …`). */
function hooksMapOf(settings: unknown): Record<string, unknown> {
  const rec = asSettingsRec(settings);
  const nested = rec.hooks;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return asSettingsRec(nested);
  if (MEMORY_HOOK_EVENTS.some((e) => e in rec)) return rec;
  return {};
}

function hookCommandsOf(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (!v) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.command === "string") out.push(o.command);
    for (const x of Object.values(o)) walk(x);
  };
  walk(value);
  return out;
}

const PLUGIN_MEMORY_CMD = /eden-memory|CLAUDE_PLUGIN_ROOT|scripts\/hook\.ts/;
const SETUP_MEMORY_CMD = /\b(?:cli\.ts|eden\.js)\b['"]?\s+hook\b|(?:^|[\s'"/])eden['"]?\s+hook\b/;

function isEdenMemoryCommand(command: string): boolean {
  return PLUGIN_MEMORY_CMD.test(command) || SETUP_MEMORY_CMD.test(command);
}

function isSetupMemoryCommand(command: string): boolean {
  return SETUP_MEMORY_CMD.test(command) && !PLUGIN_MEMORY_CMD.test(command);
}

function isPluginMemoryCommand(command: string): boolean {
  return PLUGIN_MEMORY_CMD.test(command);
}

function readClaudeSettingsFile(): unknown {
  const settings = join(claudeConfigDir(), "settings.json");
  if (!existsSync(settings)) return {};
  try {
    return JSON.parse(readFileSync(settings, "utf8")) as unknown;
  } catch {
    return {};
  }
}

/**
 * Pure memory-hook health check. Pass Claude settings `{ hooks?: Record<string, unknown> }`.
 * `pluginEvents` documents double-inject when the plugin is detected; omit when unknown.
 */
export function memoryHooksCheck(settings: unknown, opts?: { pluginEvents?: string[]; env?: string }): DoctorCheck {
  const hooks = hooksMapOf(settings);
  const settingsPresent = new Set<MemoryHookEvent>();
  let settingsSetupSubmit = false;
  let settingsPluginSubmit = false;
  for (const event of MEMORY_HOOK_EVENTS) {
    const cmds = hookCommandsOf(hooks[event]);
    const eden = cmds.filter(isEdenMemoryCommand);
    if (eden.length) settingsPresent.add(event);
    if (event === "UserPromptSubmit") {
      settingsSetupSubmit = eden.some(isSetupMemoryCommand);
      settingsPluginSubmit = eden.some(isPluginMemoryCommand);
    }
  }
  const pluginEvents = (opts?.pluginEvents ?? []).filter((e) => MEMORY_HOOK_EVENT_SET.has(e));
  const pluginSubmit = pluginEvents.includes("UserPromptSubmit");
  const present = new Set<MemoryHookEvent>(settingsPresent);
  for (const e of pluginEvents) present.add(e as MemoryHookEvent);

  const listed = MEMORY_HOOK_EVENTS.filter((e) => present.has(e));
  const missing = MEMORY_HOOK_EVENTS.filter((e) => !present.has(e));
  const encodeGap =
    settingsPresent.has("UserPromptSubmit") &&
    settingsPresent.has("SessionStart") &&
    !settingsPresent.has("PostToolUse");
  const doubleInject = (pluginSubmit && settingsSetupSubmit) || (settingsSetupSubmit && settingsPluginSubmit);
  const rawEnv = opts && Object.prototype.hasOwnProperty.call(opts, "env") ? opts.env : process.env.EDEN_MEMORY;
  const consent = memoryConsent(rawEnv);
  const consentBit = `EDEN_MEMORY ${consent}`;

  let ok = missing.length === 0 && listed.length === MEMORY_HOOK_EVENTS.length && !doubleInject && !encodeGap;
  let detail: string;
  if (listed.length === 0) {
    ok = false;
    const events = MEMORY_HOOK_EVENTS.join(" ");
    detail = `memory hooks: none · run eden setup · eden memory import · ${events} · ${consentBit}`;
  } else {
    detail = `memory hooks: ${listed.join(" ")}`;
    if (missing.length) detail += ` · missing ${missing.join(" ")}`;
    if (encodeGap) detail += " · encode gap";
    if (doubleInject) detail += " · double inject · plugin and eden setup both attach UserPromptSubmit";
    detail += ` · ${consentBit}`;
  }

  return { name: "memory", ok, detail, count: listed.length };
}

/**
 * `eden doctor`'s memory section: the memory hooks Claude Code registers, the plugin copy it runs, whether that copy
 * loads Eden in-process within the Submit budget, the fallbacks it logged, how the store is keyed, the delivery
 * flags, the circuit breaker and the kill switches.
 */
export function collectMemoryDoctor(): DoctorCheck[] {
  const settings = readClaudeSettingsFile();
  const plugin = findMemoryPlugin();
  const env = process.env.EDEN_MEMORY;
  const hooks = memoryHooksCheck(settings, { pluginEvents: pluginHookEvents(plugin), env });
  const hooksFromSettings = (memoryHooksCheck(settings, { env }).count ?? 0) > 0;
  const modules = modulesCheck(plugin, hooksFromSettings);
  return [
    hooks,
    pluginCheck(plugin, hooksFromSettings),
    modules.check,
    fallbackCheck(modules.loaded),
    ...storeChecks(),
    flagsCheck(),
    breakerCheck(),
    killSwitchesCheck(),
  ];
}

export type MemoryHostName = "codex" | "opencode" | "gemini" | "cursor";
export type MemoryHostStatus = "ok" | "skip" | "half-wired" | "not installed" | "unreadable";

export type MemoryHostVerdict = {
  host: MemoryHostName;
  status: MemoryHostStatus;
  /** Doctor fragment, e.g. `codex: skip` or `codex: half-wired (no post_tool)`. */
  detail: string;
  ok: boolean;
};

const EDEN_HARNESS_CMD = /127\.0\.0\.1:\d+\/hook\b/;

function isEdenHarnessCommand(command: string): boolean {
  return isEdenMemoryCommand(command) || EDEN_HARNESS_CMD.test(command);
}

function readTextFile(
  path: string,
): { ok: true; text: string; reason?: undefined } | { ok: false; reason: "missing" | "unreadable" } {
  try {
    if (!existsSync(path)) return { ok: false, reason: "missing" };
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

function hostVerdict(host: MemoryHostName, status: MemoryHostStatus, gap?: string): MemoryHostVerdict {
  const ok = status === "ok" || status === "skip" || status === "not installed";
  let detail = `${host}: ${status}`;
  if (gap) detail += ` (${gap})`;
  if (host === "codex" && status === "ok") detail += " (trust/hooks can fail silently)";
  return { host, status, detail, ok };
}

/** Codex stdin events that observe tools / sleep / inject. */
const CODEX_LIVE_EVENTS = ["PostToolUse", "SessionStart", "Stop", "SessionEnd", "UserPromptSubmit"] as const;

function commandsFromUnknownHooks(value: unknown): string[] {
  try {
    return hookCommandsOf(value);
  } catch {
    return [];
  }
}

function liveCodexEventsFromJson(raw: string): Set<string> {
  const out = new Set<string>();
  try {
    const j = JSON.parse(raw) as { hooks?: unknown };
    const hooks = asSettingsRec(j?.hooks);
    for (const event of CODEX_LIVE_EVENTS) {
      const cmds = commandsFromUnknownHooks(hooks[event]);
      if (cmds.some(isEdenHarnessCommand)) out.add(event);
    }
  } catch {}
  return out;
}

function liveCodexEventsFromToml(raw: string): Set<string> {
  const out = new Set<string>();
  try {
    for (const event of CODEX_LIVE_EVENTS) {
      const re = new RegExp(`\\[\\[hooks\\.${event}\\]\\]([\\s\\S]*?)(?=\\n\\[\\[|\\n\\[|# --- end eden-recorder|$)`);
      const m = re.exec(raw);
      if (!m) continue;
      if (isEdenHarnessCommand(m[1] ?? "")) out.add(event);
    }
  } catch {}
  return out;
}

function hasDeadCodexEdenTable(raw: string): boolean {
  try {
    return /\[hooks\.eden\]/.test(raw) || /(?:^|\n)\s*post_tool\s*=/.test(raw);
  } catch {
    return false;
  }
}

/**
 * Codex `~/.codex`: skip if absent. Live schema is hooks.json / [[hooks.PostToolUse]]
 * (stdin `hook_event_name: PostToolUse`). `[hooks.eden] post_tool` is dead — warn,
 * do not certify ok. Trust/hooks can still fail silently after a live wire.
 */
export function inspectCodexMemory(home = homedir()): MemoryHostVerdict {
  try {
    const dir = join(home, ".codex");
    if (!existsSync(dir)) return hostVerdict("codex", "skip");
    const json = readTextFile(join(dir, "hooks.json"));
    const toml = readTextFile(join(dir, "config.toml"));
    if (json.reason === "unreadable" || toml.reason === "unreadable") {
      return hostVerdict("codex", "unreadable");
    }
    const live = new Set<string>();
    if (json.ok) for (const e of liveCodexEventsFromJson(json.text)) live.add(e);
    if (toml.ok) for (const e of liveCodexEventsFromToml(toml.text)) live.add(e);
    const dead = toml.ok && hasDeadCodexEdenTable(toml.text);
    const hasPost = live.has("PostToolUse");
    const hasStart = live.has("SessionStart");
    const hasStop = live.has("Stop") || live.has("SessionEnd");
    if (!hasPost) {
      if (dead) {
        return hostVerdict("codex", "half-wired", "stale post_tool schema, need PostToolUse");
      }
      return hostVerdict("codex", "half-wired", "home exists, no PostToolUse");
    }
    const gaps: string[] = [];
    if (!hasStart) gaps.push("no SessionStart");
    if (!hasStop) gaps.push("no Stop");
    if (gaps.length) return hostVerdict("codex", "half-wired", gaps.join(", "));
    return hostVerdict("codex", "ok");
  } catch {
    return hostVerdict("codex", "unreadable");
  }
}

/**
 * OpenCode `~/.config/opencode`: skip if absent. Need `plugin/eden-recorder.js`
 * with PostToolUse / tool.execute.after. Torn JS → warning, no throw.
 */
export function inspectOpencodeMemory(home = homedir()): MemoryHostVerdict {
  try {
    const dir = join(home, ".config", "opencode");
    if (!existsSync(dir)) return hostVerdict("opencode", "skip");
    const plugin = join(dir, "plugin", "eden-recorder.js");
    const file = readTextFile(plugin);
    if (!file.ok) {
      if (file.reason === "unreadable") return hostVerdict("opencode", "unreadable");
      return hostVerdict("opencode", "half-wired", "no plugin/eden-recorder.js");
    }
    const src = file.text;
    const hasAfter = /PostToolUse|tool\.execute\.after/.test(src);
    if (!hasAfter) return hostVerdict("opencode", "half-wired", "plugin missing PostToolUse");
    return hostVerdict("opencode", "ok");
  } catch {
    return hostVerdict("opencode", "unreadable");
  }
}

/**
 * Gemini `~/.gemini`: skip if absent. AfterTool / AfterToolUse must be the eden
 * hook. Torn JSON → warning, no throw.
 */
export function inspectGeminiMemory(home = homedir()): MemoryHostVerdict {
  try {
    const dir = join(home, ".gemini");
    if (!existsSync(dir)) return hostVerdict("gemini", "skip");
    const file = readTextFile(join(dir, "settings.json"));
    if (!file.ok) {
      if (file.reason === "unreadable") return hostVerdict("gemini", "unreadable");
      return hostVerdict("gemini", "half-wired", "no AfterTool/AfterToolUse");
    }
    let rec: Record<string, unknown> = {};
    let hooks: Record<string, unknown> = {};
    try {
      rec = asSettingsRec(JSON.parse(file.text) as unknown);
      hooks = hooksMapOf(rec);
    } catch {
      return hostVerdict("gemini", "unreadable");
    }
    const after = [
      ...hookCommandsOf(hooks.AfterToolUse ?? rec.AfterToolUse),
      ...hookCommandsOf(hooks.AfterTool ?? rec.AfterTool),
    ];
    if (!after.some(isEdenHarnessCommand)) {
      return hostVerdict("gemini", "half-wired", "AfterTool/AfterToolUse not eden hook");
    }
    return hostVerdict("gemini", "ok");
  } catch {
    return hostVerdict("gemini", "unreadable");
  }
}

/** Cursor is never invented by setup. Name the gap; do not inspect-to-install. */
export function inspectCursorMemory(): MemoryHostVerdict {
  return hostVerdict("cursor", "not installed", "not invented");
}

/** Unequal harness capture, named. Skip is honest. Half-wired / unreadable fail the check. */
export function inspectMemoryHosts(home = homedir()): { ok: boolean; detail: string; hosts: MemoryHostVerdict[] } {
  try {
    const hosts: MemoryHostVerdict[] = [
      inspectCodexMemory(home),
      inspectOpencodeMemory(home),
      inspectGeminiMemory(home),
      inspectCursorMemory(),
    ];
    return {
      ok: hosts.every((h) => h.ok),
      detail: hosts.map((h) => h.detail).join(" · "),
      hosts,
    };
  } catch {
    const hosts = [
      hostVerdict("codex", "unreadable"),
      hostVerdict("opencode", "unreadable"),
      hostVerdict("gemini", "unreadable"),
      inspectCursorMemory(),
    ];
    return { ok: false, detail: hosts.map((h) => h.detail).join(" · "), hosts };
  }
}

/**
 * Per-host memory capture for `eden doctor`. Never throws (torn TOML/JS/JSON → warning).
 * Skip if the host dir is absent. Cursor is named not-invented even when `~/.cursor` exists.
 */
export function extraHostMemoryCheck(opts?: { homedir?: string }): DoctorCheck[] {
  try {
    const home = opts?.homedir ?? homedir();
    return inspectMemoryHosts(home).hosts.map((h) => ({
      name: h.host,
      ok: h.ok,
      detail: h.detail,
    }));
  } catch {
    return [
      { name: "codex", ok: false, detail: "codex: unreadable" },
      { name: "opencode", ok: false, detail: "opencode: unreadable" },
      { name: "gemini", ok: false, detail: "gemini: unreadable" },
      { name: "cursor", ok: true, detail: "cursor: not installed (not invented)" },
    ];
  }
}

function installState(): { ok: boolean; count: 0 | 1; fix: string } {
  const settings = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settings)) return { ok: false, count: 0, fix: "run eden setup" };
  try {
    const j = JSON.parse(readFileSync(settings, "utf8")) as { hooks?: Record<string, unknown> };
    const has = Boolean(j.hooks && (j.hooks.PostToolUse || j.hooks.Stop));
    return has ? { ok: true, count: 1, fix: "hooks installed" } : { ok: false, count: 0, fix: "run eden setup" };
  } catch {
    return { ok: false, count: 0, fix: "run eden setup" };
  }
}

function waitingCount(cands: InboxCandidate[]): number {
  return cands.filter((c) => !c.refusal && c.verdict !== "FAIL").length;
}

function servedCount(live: InboxLive[]): number {
  return live.reduce((n, t) => n + (Number(t.stats?.n) > 0 ? 1 : 0), 0);
}

export function recordState(
  traces: number | undefined,
  wrapUp: boolean,
  hookdUp: boolean,
): { count: number | null; fix: string } {
  if (typeof traces === "number") {
    return {
      count: traces,
      fix: traces > 0 ? "recording" : hookdUp ? "wrap more runs" : "start with eden hookd",
    };
  }
  if (!wrapUp) {
    return hookdUp ? { count: null, fix: WRAP_DOWN } : { count: 0, fix: "start with eden hookd" };
  }
  return { count: 0, fix: hookdUp ? "wrap more runs" : "start with eden hookd" };
}

function mineFix(mined: number, stuck: number): string {
  if (!mined) return "wrap more runs";
  if (stuck) return `${stuck} pending/uncovered · eden explain`;
  return "eden approve";
}

export async function collectDoctor(opts?: { fetch?: typeof fetch }): Promise<DoctorCheck[]> {
  const fetchFn = opts?.fetch ?? fetch;
  const health: DoctorCheck[] = [];
  const cfg = readConfig();
  if (!cfg) health.push({ name: "config", ok: false, detail: "missing · start eden wrap or run eden login" });
  else health.push({ name: "config", ok: true, detail: `${cfg.base_url} · key ${keyFingerprint(cfg.api_key)}` });
  health.push(netAllowCheck());
  health.push(surfaceCheck());
  health.push(treeCheck());
  health.push(autoApproveCheck());

  const configured = (cfg?.base_url || "http://127.0.0.1:8788").replace(/\/$/, "");
  const base = wrapPlaneUrl(configured);
  if (base !== configured) {
    health.push({
      name: "planes",
      ok: false,
      detail:
        `hooks/MCP config is site ${configured}; compiled tools live on wrap ${base}. Run eden setup so ` +
        `traces hit /v1/traces.`,
    });
  }

  let wrapUp = false;
  let tracesKnown: number | undefined;
  let wrapCandidates: number | undefined;
  let wrapLive: number | undefined;
  const wrap = await probeJson(`${base}/health`, fetchFn);
  if (wrap) {
    const j =
      wrap.body && typeof wrap.body === "object"
        ? (wrap.body as {
            traces?: number;
            live?: number;
            candidates?: number;
            registry?: boolean;
            island?: boolean;
          })
        : null;
    wrapUp = wrap.ok;
    if (wrap.ok && typeof j?.traces === "number") tracesKnown = j.traces;
    if (wrap.ok && typeof j?.candidates === "number") wrapCandidates = j.candidates;
    if (wrap.ok && typeof j?.live === "number") wrapLive = j.live;
    health.push({
      name: "wrap",
      ok: wrap.ok,
      detail: wrap.ok ? `up · traces ${j?.traces ?? "?"} · live ${j?.live ?? "?"}` : `HTTP ${wrap.status}`,
    });
    if (wrap.ok) {
      const key = cfg?.api_key;
      const agent = await probeJson(`${base}/v1/wrap`, fetchFn, PROBE_MS, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ name: "eden_doctor_probe", args: {} }),
      });
      const stale = !agent || agent.status === 404;
      const keyedReject = Boolean(key) && agent?.status === 401;
      health.push({
        name: "agent-http",
        ok: !stale && !keyedReject,
        detail: stale
          ? "POST /v1/wrap is 404 · restart eden wrap"
          : keyedReject
            ? "POST /v1/wrap HTTP 401 with the configured key"
            : `POST /v1/wrap HTTP ${agent.status}`,
      });
    }
    if (wrap.ok && j && "registry" in j) {
      health.push({
        name: "registry",
        ok: Boolean(j.registry),
        detail: j.registry ? "present" : "missing · start eden wrap without --no-coding",
      });
    }
    if (wrap.ok && j && "island" in j) {
      health.push({
        name: "island",
        ok: true,
        detail: j.island ? "wired" : "none · set OPENAI_API_KEY so island steps can run",
      });
    }
  } else {
    wrapUp = false;
    health.push({
      name: "wrap",
      ok: false,
      detail: `down · control wrap is ${base} (8788); site ingest/play is 8787`,
    });
  }

  let mined = 0;
  let waiting = 0;
  let served = 0;
  let stuck = 0;
  if (wrapUp) {
    const key = cfg?.api_key;
    const inbox = await probeJson(
      `${base}/v1/inbox`,
      fetchFn,
      PROBE_MS,
      key ? { headers: { Authorization: `Bearer ${key}` } } : undefined,
    );
    if (inbox?.ok && inbox.body && typeof inbox.body === "object") {
      const box = inbox.body as { candidates?: InboxCandidate[]; live?: InboxLive[] };
      const cands = box.candidates ?? [];
      mined = cands.length;
      waiting = waitingCount(cands);
      served = servedCount(box.live ?? []);
      stuck = cands.filter((c) => c.verdict === "pending" || c.refusal?.reason?.startsWith("uncovered")).length;
    } else if (inbox?.status === 401 && typeof wrapCandidates === "number") {
      mined = wrapCandidates;
    }
  }

  const hookdPort = process.env.EDEN_HOOKD_PORT || "8794";
  let hookdUp = false;
  const hookd = await probeJson(`http://127.0.0.1:${hookdPort}/health`, fetchFn);
  if (hookd?.ok) {
    hookdUp = true;
    let healthPid: number | null = null;
    const j = hookd.body && typeof hookd.body === "object" ? (hookd.body as { pid?: unknown }) : null;
    const n = Number(j?.pid);
    if (Number.isFinite(n) && n > 0) healthPid = Math.round(n);
    const filePid = readHookdPid();
    const owned = Boolean(filePid && hookdPidAlive(filePid) && (healthPid == null || filePid === healthPid));
    health.push({
      name: "hookd",
      ok: owned,
      detail: owned ? "up · record" : hookdOrphanDetail(healthPid, filePid),
    });
  } else if (hookd) {
    health.push({ name: "hookd", ok: false, detail: `HTTP ${hookd.status}` });
  } else {
    hookdUp = false;
    const pid = readHookdPid();
    if (pid && !hookdPidAlive(pid)) {
      health.push({ name: "hookd", ok: false, detail: `stale pid ${pid} · start with eden hookd` });
    } else {
      health.push({ name: "hookd", ok: false, detail: "down · start with eden hookd" });
    }
  }

  health.push({
    name: "lanes",
    ok: true,
    detail:
      `wrap ${base} · site ingest ${configured.includes("8787") ? configured : "http://127.0.0.1:8787"} · ` +
      `hookd :${hookdPort}`,
  });

  const live = liveToolsPath();
  if (existsSync(live)) {
    try {
      const tools = JSON.parse(readFileSync(live, "utf8")) as unknown;
      health.push({ name: "live-tools", ok: true, detail: liveToolsDoctorLine(tools, wrapLive) });
    } catch {
      health.push({ name: "live-tools", ok: false, detail: "unreadable JSON" });
    }
  } else health.push({ name: "live-tools", ok: false, detail: "none yet · approve is the gate" });

  try {
    health.push(...collectMemoryDoctor());
  } catch {
    health.push({ name: "memory", ok: false, detail: "memory hooks: unreadable · run eden setup", count: 0 });
  }
  try {
    health.push(...extraHostMemoryCheck());
  } catch {
    health.push(
      { name: "codex", ok: false, detail: "codex: unreadable" },
      { name: "opencode", ok: false, detail: "opencode: unreadable" },
      { name: "gemini", ok: false, detail: "gemini: unreadable" },
      { name: "cursor", ok: true, detail: "cursor: not installed (not invented)" },
    );
  }

  const recorded = recordState(tracesKnown, wrapUp, hookdUp);
  const knocked = existsSync(join(edenHome(), "knock.json")) ? 1 : 0;
  const install = installState();

  const funnel: DoctorCheck[] = [
    funnelCheck("install", install.count === 1, install.count, install.fix),
    funnelCheck("record", (recorded.count ?? 0) > 0, recorded.count, recorded.fix),
    wrapUp ? funnelCheck("mine", mined > 0, mined, mineFix(mined, stuck)) : funnelCheck("mine", false, null, ""),
    funnelCheck("knock", true, knocked, knocked ? "eden open or eden approve" : "none waiting"),
    wrapUp
      ? funnelCheck("approve", waiting > 0, waiting, waiting ? "eden approve <id>" : "eden approve after a PASS card")
      : funnelCheck("approve", false, null, ""),
    wrapUp
      ? funnelCheck("serving", served > 0, served, served ? "live with receipts" : "first serving after Approve")
      : funnelCheck("serving", false, null, ""),
  ];

  return [...health, ...funnel];
}

export function liveToolsDoctorLine(tools: unknown, wrapLive?: number): string {
  const disk = liveToolsDetail(tools);
  if (typeof wrapLive === "number" && wrapLive === 0 && Array.isArray(tools) && tools.length > 0) {
    return `${disk} on disk · wrap serving 0`;
  }
  return disk;
}

export function liveToolsDetail(tools: unknown): string {
  if (!Array.isArray(tools)) return "unreadable JSON";
  const rows = tools.map((raw) => {
    const t = raw && typeof raw === "object" ? (raw as { rollout?: unknown }) : {};
    return { rollout: typeof t.rollout === "string" ? t.rollout : undefined };
  });
  const p = rolloutPartition(rows);
  return toolsInventoryLine(p);
}

function lineOf(c: DoctorCheck): string {
  return `${c.ok ? "ok" : "!!"}  ${c.name}: ${c.detail}`;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const names = new Set<string>(FUNNEL_STAGES);
  const health = checks.filter((c) => !names.has(c.name));
  const funnel = FUNNEL_STAGES.map((name) => checks.find((c) => c.name === name)).filter((c): c is DoctorCheck =>
    Boolean(c),
  );
  return [...health.map(lineOf), "", ...funnel.map(lineOf)].join("\n");
}

const REQUIRED = new Set(["config", "wrap", "approve-gate"]);

export function doctorHelp(): string {
  return `eden doctor — wrap, recording, kill-switches, tree close

  eden doctor            Health letter (default)
  eden doctor --json    Same checks as JSON
  eden doctor --memory   Memory only: hooks, plugin copy, Eden loads in budget; exit 0 when all ok
  eden doctor --tree     Wave 16–20 leftover letter (no network)

NET_ALLOW empty refuses piped network binaries. A live hookd without a
matching pid file is named orphan · eden hookd --stop. EDEN_AUTO_APPROVE=1
prints as a bypass, never a default. Wave 21 honesty files shipped. Wave 22 stays Later.
Memory hooks listed in health. Extra hosts named skip / half-wired / ok / not installed — unequal \
capture is not silent. Codex trust/hooks can fail silently. EDEN_MEMORY=0|readonly|on. Prune by \
deleting the store or EDEN_MEMORY=0. eden memory import observes existing transcripts locally (no \
cloud / no NVIDIA).
`;
}

export async function doctor(args: string[] = []): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(doctorHelp());
    return 0;
  }
  if (args.includes("--tree")) {
    if (args.includes("--json")) console.log(JSON.stringify(treeSnapshot(), null, 2));
    else console.log(renderTreeLetter());
    return treeCheck().ok ? 0 : 1;
  }
  if (args.includes("--memory")) {
    let checks: DoctorCheck[];
    try {
      checks = collectMemoryDoctor();
    } catch (err) {
      // As for the full letter: an unreadable config must never throw the doctor process.
      checks = [{ name: "memory", ok: false, detail: `unreadable · ${(err as Error).message}` }];
    }
    if (args.includes("--json")) console.log(JSON.stringify({ checks }, null, 2));
    else console.log(checks.map(lineOf).join("\n"));
    return checks.every((c) => c.ok) ? 0 : 1;
  }
  let checks: DoctorCheck[];
  try {
    checks = await collectDoctor();
  } catch {
    // Host configs (torn TOML/JS/JSON) must never throw the doctor process.
    checks = [
      {
        name: "memory",
        ok: false,
        detail: "unreadable · doctor warning, agent still runs · cursor: not installed",
      },
    ];
  }
  if (args.includes("--json")) console.log(JSON.stringify(doctorPayload(checks), null, 2));
  else console.log(formatDoctor(checks));
  return checks.filter((c) => REQUIRED.has(c.name)).every((c) => c.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(await doctor(process.argv.slice(2)));
