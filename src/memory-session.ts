/**
 * Session and window names (D2): a name is safe as one path segment, and a subagent's window is `session--agent`.
 * Apart from `index.ts`, so a hook that names a window (the PreToolUse guard) need not load the store.
 */
export function memorySessionName(raw: unknown): string | undefined {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s &&
    !s.includes("\0") &&
    !s.includes("/") &&
    !s.includes("\\") &&
    !s.split("--").join("").includes("..") &&
    /^[A-Za-z0-9._-]+$/.test(s) &&
    s !== "." &&
    s !== ".."
    ? s
    : undefined;
}

export function childSessionName(parent?: string, child?: string): string | undefined {
  const p = memorySessionName(parent),
    c = memorySessionName(child);
  return p && c ? memorySessionName(`${p}--${c}`) : (c ?? p);
}
