export type MemoryImportKind = "icl" | "chat" | "tools" | "skip";

const BINARY_EXT = /\.(?:png|jpg|jpeg|gif|webp|pdf|woff2?|bin|exe|dll|so|dylib|zip|gz|wasm|ico|mp4|mp3)$/i;
const TOOL_MARK = /\b(?:tool_name|toolName|tool_calls|PostToolUse|tool_use|tool_result)\b/;
const TOOL_SENTENCE = /The \S+ tool (?:result is|was called)\b/i;

function asBytes(bytes?: Uint8Array | string): Uint8Array | undefined {
  if (bytes instanceof Uint8Array) return bytes;
  if (typeof bytes === "string") return new TextEncoder().encode(bytes);
  return undefined;
}

function hasNul(bytes?: Uint8Array | string, text?: string): boolean {
  if (typeof text === "string" && text.includes("\0")) return true;
  if (typeof bytes === "string") return bytes.includes("\0");
  if (bytes instanceof Uint8Array) {
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return true;
  }
  return false;
}

function controlHeavy(bytes?: Uint8Array | string): boolean {
  const buf = asBytes(bytes);
  if (!buf || !buf.length) return false;
  const n = Math.min(buf.length, 64);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i]!;
    if (c === 0 || c === 9 || c === 10 || c === 13) continue;
    if (c < 32) bad++;
  }
  return bad / n > 0.3;
}

/** Binary path, NUL, or a control-heavy buffer. Never throws. */
export function isBinaryImportBytes(bytes?: Uint8Array | string, path?: string): boolean {
  try {
    if (typeof path === "string" && BINARY_EXT.test(path)) return true;
    if (hasNul(bytes)) return true;
    return controlHeavy(bytes);
  } catch {
    return true;
  }
}

/** Tool flag or a tool-trace blob. Never throws. Does not persist. */
export function isToolImportRecord(input: { text?: string; tool?: boolean }): boolean {
  try {
    if (input.tool) return true;
    const t = String(input.text ?? "");
    if (!t) return false;
    if (TOOL_MARK.test(t) || TOOL_SENTENCE.test(t)) return true;
    const trimmed = t.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const o = JSON.parse(trimmed) as unknown;
        if (o && typeof o === "object" && !Array.isArray(o)) {
          const rec = o as Record<string, unknown>;
          if (rec.tool_name || rec.toolName || rec.tool_calls) return true;
          const typ = String(rec.type || rec.role || "");
          if (typ === "tool_use" || typ === "tool_result" || typ === "tool" || typ === "function") return true;
        }
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

/** Never throws. Binary / empty / unreadable → skip. */
export function classifyImportRecord(input: {
  text?: string;
  path?: string;
  bytes?: Uint8Array | string;
  tool?: boolean;
}): MemoryImportKind {
  try {
    if (isBinaryImportBytes(input.bytes, input.path)) return "skip";
    if (hasNul(undefined, input.text)) return "skip";
    if (isToolImportRecord({ text: input.text, tool: input.tool })) return "tools";
    const text = String(input.text ?? "").trim();
    if (!text) return "skip";
    return "chat";
  } catch {
    return "skip";
  }
}
