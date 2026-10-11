/**
 * What PostToolBatch records in the window's `ctx.log` (A4 §3.3, §5.5): one record for the whole batch, so parallel
 * tool calls never race on the window's files (R0 F11).
 *
 * - `paths`: the files and folders the calls named (`file_path`, `path`, `notebook_path`; a Bash `cd` target).
 * - `exit`: each Bash call's exit code, from the `Exit code N` that opens a failed result's text; 0 without one.
 * - `sig`: D10's error signature of each failed result: its first error line, with paths, hashes, numbers and
 *   line:col normalized, so the same error in another file or run has the same signature.
 */

/** A record line stays under 4 KB (`memory-window.ts`): long lists are cut. */
const MAX_ITEMS = 8;
const MAX_SIGNATURE = 160;

export interface BatchRecord {
  prompt_id?: string;
  paths: string[];
  exit: number[];
  sig: string[];
}

type Call = { tool_name?: unknown; tool_input?: unknown; tool_response?: unknown };

const PATH_FIELDS = ["file_path", "path", "notebook_path"] as const;
const EXIT_CODE = /^Exit code (\d+)\b/;
const ERROR_LINE = /\b(?:error|failed|failure|exception|cannot|could not|not found|denied|ERR_[A-Z_]+)\b/i;

/** A result's text as the model sees it: a string, or its text blocks. */
export function resultText(response: unknown): string {
  if (typeof response === "string") return response;
  if (!Array.isArray(response)) return "";
  return response
    .map((block) => (block as { text?: unknown })?.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function inputOf(call: Call): Record<string, unknown> {
  const input = call.tool_input;
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** The paths a call names; a Bash command's `cd` target counts (D4: a Bash path). */
function pathsOf(call: Call): string[] {
  const input = inputOf(call);
  const named = PATH_FIELDS.flatMap((field) => {
    const path = input[field];
    return typeof path === "string" && path ? [path] : [];
  });
  const cd = typeof input.command === "string" ? /(?:^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|\S+)/.exec(input.command) : null;
  return cd ? [...named, cd[1]!.replace(/^["']|["']$/g, "")] : named;
}

/** D10: the first error line, with paths, hashes, line:col and numbers normalized. */
export function errorSignature(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => !EXIT_CODE.test(part) && ERROR_LINE.test(part));
  if (!line) return undefined;
  return line
    .replace(/(?:[A-Za-z]:)?(?:[\w.@~-]*\/)+[\w.@-]+/g, "<path>")
    .replace(/\b[0-9a-f]{7,64}\b/gi, "<hash>")
    .replace(/:\d+(?::\d+)?\b/g, ":<loc>")
    .replace(/\b\d+(?:\.\d+)*\b/g, "<n>")
    .slice(0, MAX_SIGNATURE);
}

/** The batch's record (see the header) from a PostToolBatch payload's `tool_calls`. */
export function batchRecord(payload: Record<string, unknown>): BatchRecord {
  const calls = (Array.isArray(payload.tool_calls) ? payload.tool_calls : []) as Call[];
  const paths: string[] = [];
  const exit: number[] = [];
  const sig: string[] = [];
  for (const call of calls) {
    paths.push(...pathsOf(call));
    const text = resultText(call.tool_response);
    const code = EXIT_CODE.exec(text.trimStart());
    if (call.tool_name === "Bash") exit.push(code ? Number(code[1]) : 0);
    const signature = code && code[1] !== "0" ? errorSignature(text) : undefined;
    if (signature) sig.push(signature);
  }
  const promptId = typeof payload.prompt_id === "string" && payload.prompt_id ? payload.prompt_id : undefined;
  return {
    ...(promptId ? { prompt_id: promptId } : {}),
    paths: [...new Set(paths)].slice(0, MAX_ITEMS).map((path) => path.slice(0, 200)),
    exit: exit.slice(0, MAX_ITEMS),
    sig: [...new Set(sig)].slice(0, MAX_ITEMS),
  };
}
