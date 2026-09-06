/**
 * Claude Code native tool-result shapes (Wave 5 / R1).
 *
 * `updatedToolOutput` is applied only when it matches the tool's native object.
 * A string rewrite for a built-in is silently dropped. Merge the sentinel into
 * the text-bearing field; never replace a structured result with a bare string.
 */

export const HOOK_OUTPUT_CAP = 9_500;

const DANGEROUS_KEY = /^(?:__proto__|constructor|prototype)$/;

/** Single escaping builder for facts that ride the hook channel. */
export function escapeFacts(facts: unknown): string {
  let raw: string;
  if (typeof facts === "string") {
    raw = facts;
  } else {
    try {
      raw =
        JSON.stringify(facts, (key, value) => {
          if (DANGEROUS_KEY.test(key)) return undefined;
          return value;
        }) ?? String(facts);
    } catch {
      raw = String(facts);
    }
  }
  return raw
    .replace(/\u0000/g, "\\u0000")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/__proto__/g, "__\u200bproto__")
    .replace(/\bconstructor\b/g, "construct\u200bor")
    .replace(/\bprototype\b/g, "proto\u200btype");
}

export function buildSentinel(programName: string, facts: unknown): string {
  const body = escapeFacts(facts);
  return `\n\n[eden:${programName}] The remaining steps of this routine were already served (read-only). Facts:\n${body}\nDo not re-run this routine — the facts above are complete.`;
}

export function capMerged(original: string, suffix: string, cap = HOOK_OUTPUT_CAP): string {
  const merged = `${original}${suffix}`;
  if (merged.length <= cap) return merged;
  const kept = cap - 120;
  return `${original.slice(0, Math.max(0, kept))}\n…[eden truncated ${original.length - kept} chars of the original output to fit the harness limit]\n${suffix}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function own(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  if (!isRecord(v)) return out;
  for (const k of Object.keys(v)) {
    if (DANGEROUS_KEY.test(k)) continue;
    out[k] = v[k];
  }
  return out;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function originalText(original: unknown): string {
  if (typeof original === "string") return original;
  try {
    return JSON.stringify(original) ?? "";
  } catch {
    return String(original);
  }
}

export type ToolShape = {
  /** True when `value` is a native result the host will accept. */
  match(value: unknown): boolean;
  /** Merge sentinel into the native object (or build one from a non-native original). */
  merge(original: unknown, sentinel: string): unknown;
  /** Text the model would read from a native (or string) result. */
  textOf(value: unknown): string;
  /** True when this shape has no text field — sentinel lives only in additionalContext. */
  textField?: "none";
};

const Bash: ToolShape = {
  match(v) {
    if (!isRecord(v)) return false;
    if (typeof v.stdout !== "string" || typeof v.stderr !== "string" || typeof v.interrupted !== "boolean") return false;
    if (v.isImage !== undefined && typeof v.isImage !== "boolean") return false;
    return true;
  },
  merge(original, sentinel) {
    if (this.match(original)) {
      const o = original as Record<string, unknown>;
      return {
        stdout: capMerged(asString(o.stdout), sentinel),
        stderr: asString(o.stderr),
        interrupted: asBool(o.interrupted),
        isImage: asBool(o.isImage, false),
      };
    }
    return {
      stdout: capMerged(originalText(original), sentinel),
      stderr: "",
      interrupted: false,
      isImage: false,
    };
  },
  textOf(v) {
    return isRecord(v) ? asString(v.stdout) : typeof v === "string" ? v : "";
  },
};

const Read: ToolShape = {
  match(v) {
    if (!isRecord(v) || v.type !== "text" || !isRecord(v.file)) return false;
    const f = v.file;
    return (
      typeof f.filePath === "string" &&
      typeof f.content === "string" &&
      typeof f.numLines === "number" &&
      typeof f.startLine === "number" &&
      typeof f.totalLines === "number"
    );
  },
  merge(original, sentinel) {
    const prior = this.match(original) ? (original as { file: Record<string, unknown> }).file : own(isRecord(original) && isRecord(original.file) ? original.file : original);
    const filePath = asString(prior.filePath, asString(isRecord(original) ? original.filePath : undefined));
    const startLine = asNumber(prior.startLine, 1) || 1;
    const base = this.match(original) ? asString(prior.content) : originalText(original);
    const content = capMerged(base, sentinel);
    const lines = lineCount(content) || 1;
    return {
      type: "text",
      file: {
        filePath,
        content,
        numLines: lines,
        startLine,
        totalLines: lines,
      },
    };
  },
  textOf(v) {
    if (isRecord(v) && isRecord(v.file)) return asString(v.file.content);
    return typeof v === "string" ? v : "";
  },
};

const WebFetch: ToolShape = {
  match(v) {
    if (!isRecord(v)) return false;
    return (
      typeof v.bytes === "number" &&
      typeof v.code === "number" &&
      typeof v.codeText === "string" &&
      typeof v.result === "string" &&
      typeof v.durationMs === "number" &&
      typeof v.url === "string"
    );
  },
  merge(original, sentinel) {
    const o = this.match(original) ? (original as Record<string, unknown>) : own(original);
    const base = this.match(original) ? asString(o.result) : originalText(original);
    return {
      bytes: asNumber(o.bytes),
      code: asNumber(o.code, 200),
      codeText: asString(o.codeText, "OK"),
      result: capMerged(base, sentinel),
      durationMs: asNumber(o.durationMs),
      url: asString(o.url),
    };
  },
  textOf(v) {
    return isRecord(v) ? asString(v.result) : typeof v === "string" ? v : "";
  },
};

const Glob: ToolShape = {
  textField: "none",
  match(v) {
    if (!isRecord(v)) return false;
    if (!Array.isArray(v.filenames) || typeof v.durationMs !== "number") return false;
    if (v.numFiles !== undefined && typeof v.numFiles !== "number") return false;
    if (v.truncated !== undefined && typeof v.truncated !== "boolean") return false;
    return true;
  },
  merge(original) {
    // No text field on the real schema — keep native identity so the rewrite
    // is applied; sentinel rides additionalContext only.
    if (this.match(original)) {
      const o = original as Record<string, unknown>;
      const out: Record<string, unknown> = {
        filenames: o.filenames,
        durationMs: o.durationMs,
      };
      if (typeof o.numFiles === "number") out.numFiles = o.numFiles;
      if (typeof o.truncated === "boolean") out.truncated = o.truncated;
      return out;
    }
    return { filenames: [] as string[], durationMs: 0 };
  },
  textOf() {
    return "";
  },
};

const Grep: ToolShape = {
  match(v) {
    if (!isRecord(v)) return false;
    if (typeof v.mode !== "string" || typeof v.numFiles !== "number" || !Array.isArray(v.filenames)) return false;
    if (v.content !== undefined && typeof v.content !== "string") return false;
    if (v.numLines !== undefined && typeof v.numLines !== "number") return false;
    return true;
  },
  merge(original, sentinel) {
    if (this.match(original)) {
      const o = original as Record<string, unknown>;
      const out: Record<string, unknown> = {
        mode: o.mode,
        numFiles: o.numFiles,
        filenames: o.filenames,
      };
      if (typeof o.content === "string") {
        const merged = capMerged(o.content, sentinel);
        out.content = merged;
        if (typeof o.numLines === "number") out.numLines = lineCount(merged);
      } else if (typeof o.numLines === "number") {
        out.numLines = o.numLines;
      }
      return out;
    }
    return { mode: "files_with_matches", numFiles: 0, filenames: [] as string[] };
  },
  textOf(v) {
    if (isRecord(v) && typeof v.content === "string") return v.content;
    return typeof v === "string" ? v : "";
  },
};

const Write: ToolShape = {
  match(v) {
    if (!isRecord(v)) return false;
    if (v.type !== "create" && v.type !== "update") return false;
    return (
      typeof v.filePath === "string" &&
      typeof v.content === "string" &&
      "structuredPatch" in v &&
      "originalFile" in v
    );
  },
  merge(original, sentinel) {
    const o = this.match(original) ? (original as Record<string, unknown>) : own(original);
    const base = this.match(original) ? asString(o.content) : originalText(original);
    return {
      type: o.type === "create" || o.type === "update" ? o.type : "update",
      filePath: asString(o.filePath),
      content: capMerged(base, sentinel),
      structuredPatch: o.structuredPatch ?? [],
      originalFile: o.originalFile ?? "",
    };
  },
  textOf(v) {
    return isRecord(v) ? asString(v.content) : typeof v === "string" ? v : "";
  },
};

export const TOOL_SHAPES: Record<string, ToolShape> = {
  Bash,
  Read,
  WebFetch,
  Glob,
  Grep,
  Write,
};

export const BUILTIN_TOOLS = Object.keys(TOOL_SHAPES);

export function isBuiltInTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_SHAPES, name);
}

export function matchesNativeShape(toolName: string, value: unknown): boolean {
  const shape = TOOL_SHAPES[toolName];
  if (!shape) return typeof value === "string" || isRecord(value);
  return shape.match(value);
}

export function mergeSentinel(toolName: string, original: unknown, sentinel: string): unknown {
  const shape = TOOL_SHAPES[toolName];
  if (!shape) return capMerged(originalText(original), sentinel);
  return shape.merge(original, sentinel);
}

export function nativeTextOf(toolName: string, value: unknown): string {
  const shape = TOOL_SHAPES[toolName];
  if (!shape) return typeof value === "string" ? value : originalText(value);
  return shape.textOf(value);
}

export function sentinelInTextField(toolName: string): boolean {
  return TOOL_SHAPES[toolName]?.textField !== "none";
}

/**
 * Host-native names → Claude builtin, only when the result shape is the same.
 * `edit` stays unmapped (string merge): OpenCode's edit output is not Write's
 * `{type,filePath,content,structuredPatch,originalFile}`.
 */
export const HOST_TOOL_ALIASES: Record<string, string> = {
  bash: "Bash",
  shell: "Bash",
  run_shell_command: "Bash",
  read: "Read",
  read_file: "Read",
  write: "Write",
  write_file: "Write",
  grep: "Grep",
  grep_search: "Grep",
  search_file_content: "Grep",
  glob: "Glob",
  glob_files: "Glob",
  webfetch: "WebFetch",
  web_fetch: "WebFetch",
};

export function mapHostToolName(name: string): string {
  if (!name) return name;
  if (isBuiltInTool(name)) return name;
  const aliased = HOST_TOOL_ALIASES[name.toLowerCase()];
  return aliased ?? name;
}

/** OpenCode MCP after-hook payload (issue #25918): raw CallToolResult. */
export function isMcpShapedOutput(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.content) || value.content.length === 0) return false;
  return value.content.every(
    (part) => isRecord(part) && typeof part.type === "string",
  );
}
