import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { omitExperienceTree, putExperienceFromTool } from "../../../src/experience-store";
import { openMemory, type AgentMemory } from "../../../src/index";
import { authoredTexts, type TextSource } from "../../../src/memory-authority";
import { memoryConsent } from "../../../src/memory-consent";
import { repoIdentity, repoStoreDir } from "../../../src/memory-repo";
import { scrubMemoryText, scrubMemoryValue } from "../../../src/memory-scrub";
import { classifyImportRecord, isBinaryImportBytes, type MemoryImportKind } from "./memory-import-kinds";

export function memoryImportHelp(): string {
  return `usage: eden memory import <path>
       eden memory import --dry-run <path>
       eden memory dump [--json]
       eden memory remember "<text>" | --jsonl -
       eden memory purge <regex>
       eden memory forget --secret <regex>
       eden memory migrate [--dry-run | --apply | --rollback | --contract]

Read a JSONL or JSON transcript file or directory into AgentMemory: each record into
the store of the repo it ran in (its cwd, else this folder).
Local only. Dry-run counts records and does not write.
Missing or unreadable paths exit 0.
`;
}

type ToolBits = { name?: string; args?: Record<string, unknown>; result?: unknown };

type ImportRec = {
  kind: MemoryImportKind;
  role: string;
  content: string;
  /** Who wrote it (A6 §2.1), when the record shows it: a tool result, or a Claude transcript line (D12). */
  src?: TextSource;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  session?: string;
  cwd?: string;
};

type ScrubEnv = { session?: string; cwd?: string };

const SKIP: ImportRec = { kind: "skip", role: "user", content: "" };

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    const o = asRec(content);
    if (!o) return "";
    if (Array.isArray(o.parts)) return flattenContent(o.parts);
    return String(o.text ?? o.content ?? o.llmContent ?? o.reasoning_content ?? o.thinking ?? o.reasoning ?? "");
  }
  return content.map(flattenContent).filter(Boolean).join("\n");
}

function normRole(raw: string): string {
  if (raw === "human" || raw === "Human") return "user";
  if (raw === "model" || raw === "Model" || raw === "ai" || raw === "AI") return "assistant";
  return raw;
}

function asArgs(v: unknown): Record<string, unknown> | undefined {
  const o = asRec(v);
  if (o) return o;
  if (typeof v !== "string" || !v.trim().startsWith("{")) return undefined;
  try {
    const p = JSON.parse(v);
    return asRec(p) ?? undefined;
  } catch {
    return undefined;
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function resultText(result: unknown): string {
  let raw = result;
  try {
    raw = omitExperienceTree(result);
  } catch {}
  let s = "";
  if (typeof raw === "string") s = raw;
  else if (raw && typeof raw === "object") {
    const o = asRec(raw) ?? {};
    s = [o.stdout, o.stderr, o.text, o.content, o.llmContent, o.output, o.message, o.error]
      .filter((x) => typeof x === "string" && x)
      .join("\n");
    if (!s)
      try {
        s = JSON.stringify(raw);
      } catch {
        s = "";
      }
  }
  s = collapse(s);
  if (s.length > 360) s = s.slice(0, 360);
  return s;
}

function toolSentence(name: string | undefined, result: unknown): string {
  const body = resultText(result);
  const who = collapse(name || "tool") || "tool";
  if (!body) return name ? `The ${who} tool was called.` : "";
  return `The ${who} tool result is ${body}.`;
}

function toolPayload(o: Record<string, unknown>): ToolBits | null {
  const role = String(o.role || "");
  if (role === "tool" || role === "function") {
    const name = [o.tool_name, o.toolName, o.name, o.tool].find((x) => typeof x === "string" && String(x).trim()) as
      string | undefined;
    return {
      name,
      args: asArgs(o.tool_input ?? o.tool_args ?? o.args),
      result: o.tool_response ?? o.tool_output ?? o.content ?? o.result ?? o.output,
    };
  }
  const named =
    typeof o.tool_name === "string" ||
    typeof o.toolName === "string" ||
    (typeof o.tool === "string" && !o.role && !o.message);
  if (!named) return null;
  const name = [o.tool_name, o.toolName, o.tool].find((x) => typeof x === "string" && String(x).trim()) as
    string | undefined;
  return {
    name,
    args: asArgs(o.tool_input ?? o.tool_args ?? o.args ?? o.parameters),
    result: o.tool_response ?? o.tool_output ?? o.result ?? o.output,
  };
}

function splitParts(content: unknown): { text: string; tools: ToolBits[] } {
  if (!Array.isArray(content)) return { text: flattenContent(content), tools: [] };
  const texts: string[] = [];
  const tools: ToolBits[] = [];
  for (const part of content) {
    const o = asRec(part);
    const typ = o ? String(o.type || "") : "";
    if (o && (typ === "tool_use" || typ === "tool_call")) {
      tools.push({
        name: typeof o.name === "string" ? o.name : undefined,
        args: asArgs(o.input ?? o.args ?? o.parameters),
        result: o.result ?? o.output,
      });
      continue;
    }
    if (o && (typ === "tool_result" || typ === "tool_response")) {
      const name = [o.name, o.tool_name, o.toolName].find((x) => typeof x === "string" && String(x).trim()) as
        string | undefined;
      tools.push({ name, result: o.content ?? o.output ?? o.result ?? part });
      continue;
    }
    const t = flattenContent(part);
    if (t) texts.push(t);
  }
  return { text: texts.join("\n"), tools };
}

function toolRec(bits: ToolBits): ImportRec {
  const content = toolSentence(bits.name, bits.result);
  const kind = classifyImportRecord({ text: content, tool: true });
  if (kind === "skip") return SKIP;
  return {
    kind: "tools",
    role: "user",
    content,
    src: "tool",
    toolName: bits.name,
    toolArgs: bits.args,
    toolResult: bits.result,
  };
}

function textRec(role: string, content: string, src?: TextSource): ImportRec | null {
  const text = content.trim();
  if (!text) return null;
  if (role !== "user" && role !== "assistant") return SKIP;
  const kind = classifyImportRecord({ text });
  if (kind === "skip") return SKIP;
  if (kind === "tools") return { kind: "tools", role: "user", content: text, src: "tool" };
  return { kind: kind === "icl" ? "icl" : "chat", role, content: text, ...(src ? { src } : {}) };
}

/** Claude Code's transcript lines, which `authoredTexts` reads by source (D12); other shapes are read by role. */
const CLAUDE_LINES = new Set(["user", "assistant", "attachment"]);

/**
 * A Claude transcript line's texts by source, its tool results left to `toolRec`; host text yields none (SKIP).
 */
function claudeTextRecs(o: Record<string, unknown>): ImportRec[] {
  const texts = authoredTexts(o).filter((authored) => authored.src !== "tool");
  const recs = texts.flatMap(({ src, text }) => textRec(src === "agent" ? "assistant" : "user", text, src) ?? []);
  return recs.length ? recs : [SKIP];
}

function scrubEnvOf(o: Record<string, unknown>, inherited?: ScrubEnv): ScrubEnv {
  const msg = asRec(o.message);
  const sessionRaw = [o.session_id, o.sessionId, o.sessionID, msg?.session_id, msg?.sessionId, msg?.sessionID].find(
    (x) => typeof x === "string" && String(x).trim().length >= 8,
  );
  const cwdRaw = [o.cwd, msg?.cwd].find((x) => typeof x === "string" && String(x).trim());
  const session = typeof sessionRaw === "string" ? sessionRaw.trim() : inherited?.session;
  const cwd = typeof cwdRaw === "string" ? cwdRaw.trim() : inherited?.cwd;
  return session || cwd ? { session, cwd } : {};
}

function stamp(rec: ImportRec, env: ScrubEnv): ImportRec {
  if (rec.kind === "skip" || (!env.session && !env.cwd)) return rec;
  return { ...rec, session: env.session, cwd: env.cwd };
}

function fromObject(o: Record<string, unknown>, inherited?: ScrubEnv): ImportRec[] {
  const env = scrubEnvOf(o, inherited);
  const tool = toolPayload(o);
  if (tool) return [stamp(toolRec(tool), env)];
  const msg = asRec(o.message) ?? o;
  const role = normRole(String(msg.role || o.type || ""));
  const raw = msg.content ?? msg.parts ?? msg.text;
  const extra = [msg.llmContent, msg.reasoning_content, msg.thinking, msg.reasoning]
    .filter((x) => typeof x === "string" && x)
    .join("\n");
  const parts = splitParts(raw);
  const out: ImportRec[] = parts.tools.map((bits) => stamp(toolRec(bits), env));
  if (CLAUDE_LINES.has(String(o.type))) {
    const texts = claudeTextRecs(o).map((rec) => stamp(rec, env));
    return out.length ? [...out, ...texts.filter((rec) => rec.kind !== "skip")] : texts;
  }
  const text = [parts.text, extra].filter(Boolean).join("\n");
  const row = textRec(role, text);
  if (row) out.push(stamp(row, env));
  else if (!out.length) out.push(SKIP);
  return out;
}

function fromValue(v: unknown, inherited?: ScrubEnv): ImportRec[] {
  if (Array.isArray(v)) return v.flatMap((item) => fromValue(item, inherited));
  const o = asRec(v);
  if (!o) return [SKIP];
  const env = scrubEnvOf(o, inherited);
  if (Array.isArray(o.messages)) return fromValue(o.messages, env);
  return fromObject(o, env);
}

function parseJsonl(text: string): ImportRec[] {
  const out: ImportRec[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(...fromValue(JSON.parse(line)));
    } catch {
      out.push(SKIP);
    }
  }
  return out;
}

function parseText(file: string, text: string): ImportRec[] {
  const ext = extname(file).toLowerCase();
  if (ext === ".jsonl" || ext === ".ndjson") return parseJsonl(text);
  if (ext !== ".json") {
    const t = text.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return [SKIP];
    const lines = t.split("\n").filter((l) => l.trim());
    if (lines.length > 1) return parseJsonl(text);
  }
  try {
    return fromValue(JSON.parse(text));
  } catch {
    return text.includes("\n") ? parseJsonl(text) : [SKIP];
  }
}

function recordsInFile(file: string): ImportRec[] {
  try {
    const buf = readFileSync(file);
    if (isBinaryImportBytes(buf, file)) return [SKIP];
    return parseText(file, buf.toString("utf8"));
  } catch {
    return [];
  }
}

function listFiles(path: string): string[] {
  try {
    const st = statSync(path);
    if (st.isFile()) return [path];
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    let ents: Dirent[] = [];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      const p = join(dir, ent.name);
      try {
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile()) out.push(p);
      } catch {}
    }
  };
  walk(path);
  return out;
}

function storeCap(): number {
  return Number(process.env.EDEN_MEMORY_STORE_CAP) || 2000;
}

function memoryDir(override?: string): string {
  if (override) return override;
  if (process.env.EDEN_MEMORY_DIR) return process.env.EDEN_MEMORY_DIR;
  if (process.env.EDEN_HOME) return join(process.env.EDEN_HOME, "memory");
  return join(homedir(), ".eden", "memory");
}

function emptyKinds(): Record<string, number> {
  return { chat: 0, icl: 0, tools: 0, skip: 0 };
}

function kindLine(kinds: Record<string, number>): string {
  return `${kinds.chat ?? 0} chat · ${kinds.icl ?? 0} icl · ${kinds.tools ?? 0} tools · ${kinds.skip ?? 0} skip`;
}

export async function importMemoryPath(
  path: string,
  opts?: { dryRun?: boolean; dir?: string },
): Promise<{ observed: number; skip: number; kinds: Record<string, number> }> {
  const kinds = emptyKinds();
  try {
    const records = listFiles(path).flatMap(recordsInFile);
    const dry = opts?.dryRun === true;
    let writes = false;
    try {
      writes = !dry && memoryConsent() === "on";
    } catch {
      writes = false;
    }
    const cap = storeCap();
    let observed = 0;
    const stores = new Map<string, AgentMemory>();
    // D1: a record goes to the store of the repo it ran in (its `cwd`, else this folder), unless `dir` names one.
    const open = (cwd: string | undefined): AgentMemory | undefined => {
      if (!writes) return undefined;
      const repo = repoIdentity(cwd) ?? repoIdentity(process.cwd())!;
      const dir = opts?.dir ?? repoStoreDir(memoryDir(), repo.key);
      try {
        const mem = stores.get(dir) ?? openMemory({ dir, perRepo: !opts?.dir });
        stores.set(dir, mem);
        return mem;
      } catch {
        return undefined;
      }
    };
    for (const rec of records) {
      kinds[rec.kind] = (kinds[rec.kind] ?? 0) + 1;
      if (rec.kind === "skip" || observed >= cap) continue;
      const mem = open(rec.cwd);
      if (!mem) continue;
      try {
        const ctx: ScrubEnv = { session: rec.session, cwd: rec.cwd };
        // D13: a record the gate cannot pass is skipped (the catch below), never stored as it came.
        const content = scrubMemoryText(rec.content, ctx);
        const toolArgs = rec.toolArgs && (scrubMemoryValue(rec.toolArgs, ctx) as Record<string, unknown>);
        const toolResult = rec.toolResult === undefined ? undefined : scrubMemoryValue(rec.toolResult, ctx);
        if (rec.kind === "tools") {
          if (content) mem.observe([{ role: "user", content, src: "tool" }], { deferSleep: true });
          if (rec.toolName || toolResult !== undefined) {
            putExperienceFromTool(mem.dir, {
              name: rec.toolName,
              args: toolArgs,
              result: toolResult,
              session: rec.session,
              cwd: rec.cwd,
            });
          }
        } else if (content) {
          mem.observe([{ role: rec.role || "user", content, src: rec.src }], { deferSleep: true });
        }
        observed++;
      } catch {}
    }
    for (const mem of stores.values())
      try {
        mem.close();
      } catch {}
    return { observed, skip: kinds.skip ?? 0, kinds };
  } catch {
    return { observed: 0, skip: kinds.skip ?? 0, kinds };
  }
}

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return existsSync(path);
  } catch {
    return false;
  }
}

function flagPath(args: string[]): string | undefined {
  return args.find((a) => a !== "import" && a !== "--dry-run" && !a.startsWith("-"));
}

export async function memoryCli(args: string[]): Promise<number> {
  if (args[0] === "purge" || args[0] === "forget") {
    const { memoryPurgeCli } = await import("./memory-purge");
    return memoryPurgeCli(args);
  }
  if (args[0] === "migrate") {
    const { memoryMigrateCli } = await import("./memory-migrate");
    return memoryMigrateCli(args.slice(1));
  }
  if (args[0] === "extract") {
    const { memoryExtractCli } = await import("./memory-extract");
    return memoryExtractCli(args.slice(1));
  }
  if (args[0] === "remember") {
    const { memoryRememberCli } = await import("./memory-remember");
    return memoryRememberCli(args.slice(1));
  }
  if (args[0] === "dump") {
    const { memoryDumpCli } = await import("./memory-dump");
    return memoryDumpCli(args.slice(1));
  }
  try {
    const rest = args[0] === "import" ? args.slice(1) : args;
    const help = rest.length === 0 || rest.includes("-h") || rest.includes("--help") || rest[0] === "help";
    if (help && !rest.includes("--dry-run") && !flagPath(args)) {
      console.log(memoryImportHelp());
      return 0;
    }
    const path = flagPath(args);
    if (!path || !readable(path)) {
      console.log("import: nothing to read");
      return 0;
    }
    const dryRun = args.includes("--dry-run");
    const result = await importMemoryPath(path, { dryRun });
    if (dryRun) console.log(`import dry-run: ${kindLine(result.kinds)}`);
    else if (memoryConsent() !== "on") console.log(`import: ${kindLine(result.kinds)}`);
    else console.log(`imported: ${result.observed} observed · skip ${result.skip}`);
    return 0;
  } catch {
    console.log("import: nothing to read");
    return 0;
  }
}
