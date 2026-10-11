/**
 * A handler's `if` filter, as Claude Code evaluates it (hooks reference, "Common fields" and the Bash matching
 * table, `docs/memory-ship/research/sources/claude-code-hooks.2026-09-29.md`):
 *
 * - `if` holds one permission rule, `Tool` or `Tool(pattern)`, and is evaluated only on tool events (PreToolUse,
 *   PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied). On any other event a handler with `if`
 *   never runs.
 * - A Bash pattern is checked against each subcommand (split at `&&`, `||`, `;`, `|`, `&` and line breaks outside
 *   quotes), after leading `VAR=value` assignments are stripped. Commands inside `$()` and backticks are checked too,
 *   and so is the full command around them.
 * - When the command name is a variable (`$TOOL git push`), Claude Code cannot tell what runs, so the hook runs. A
 *   pattern that says more than the command name (`git push *`) also runs the hook on any `$()`, backtick or
 *   `$VAR`.
 * - In a pattern, `*` matches any run of characters, and a trailing ` *` also matches the bare command (`git *`
 *   matches `git`). This module is the simulator's own reading, kept apart from the product's re-check (X6).
 */
import type { HookEvent } from "./payloads";

const TOOL_EVENTS = new Set<HookEvent | string>([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
]);

/** Whether a handler whose `if` is `rule` runs for this event and tool call. */
export function ifAccepts(rule: string, event: string, toolName: unknown, toolInput: unknown): boolean {
  if (!TOOL_EVENTS.has(event)) return false;
  const parsed = /^([^()]+?)(?:\((.*)\))?$/s.exec(rule.trim());
  if (!parsed || parsed[1]!.trim() !== String(toolName ?? "")) return false;
  const pattern = parsed[2];
  if (pattern === undefined || pattern === "" || pattern === "*") return true;
  const input = (toolInput ?? {}) as Record<string, unknown>;
  if (toolName === "Bash") return bashAccepts(pattern, String(input.command ?? ""));
  const target = String(input.file_path ?? input.path ?? input.url ?? input.pattern ?? "");
  return globRegex(pattern).test(target);
}

/** Whether a Bash command runs a hook whose pattern is `pattern` (see the header). */
export function bashAccepts(pattern: string, command: string): boolean {
  const saysMore = !/^[\w.-]+$/.test(pattern.trim().replace(/\s*\*$/, ""));
  if (saysMore && /\$\(|`|\$[A-Za-z_{]/.test(command)) return true;
  const regex = globRegex(pattern);
  return subcommands(command).some((part) => {
    const bare = withoutAssignments(part);
    return /^\$/.test(bare) || regex.test(bare);
  });
}

function globRegex(pattern: string): RegExp {
  const trimmed = pattern.trim();
  const optionalTail = / \*$/.test(trimmed);
  const body = optionalTail ? trimmed.slice(0, -2) : trimmed;
  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${optionalTail ? "(?:\\s.*)?" : ""}$`, "s");
}

function withoutAssignments(command: string): string {
  return command.replace(/^(?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, "").trim();
}

/**
 * Each subcommand of a command line, and each command inside `$()` or backticks, with the full subcommand kept
 * around a substitution.
 */
export function subcommands(command: string): string[] {
  const out: string[] = [];
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (quote === '"' && char === "$" && command[at + 1] === "(") {
        const end = closingParen(command, at + 1);
        out.push(...subcommands(command.slice(at + 2, end)));
        current += command.slice(at, end + 1);
        at = end;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === "$" && command[at + 1] === "(") {
      const end = closingParen(command, at + 1);
      out.push(...subcommands(command.slice(at + 2, end)));
      current += command.slice(at, end + 1);
      at = end;
    } else if (char === "`") {
      const end = command.indexOf("`", at + 1);
      const stop = end < 0 ? command.length : end;
      out.push(...subcommands(command.slice(at + 1, stop)));
      current += command.slice(at, stop + 1);
      at = stop;
    } else if (/[;&|\n]/.test(char)) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return [...parts.map((part) => part.trim()).filter(Boolean), ...out];
}

function closingParen(command: string, open: number): number {
  let depth = 0;
  for (let at = open; at < command.length; at++) {
    if (command[at] === "(") depth++;
    else if (command[at] === ")" && --depth === 0) return at;
  }
  return command.length;
}
