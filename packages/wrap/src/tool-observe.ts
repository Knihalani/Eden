import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact, redactString } from "@eden/ir";
import { omitExperienceTree, putExperienceFromTool } from "../../../src/experience-store";
import { attachPlaceCues, cueFor, MEMORY_MARK, placePathsFrom } from "../../../src/index";
import { memoryConsent } from "../../../src/memory-consent";
import {
  exitFromResult,
  filesFromTool,
  parseToolArgs,
  persistToolTraces,
  type ToolTrace,
} from "../../../src/tool-trace";

export const TOOL_TRACE_MAX = 4000;
const NAME_MAX = 64;
const SNIPPET_MAX = 320;

export type ToolTraceMessage = { role: "user"; content: string };
export type { ToolTrace };

type ObserveHost = {
  observe(messages: unknown[]): unknown;
  dir?: string;
  jsonlDir?: string;
  session?: string;
  cwd?: string;
};
type InjectHost = ObserveHost & {
  injectBody(body: Record<string, unknown>): Record<string, unknown>;
};

type CallRec = { id: string; name: string; args: Record<string, unknown> };
type ResultRec = { id: string; name: string; text: string; isError?: boolean; obj?: unknown };
type AssembledTrace = ToolTrace & { result?: unknown };

function unwrapJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function resultPayload(result?: ResultRec): unknown {
  if (!result) return undefined;
  const raw = result.obj;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if ("content" in o || "result" in o || "output" in o) {
      const inner = o.content ?? o.result ?? o.output;
      if (inner !== undefined) return unwrapJson(inner);
    }
    return raw;
  }
  if (result.text) return unwrapJson(result.text);
  return raw;
}

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return redactString(raw.replace(/\s+/g, " ").trim()).slice(0, NAME_MAX);
}

function payloadText(v: unknown, budget = TOOL_TRACE_MAX): string {
  if (v == null || budget <= 0) return "";
  let src: unknown = v;
  try {
    src = omitExperienceTree(v);
  } catch {
    src = v;
  }
  if (src == null || src === "") return "";
  if (typeof src === "string") return redactString(src).slice(0, budget);
  if (typeof src === "number" || typeof src === "boolean") return String(src).slice(0, budget);
  if (Array.isArray(src)) {
    let out = "";
    for (const x of src) {
      const t = payloadText(x, budget - out.length);
      if (!t) continue;
      out = out ? `${out}\n${t}` : t;
      if (out.length >= budget) return out.slice(0, budget);
    }
    return out;
  }
  if (typeof src === "object") {
    const o = src as Record<string, unknown>;
    if (typeof o.text === "string") return payloadText(o.text, budget);
    if (typeof o.output === "string") return payloadText(o.output, budget);
    if (o.content !== undefined && o.content !== src) {
      const inner = payloadText(o.content, budget);
      if (inner) return inner;
    }
    try {
      return redactString(JSON.stringify(redact(src))).slice(0, budget);
    } catch {
      return "";
    }
  }
  return "";
}

function snippetOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);
}

function formatTrace(name: string, result: string): string {
  const body = result.replace(/\s+/g, " ").trim();
  if (!body) return name ? `Tool ${name} was called.` : "";
  const head = name ? `Tool ${name} result is ${body}` : `Tool result is ${body}`;
  const clipped = head.length > 400 ? head.slice(0, 399).trimEnd() : head.trimEnd();
  return /[.!]$/.test(clipped) ? clipped : `${clipped}.`;
}

function callName(x: Record<string, unknown>): string {
  const fn = x.function as { name?: unknown } | undefined;
  return cleanName(fn?.name) || cleanName(x.name) || cleanName(x.tool_name);
}

function callId(x: Record<string, unknown>): string {
  return typeof x.id === "string" ? x.id : typeof x.tool_call_id === "string" ? x.tool_call_id : "";
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    const redacted = redact(args);
    const rec = redacted && typeof redacted === "object" && !Array.isArray(redacted)
      ? { ...(redacted as Record<string, unknown>) }
      : { ...args };
    for (const k of ["command", "cmd", "file", "path", "file_path", "files"] as const) {
      if (!(k in args)) continue;
      const v = args[k];
      if (typeof v === "string") rec[k] = redactString(v).slice(0, TOOL_TRACE_MAX);
      else rec[k] = redact(v);
    }
    return rec;
  } catch {
    return args;
  }
}

function callArgs(x: Record<string, unknown>): Record<string, unknown> {
  const fn = x.function as { arguments?: unknown; input?: unknown } | undefined;
  if (typeof fn?.arguments === "string" || (fn?.arguments && typeof fn.arguments === "object")) {
    return redactArgs(parseToolArgs(fn.arguments));
  }
  if (fn?.input !== undefined) return redactArgs(parseToolArgs(fn.input));
  if (typeof x.arguments === "string" || (x.arguments && typeof x.arguments === "object")) {
    return redactArgs(parseToolArgs(x.arguments));
  }
  if (x.input !== undefined) return redactArgs(parseToolArgs(x.input));
  return {};
}

function isErrorFlag(x: Record<string, unknown>): boolean | undefined {
  if (x.is_error === true || x.isError === true) return true;
  return undefined;
}

function collect(messages: unknown): { prose: ToolTraceMessage[]; traces: AssembledTrace[] } {
  if (!Array.isArray(messages)) return { prose: [], traces: [] };
  const namesById = new Map<string, string>();
  const calls: CallRec[] = [];
  const results: ResultRec[] = [];
  const used = new Set<string>();
  const traces: string[] = [];

  const noteCall = (id: string, name: string, args: Record<string, unknown> = {}) => {
    const n = name || (id ? namesById.get(id) ?? "" : "");
    if (id && n) namesById.set(id, n);
    if (!n && !id) return;
    calls.push({ id: id || `anon-${calls.length}`, name: n, args });
  };

  const resolveName = (id: string, name: string): string => {
    if (name) return name;
    if (id && namesById.get(id)) return namesById.get(id)!;
    for (let i = calls.length - 1; i >= 0; i--) {
      const c = calls[i]!;
      if (!used.has(c.id) && c.name) return c.name;
    }
    return "";
  };

  const noteResult = (id: string, name: string, text: string, extra?: { isError?: boolean; obj?: unknown }) => {
    const n = resolveName(id, name);
    if (id) {
      used.add(id);
      if (n) namesById.set(id, n);
    } else {
      for (let i = calls.length - 1; i >= 0; i--) {
        const c = calls[i]!;
        if (!used.has(c.id)) {
          used.add(c.id);
          break;
        }
      }
    }
    results.push({ id, name: n, text, isError: extra?.isError, obj: extra?.obj });
    const line = formatTrace(n, snippetOf(text));
    if (line) traces.push(line);
  };

  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    const role = String(o.role || "");

    if (Array.isArray(o.tool_calls)) {
      for (const c of o.tool_calls) {
        if (!c || typeof c !== "object") continue;
        const x = c as Record<string, unknown>;
        noteCall(callId(x), callName(x), callArgs(x));
      }
    }

    const fc = o.function_call;
    if (fc && typeof fc === "object") {
      const x = fc as Record<string, unknown>;
      noteCall(typeof o.name === "string" ? o.name : "", callName(x) || cleanName(x.name), callArgs(x));
    }

    if (role === "tool" || role === "function") {
      const id = typeof o.tool_call_id === "string" ? o.tool_call_id : callId(o);
      noteResult(id, callName(o), payloadText(o.content ?? o.result ?? o.output), {
        isError: isErrorFlag(o),
        obj: o,
      });
    }

    if (!Array.isArray(o.content)) continue;
    for (const b of o.content) {
      if (!b || typeof b !== "object") continue;
      const x = b as Record<string, unknown>;
      const type = String(x.type || "");
      if (type === "tool_use" || type === "function_call") {
        noteCall(callId(x), callName(x), callArgs(x));
      } else if (type === "tool_result" || type === "function_result") {
        const id = typeof x.tool_use_id === "string" ? x.tool_use_id : callId(x);
        noteResult(id, callName(x), payloadText(x.content ?? x.output ?? x.result ?? x), {
          isError: isErrorFlag(x),
          obj: x,
        });
      }
    }
  }

  for (const c of calls) {
    if (used.has(c.id) || !c.name) continue;
    traces.push(formatTrace(c.name, ""));
  }

  return {
    prose: traces.map((content) => ({ role: "user" as const, content })),
    traces: assembleTraces(calls, results),
  };
}

function assembleTraces(calls: CallRec[], results: ResultRec[]): AssembledTrace[] {
  const t = Date.now();
  const resultUsed = new Set<number>();
  const out: AssembledTrace[] = [];

  const takeResult = (id: string): ResultRec | undefined => {
    if (id) {
      for (let i = 0; i < results.length; i++) {
        if (resultUsed.has(i)) continue;
        if (results[i]!.id === id) {
          resultUsed.add(i);
          return results[i];
        }
      }
      return undefined;
    }
    for (let i = 0; i < results.length; i++) {
      if (resultUsed.has(i)) continue;
      resultUsed.add(i);
      return results[i];
    }
    return undefined;
  };

  const pushTrace = (name: string, args: Record<string, unknown>, result?: ResultRec) => {
    const text = result?.text ?? "";
    const files = filesFromTool(args, text);
    const exit = exitFromResult(result?.obj, text, result?.isError);
    const rec: AssembledTrace = { name, args, t, order: out.length };
    const payload = resultPayload(result);
    if (payload !== undefined) rec.result = payload;
    if (files.length) rec.files = files;
    if (exit !== undefined) rec.exit = exit;
    if (!rec.name && !files.length && exit === undefined && !Object.keys(args).length && payload === undefined) return;
    out.push(rec);
  };

  for (const c of calls) pushTrace(c.name, c.args, takeResult(c.id));
  for (let i = 0; i < results.length; i++) {
    if (resultUsed.has(i)) continue;
    const r = results[i]!;
    pushTrace(r.name, {}, r);
  }
  return out;
}

export function toolTraceMessages(messages: unknown): ToolTraceMessage[] {
  return collect(messages).prose;
}

function hostNeedle(mem: ObserveHost, keys: readonly string[]): string | undefined {
  try {
    const o = mem as unknown as Record<string, unknown>;
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  } catch {}
  return undefined;
}

export function observeToolTraces(mem: ObserveHost, messages: unknown): void {
  try { if (memoryConsent() !== "on") return; } catch { return; }
  let prose: ToolTraceMessage[] = [];
  let structured: AssembledTrace[] = [];
  try {
    const parsed = collect(messages);
    prose = parsed.prose;
    structured = parsed.traces;
  } catch {
    return;
  }
  try {
    const dir = (typeof mem.jsonlDir === "string" && mem.jsonlDir)
      || (typeof mem.dir === "string" ? mem.dir : "");
    if (dir && structured.length) persistToolTraces(dir, structured);
  } catch {
    /* persist fail-open */
  }
  try {
    const root = (typeof mem.dir === "string" && mem.dir)
      || (typeof mem.jsonlDir === "string" && mem.jsonlDir)
      || "";
    if (root && structured.length) {
      for (const tr of structured) {
        try {
          putExperienceFromTool(root, {
            name: tr.name,
            args: tr.args,
            result: tr.result,
            session: hostNeedle(mem, ["session", "scrubSession"]),
            cwd: hostNeedle(mem, ["cwd", "scrubCwd"]),
          });
        } catch {
          /* one traj fail-open */
        }
      }
    }
  } catch {
    /* experience fail-open */
  }
  try {
    if (prose.length) mem.observe(prose);
  } catch {
    /* wrap must not fail closed on memory encode */
  }
}

const INJECT_LOG_CAP = 4000;
const TASK_TOKENS = new Set(["openssl", "cert", "certificate", "tls", "ssl", "regex", "log", "fingerprint"]);
const LEFTOVER_TOKENS = new Set(["sqlite", "clerk", "postgres", "postgresql", "circleci", "diet"]);
const LOG_STOP = new Set([
  "eden", "memory", "this", "that", "with", "from", "have", "been", "will", "your", "task",
  "please", "using", "into", "file", "files", "create", "created", "make", "made", "about",
  "command", "commands", "linux", "output", "assistant", "environment", "current", "terminal",
]);

function logTokens(text: string): Set<string> {
  const out = new Set<string>();
  const raw = text.toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2");
  for (const t of raw.split(/[^a-z0-9]+/)) {
    if (!t) continue;
    if (TASK_TOKENS.has(t) || LEFTOVER_TOKENS.has(t)) {
      out.add(t);
      continue;
    }
    if (t.length < 4 || LOG_STOP.has(t)) continue;
    if (t.startsWith("cert")) out.add("cert");
    out.add(t);
  }
  return out;
}

function packetFromInjected(body: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (out.length > 16 || depth > 5) return;
    if (typeof v === "string") {
      if (v.includes(MEMORY_MARK)) out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      walk(o.content, depth + 1);
      walk(o.text, depth + 1);
      walk(o.messages, depth + 1);
      walk(o.contents, depth + 1);
      walk(o.system, depth + 1);
    }
  };
  walk(body, 0);
  return out.join("\n");
}

function lastUserRecord(list: unknown[]): Record<string, unknown> | undefined {
  if (!Array.isArray(list)) return;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const role = String((m as { role?: unknown }).role ?? "").toLowerCase();
    if (role === "user" || role === "human") return m as Record<string, unknown>;
  }
}

function cueFromInjected(body: Record<string, unknown>): string {
  const list = Array.isArray(body.messages) ? body.messages : Array.isArray(body.contents) ? body.contents : [];
  try {
    const cue = cueFor(list);
    const last = lastUserRecord(list);
    return attachPlaceCues(cue, [...placePathsFrom(body), ...(last ? placePathsFrom(last) : [])]);
  } catch {
    return "";
  }
}

const UPSTREAM_PLACE_KEYS = ["open_files", "openFiles", "files", "file_paths", "filePaths", "file_path", "filePath", "recently_viewed_files", "recentlyViewedFiles"] as const;

function sanitizePlaceField(v: unknown): unknown {
  if (typeof v === "string") return placePathsFrom(v).length ? v : undefined;
  if (Array.isArray(v)) {
    const next: string[] = [];
    for (const item of v) {
      if (typeof item === "string") {
        if (placePathsFrom(item).length) next.push(item);
        continue;
      }
      if (item && typeof item === "object") {
        for (const n of placePathsFrom(item)) if (!next.includes(n)) next.push(n);
      }
    }
    return next.length ? next : undefined;
  }
  if (v && typeof v === "object") {
    const names = placePathsFrom(v);
    return names.length ? names : undefined;
  }
  return undefined;
}

function sanitizeMessageList(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  let dirty = false;
  const copy = list.slice();
  for (let i = 0; i < copy.length; i++) {
    const m = copy[i];
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const o = m as Record<string, unknown>;
    let msgDirty = false;
    const next: Record<string, unknown> = { ...o };
    for (const k of UPSTREAM_PLACE_KEYS) {
      if (!(k in o)) continue;
      const sanitized = sanitizePlaceField(o[k]);
      if (sanitized === undefined) {
        delete next[k];
        msgDirty = true;
      } else if (JSON.stringify(sanitized) !== JSON.stringify(o[k])) {
        next[k] = sanitized;
        msgDirty = true;
      }
    }
    if (msgDirty) {
      copy[i] = next;
      dirty = true;
    }
  }
  return dirty ? copy : list;
}

export function stripUpstreamPlaceFields(body: Record<string, unknown>): Record<string, unknown> {
  try {
    let dirty = false;
    for (const k of UPSTREAM_PLACE_KEYS) {
      if (k in body) {
        dirty = true;
        break;
      }
    }
    const messages = sanitizeMessageList(body.messages);
    const contents = sanitizeMessageList(body.contents);
    if (messages !== body.messages || contents !== body.contents) dirty = true;
    if (!dirty) return body;
    const out = { ...body };
    for (const k of UPSTREAM_PLACE_KEYS) delete out[k];
    if (messages !== body.messages) out.messages = messages;
    if (contents !== body.contents) out.contents = contents;
    return out;
  } catch {
    return body;
  }
}

function headerPlaceNames(header: string): string[] {
  const parts: string[] = [];
  for (const part of header.split(/[\s,;]+/)) {
    const t = part.trim().replace(/^["']|["']$/g, "");
    if (t) parts.push(t);
  }
  return placePathsFrom(parts);
}

export function withOpenFileHeaders(body: Record<string, unknown>, header: string | null | undefined): Record<string, unknown> {
  try {
    const raw = typeof header === "string" ? header : "";
    if (!raw.trim()) return body;
    const names = headerPlaceNames(raw);
    if (!names.length) return body;
    const existing = placePathsFrom({
      open_files: body.open_files,
      openFiles: body.openFiles,
      files: body.files,
      file_paths: body.file_paths,
      filePaths: body.filePaths,
      file_path: body.file_path,
      filePath: body.filePath,
    });
    const open_files = [...existing];
    const seen = new Set(existing.map((n) => n.toLowerCase()));
    for (const n of names) {
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      open_files.push(n);
    }
    return { ...body, open_files };
  } catch {
    return body;
  }
}

function noteCount(packet: string): number {
  if (!packet.includes(MEMORY_MARK)) return 0;
  const i = packet.indexOf(MEMORY_MARK);
  return packet
    .slice(i + MEMORY_MARK.length)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ")).length;
}

function packetJunk(packet: string, cue: string): boolean {
  if (!packet.includes(MEMORY_MARK)) return false;
  const i = packet.indexOf(MEMORY_MARK);
  const notes = logTokens(packet.slice(i + MEMORY_MARK.length));
  const cueTok = logTokens(cue);
  if ([...notes].some((t) => TASK_TOKENS.has(t) && cueTok.has(t))) return false;
  if ([...notes].some((t) => LEFTOVER_TOKENS.has(t)) && [...cueTok].some((t) => TASK_TOKENS.has(t))) return true;
  for (const t of notes) {
    if (cueTok.has(t) && !LEFTOVER_TOKENS.has(t)) return false;
  }
  return true;
}

function logInjectMetric(original: Record<string, unknown>, next: Record<string, unknown>): void {
  const path = (process.env.EDEN_MEMORY_INJECT_LOG || "").trim();
  if (!path) return;
  try {
    const packet = packetFromInjected(next);
    const cue = cueFromInjected(original);
    const empty = !packet.includes(MEMORY_MARK);
    const n_notes = empty ? 0 : noteCount(packet);
    const junk = empty ? false : packetJunk(packet, cue);
    let arm: string | undefined;
    try {
      arm = memoryConsent() === "off" ? "off" : "on";
    } catch {
      arm = undefined;
    }
    const rec: Record<string, unknown> = {
      t: Date.now(),
      empty,
      n_notes,
      junk,
      cue: cue.slice(0, INJECT_LOG_CAP),
      packet: packet.slice(0, INJECT_LOG_CAP),
    };
    if (arm) rec.arm = arm;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(rec)}\n`);
  } catch {
  }
}

export function injectBodyThenObserveTools(mem: InjectHost, body: Record<string, unknown>): Record<string, unknown> {
  try {
    const next = mem.injectBody(body);
    observeToolTraces(mem, body.messages);
    logInjectMetric(body, next);
    return stripUpstreamPlaceFields(next);
  } catch {
    try {
      observeToolTraces(mem, body.messages);
    } catch {
    }
    logInjectMetric(body, body);
    return body;
  }
}
