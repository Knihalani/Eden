/**
 * Which action classes a tool call is (A7 §5's re-check; D19): what the PreToolUse guard answers for, and all the
 * plugin's `hook.ts` loads before Eden's hook, so a call no class matches costs a process start and nothing more.
 *
 * A Bash command is read as Claude Code reads an `if` rule: subcommands at `&&`, `||`, `;`, `|`, `&` and line breaks
 * outside quotes, commands inside `$()` and backticks, leading `VAR=value` stripped. Each subcommand is re-checked
 * against each class's `check` (`memory-classes.json`), since `if` is best-effort. A subcommand whose command name is a
 * variable (`$GH pr merge`) names no class, as what it runs cannot be read, and neither does one that only asks for
 * help or a dry run (`--help`, `--dry-run`). Another tool is matched by a class's `tools`
 * (`mcp__github__merge_pull_request` is integrate).
 */
import { GUARDED_CLASSES, severityRank, type ActionClass } from "./memory-classes";

/** A tool call as a PreToolUse payload carries it. */
export interface GuardCall {
  tool: string;
  input: Record<string, unknown>;
}

/** The subcommands of a Bash command line (see the header), and commands inside `$()` and backticks. */
export function subcommandsOf(command: string): string[] {
  const parts: string[] = [];
  const inner: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!;
    const substitution = char === "$" && command[at + 1] === "(" && quote !== "'";
    if (substitution || (char === "`" && !quote)) {
      const end = substitution ? closingParen(command, at + 1) : command.indexOf("`", at + 1);
      const stop = end < 0 ? command.length : end;
      inner.push(...subcommandsOf(command.slice(at + (substitution ? 2 : 1), stop)));
      current += command.slice(at, stop + 1);
      at = stop;
    } else if (quote) {
      if (char === quote) quote = undefined;
      current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (/[;&|\n]/.test(char)) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return [...parts, ...inner]
    .map((part) => part.replace(/^(?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, "").trim())
    .filter(Boolean);
}

function closingParen(command: string, open: number): number {
  let depth = 0;
  for (let at = open; at < command.length; at++) {
    if (command[at] === "(") depth++;
    else if (command[at] === ")" && --depth === 0) return at;
  }
  return command.length;
}

/** A subcommand that only asks for help or a dry run carries out nothing. */
const NO_ACTION = /\s--(?:help|dry-run)\b/;

export const CHECKS = GUARDED_CLASSES.map(([cls, guard]) => ({
  cls,
  check: new RegExp(guard.check, "i"),
  tools: guard.tools ? new RegExp(`^(?:${guard.tools})$`) : undefined,
}));

/** A call's Bash command, if it is one. */
export function commandOf(call: GuardCall): string | undefined {
  return call.tool === "Bash" && typeof call.input.command === "string" ? call.input.command : undefined;
}

/** The subcommands of a call that a class's check matches, readable ones only (see the header). */
export function partsOf(call: GuardCall, check: RegExp): string[] {
  const command = commandOf(call);
  return command === undefined
    ? []
    : subcommandsOf(command).filter((part) => !/^\$/.test(part) && !NO_ACTION.test(part) && check.test(part));
}

/** The classes a call is, most severe first. */
export function callClasses(call: GuardCall): ActionClass[] {
  return CHECKS.filter(({ check, tools }) => (tools ? tools.test(call.tool) : false) || partsOf(call, check).length)
    .map(({ cls }) => cls)
    .sort((a, b) => severityRank(a) - severityRank(b));
}

/** Whether a PreToolUse payload is a call some class is: the guard has something to look up. */
export function guardedCall(payload: Record<string, unknown>): boolean {
  if (payload.hook_event_name !== "PreToolUse" || typeof payload.tool_name !== "string") return false;
  const input = payload.tool_input;
  const call = {
    tool: payload.tool_name,
    input: input && typeof input === "object" ? (input as Record<string, unknown>) : {},
  };
  return callClasses(call).length > 0;
}
