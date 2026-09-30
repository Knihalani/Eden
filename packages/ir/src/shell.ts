import { getPath } from "./path";
import type { Binding } from "./types";

/**
 * Tools whose `command` argument is a command line a shell parses.
 *
 * Mining clusters these by command shape, and the binders shell-quote the
 * values they splice into the command. One set, so the two cannot drift apart.
 */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "bash", "shell", "Shell"]);

/** Is `key` of `tool` a shell command line? A shape-derived name (`Bash:kubectl.get.pods`) counts as its tool. */
export function isShellCommand(tool: string, key: string): boolean {
  return key === "command" && SHELL_TOOLS.has(tool.split(":")[0]!);
}

/**
 * Can a shell command line bound this way keep upstream data out of its syntax?
 *
 * Yes for the witnessed literal, the caller's own input, and a template, whose
 * slot values interpolateShell quotes. Not for a command taken whole from an
 * earlier step's result (a fetched record, an island's output): it would run
 * whatever that step returned, and quoting it would stop it being a command.
 */
export function isSafeShellCommand(b: Binding): boolean {
  return b.kind === "literal" || b.kind === "input" || (b.kind === "transform" && b.fn === "template");
}

/** Never shell syntax in any quoting context, so a value made only of these is spliced as is. */
const PLAIN = /^[A-Za-z0-9._/:=@%+-]+$/;

type Quote = "none" | "single" | "double" | "opaque";

/**
 * The quote state at the end of `text`, read from the start of a command.
 *
 * Only quotes and backslash escapes are followed. Every construct that nests a
 * new quoting level or reads its text again as code makes the rest opaque:
 * a backtick, `$(`, `${`, `$[`, `$'`, `$"`, a here-document, a comment, and bash's
 * arithmetic `((` and `[[`, which evaluate even a quoted operand
 * (`[[ 'a[$(cmd)]' -eq 1 ]]` runs cmd).
 */
function quoteAt(text: string): Quote {
  let q: Quote = "none";
  for (let i = 0; i < text.length && q !== "opaque"; i++) {
    const c = text[i]!;
    const next = text[i + 1] ?? "";
    if (q === "single") {
      if (c === "'") q = "none";
    } else if (c === "\\") {
      i++;
    } else if (c === "`" || (c === "$" && next !== "" && "({['\"".includes(next))) {
      q = "opaque";
    } else if (q === "double") {
      if (c === '"') q = "none";
    } else if (c === "'") {
      q = "single";
    } else if (c === '"') {
      q = "double";
    } else if ((c === "<" && next === "<") || (c === "(" && next === "(") || (c === "[" && next === "[")) {
      q = "opaque";
    } else if (c === "#" && (i === 0 || /[\s;&|()<>]/.test(text[i - 1]!))) {
      q = "opaque";
    }
  }
  return q;
}

/** POSIX single-quoting: the shell reads the result as exactly `v`. */
function singleQuoted(v: string): string {
  return `'${v.replaceAll("'", `'\\''`)}'`;
}

/**
 * `v` as it must be spliced where the template's quote state is `q`, or null
 * where no quoting can be trusted to keep it data.
 *
 * A value that cannot change the parse is left as it is, so the command the
 * compiler verified against its witnesses is reproduced byte for byte. Inside
 * a quoted string the template's own quote is closed around the quoted value
 * and reopened after it.
 */
function spliced(v: string, q: Quote): string | null {
  if (q === "none") return PLAIN.test(v) ? v : singleQuoted(v);
  if (q === "single") return v.includes("'") ? `'${singleQuoted(v)}'` : v;
  if (q === "double") return /[$`"\\!]/.test(v) ? `"${singleQuoted(v)}"` : v;
  return PLAIN.test(v) ? v : null;
}

/**
 * interpolateSlots for a shell command line: every slot value is data.
 *
 * The template text is the witnessed command and is never changed. Each value
 * is quoted for the context its slot sits in (see spliced()), so a value such
 * as `x; rm -rf ~` or `$(curl evil)` reaches the command as one literal string.
 *
 * Returns null when a value would land where quoting cannot be trusted: in an
 * opaque context (quoteAt) unless it is plain, or glued to a preceding `\`,
 * `$name` or `~name`, where it would extend an escape, a parameter name or a
 * login name. The caller must not run the command then.
 */
export function interpolateShell(expr: string, value: unknown): string | null {
  let out = "";
  let from = 0;
  for (const m of expr.matchAll(/\{([\w.]+)\}/g)) {
    const before = expr.slice(from, m.index);
    out += before;
    from = m.index + m[0].length;
    const v = getPath(value, m[1]!);
    if (v === undefined || v === null) {
      out += m[0];
      continue;
    }
    const q = quoteAt(expr.slice(0, m.index));
    if (q !== "single" && /[\\$~]\w*$/.test(before)) return null;
    const text = spliced(typeof v === "string" ? v : JSON.stringify(v), q);
    if (text === null) return null;
    out += text;
  }
  return out + expr.slice(from);
}
