import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { minifyCli, stripAnsi } from "./densify";
import { compactReceipt, modelFacing } from "./compact";
import {
  extractLoopIds,
  fulfillArgv,
  isMutatingGh,
  parseIssueList,
  planFromBash,
} from "./plan";

/** ~300 tokens. Overflow goes to the vault. */
export const TOKEN_SLA_BYTES = 1200;

export type RewriteKind = "none" | "jq" | "parallel" | "play" | "cache" | "fulfill";

export type Rewrite = {
  command: string;
  changed: boolean;
  kind: RewriteKind;
};

export function jqForGhPath(path: string): string | null {
  const p = path.split("?")[0].replace(/\/$/, "");
  if (/\/graphql$/.test(p)) return null;
  if (/\/(files|comments)$/.test(p) || /\/reviews$/.test(p)) return "length";
  if (/\/status$/.test(p) || /\/check-runs$/.test(p) || /\/check-suites$/.test(p)) {
    return "{state:.state,total_count:.total_count}";
  }
  if (/\/pulls\/[^/]+$/.test(p) || /\/issues\/[^/]+$/.test(p)) {
    return "{number:.number,title:.title,state:.state,sha:.head.sha,login:.user.login}";
  }
  if (/\/pulls$/.test(p) || /\/issues$/.test(p)) return "[.[]|{number,title,state}]";
  return "{number:.number,title:.title,state:.state,name:.name,sha:.sha,message:.message}";
}

function addJqToCommand(command: string): string {
  if (isMutatingGh(command)) return command;
  return command.replace(/\bgh\s+api\s+([^\n;&]+)/g, (full, rest: string) => {
    if (/\s--jq\b|\s-q\b/.test(full)) return full;
    if (isMutatingGh(full)) return full;
    if (/>/.test(full) || /\$\(/.test(full)) return full;
    const tokens = rest.trim().split(/\s+/);
    const path = tokens.find((t) => t && !t.startsWith("-"));
    if (!path || path === "graphql") return full;
    if (/[\$"'{}]/.test(path)) return full;
    if (!/^repos\//.test(path) && !/^https:\/\/api\.github\.com\//.test(path)) return full;
    const expr = jqForGhPath(path);
    if (!expr) return full;
    const flags = tokens.filter((t) => t !== path).join(" ");
    return flags ? `gh api ${path} ${flags} --jq '${expr}'` : `gh api ${path} --jq '${expr}'`;
  });
}

function splitIndependentGh(body: string): string[] | null {
  if (/\$\(|`/.test(body)) return null;
  const parts = body
    .split(/\n|;/)
    .map((l) => l.trim().replace(/;\s*$/, ""))
    .filter((l) => l && l !== ":");
  if (parts.length < 2) return null;
  if (!parts.every((p) => /\bgh\s+api\b/.test(p) && />/.test(p) && !isMutatingGh(p))) return null;
  return parts;
}

function maybeInnerParallel(body: string): string {
  const parts = splitIndependentGh(body);
  if (!parts) return body;
  return parts.map((p) => `( ${p} ) &`).join(" ") + " wait";
}

/** Parallelize independent GitHub GETs without interleaving stdout. */
export function rewriteForLoop(command: string): string | null {
  const m = command.match(/for\s+([A-Za-z_]\w*)\s+in\s+([\d\s]+)[;\n]\s*do\b([\s\S]*?)\bdone\b/);
  if (!m) return null;
  const varName = m[1];
  const ids = m[2].trim().split(/\s+/).filter((n) => /^\d+$/.test(n));
  const body = m[3];
  if (ids.length < 2) return null;
  if (!/\bgh\s+api\b/.test(body) && !/\bcurl\s+.*api\.github\.com/.test(body)) return null;
  if (isMutatingGh(body)) return null;
  if (/&/.test(body)) return null;
  const trimmedBody = body.trim().replace(/;\s*$/, "");
  const inner = maybeInnerParallel(trimmedBody);
  const loop = [
    `_e=/tmp/eden-par-$$`,
    `mkdir -p "$_e"`,
    `for ${varName} in ${ids.join(" ")}; do`,
    `  ( ${inner} ) > "$_e/$${varName}" 2>&1 &`,
    `done`,
    `wait`,
    `for ${varName} in ${ids.join(" ")}; do cat "$_e/$${varName}"; done`,
    `rm -rf "$_e"`,
  ].join("\n");
  return command.replace(m[0], () => loop);
}

function parallelizeSequentialGh(command: string): string | null {
  if (command.includes("&")) return null;
  const lines = command
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const gh = lines.filter((l) => /\bgh\s+api\b/.test(l) && !isMutatingGh(l));
  if (gh.length < 2) return null;
  if (gh.length !== lines.length) return null;
  if (gh.every((l) => />/.test(l))) {
    return gh.map((l) => `( ${l} ) &`).join("\n") + "\nwait";
  }
  return [
    `_e=/tmp/eden-par-$$`,
    `mkdir -p "$_e"`,
    ...gh.map((l, i) => `( ${l} ) > "$_e/${i}" 2>&1 &`),
    `wait`,
    `cat ${gh.map((_, i) => `"$_e/${i}"`).join(" ")}`,
    `rm -rf "$_e"`,
  ].join("\n");
}

export function rewriteBash(
  command: string,
  opts?: {
    playFor?: (kind: "bundle" | "files", issues: string[]) => string | null;
    fulfillBin?: string;
  },
): Rewrite {
  const trimmed = command.trim();
  if (!trimmed || isMutatingGh(trimmed)) return { command, changed: false, kind: "none" };

  const ids = extractLoopIds(trimmed);
  const body = trimmed.match(/for\s+\w+\s+in\s+[\d\s]+[;\n]\s*do\b([\s\S]*?)\bdone\b/)?.[1] || trimmed;
  if (opts?.playFor && ids.length >= 2 && /\bgh\s+api\b/.test(body) && !/>/.test(body)) {
    const cmds: string[] = [];
    if (/\/reviews|\/status|\/pulls\//.test(body)) {
      const play = opts.playFor("bundle", ids);
      if (play) cmds.push(play);
    }
    if (/\/files/.test(body)) {
      const play = opts.playFor("files", ids);
      if (play) cmds.push(play);
    }
    if (cmds.length) return { command: cmds.join("\n"), changed: true, kind: "play" };
  }

  if (opts?.fulfillBin) {
    const plan = planFromBash(trimmed);
    if (plan) {
      const argv = fulfillArgv(plan, opts.fulfillBin);
      const loopRe = /for\s+\w+\s+in\s+[\d\s]+[;\n]\s*do\b[\s\S]*?\bdone\b/g;
      const loops = trimmed.match(loopRe);
      if (loops?.length) {
        let i = 0;
        const next = trimmed.replace(loopRe, () => (i++ === 0 ? argv : ":"));
        return { command: next, changed: true, kind: "fulfill" };
      }
      return { command: argv, changed: true, kind: "fulfill" };
    }
  }

  const looped = rewriteForLoop(trimmed);
  if (looped && looped !== trimmed) return { command: looped, changed: true, kind: "parallel" };

  const seq = parallelizeSequentialGh(trimmed);
  if (seq) return { command: seq, changed: true, kind: "parallel" };

  return { command, changed: false, kind: "none" };
}

function edenHome(): string {
  return process.env.EDEN_HOME || join(homedir(), ".eden");
}

export function vaultDir(): string {
  return join(edenHome(), "vault");
}

export function prefetchDir(): string {
  return join(edenHome(), "prefetch");
}

export function putVault(text: string): string {
  const id = crypto.randomUUID().slice(0, 8);
  mkdirSync(vaultDir(), { recursive: true });
  writeFileSync(join(vaultDir(), id), text);
  return id;
}

export function getVault(id: string): string | null {
  const p = join(vaultDir(), id.replace(/[^a-zA-Z0-9_-]/g, ""));
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

export function prefetchPath(ghPath: string): string {
  const safe = ghPath.replace(/[^\w./-]/g, "_").replace(/\.\./g, "");
  return join(prefetchDir(), `${safe}.txt`);
}

export function writePrefetch(ghPath: string, facts: string): void {
  const p = prefetchPath(ghPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, facts);
}

export function readPrefetch(ghPath: string): string | null {
  const p = prefetchPath(ghPath);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

export function vaultPointer(id: string, preview: string, bytes: number): string {
  const head = preview.replace(/\s+/g, " ").slice(0, 160);
  return `${head}\n(truncated ${bytes}B)`;
}

function tryJson(text: string): unknown | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function splitJsonValues(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{" || c === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          /* skip */
        }
        start = -1;
      }
    }
  }
  return out;
}

function factsLine(value: unknown): string {
  const facing = modelFacing(value);
  const line = compactReceipt(facing.facts);
  return line.length <= TOKEN_SLA_BYTES ? line : facing.text.slice(0, TOKEN_SLA_BYTES);
}

function compactTestOutput(text: string): string | null {
  const pass = text.match(/(\d+)\s+pass/);
  const fail = text.match(/(\d+)\s+fail/);
  if (!pass && !fail) return null;
  if (!/\b(bun test|npm test|pnpm test|vitest|Ran \d+ tests)\b/i.test(text) && !pass) return null;
  const failN = Number(fail?.[1] || 0);
  const passN = Number(pass?.[1] || 0);
  const ms = text.match(/\[(\d+(?:\.\d+)?)ms\]/);
  const summary = `test: ${passN} pass / ${failN} fail${ms ? ` / ${ms[1]}ms` : ""}`;
  if (failN > 0) {
    const tail = minifyCli(text).split("\n").slice(-30).join("\n");
    return `${summary}\n${tail}`.slice(0, TOKEN_SLA_BYTES * 2);
  }
  return summary;
}

function compactGit(command: string, text: string): string | null {
  if (/\bgit\s+log\b/.test(command)) {
    const lines = text.trim().split("\n").filter(Boolean);
    return `git log: ${lines.length} commits, latest ${lines[0]?.slice(0, 90) ?? ""}`;
  }
  if (/\bgit\s+status\b/.test(command)) {
    const branch = text.match(/On branch (\S+)/);
    const dirty = /Changes not staged|Untracked files|Changes to be committed/.test(text);
    return `git status: ${branch?.[1] ?? "?"} ${dirty ? "dirty" : "clean"}`;
  }
  return null;
}

function compactLs(command: string, text: string): string | null {
  if (!/(^|\s|\||;)ls(\s|$)/.test(command)) return null;
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length <= 24) return null;
  return `ls: ${lines.length} entries\n${lines.slice(0, 12).join("\n")}\n…`;
}

export function compactStdout(command: string, stdout: string, maxBytes = TOKEN_SLA_BYTES): { stdout: string; vaulted: boolean } {
  const stripped = stripAnsi(stdout);
  if (!stripped.trim()) return { stdout: stripped, vaulted: false };
  if (/\s--jq\b|\s-q\b/.test(command) || /\bfulfill\b/.test(command) || /\bplay\b/.test(command)) {
    return { stdout: stripped, vaulted: false };
  }
  // Live GitHub JSON must keep head.sha and other fields the model already asked for.
  if (/\bgh\s+api\b/.test(command) || /\bcurl\s+.*api\.github\.com/.test(command)) {
    return { stdout: stripped, vaulted: false };
  }

  const test = compactTestOutput(stripped);
  if (test) return { stdout: test, vaulted: false };

  const json = tryJson(stripped);
  if (json !== undefined) {
    if (stripped.length <= maxBytes) return { stdout: stripped, vaulted: false };
    return { stdout: factsLine(json), vaulted: false };
  }

  const many = splitJsonValues(stripped);
  if (many.length >= 2) {
    const table = many.map((v) => factsLine(v)).join("\n");
    return { stdout: table.length <= maxBytes * 4 ? table : table.slice(0, maxBytes * 4), vaulted: false };
  }

  const mini = minifyCli(stripped);
  if (mini.length <= maxBytes) return { stdout: mini, vaulted: false };
  return { stdout: mini.slice(0, maxBytes), vaulted: false };
}

export function compactReadOutput(filePath: string, content: string, maxBytes = TOKEN_SLA_BYTES): { stdout: string; vaulted: boolean } {
  const keep = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|md|json)$/i.test(filePath);
  if (keep && content.length < 2_000_000) return { stdout: content, vaulted: false };
  const json = tryJson(content);
  if (json !== undefined) return compactStdout("cat", content, maxBytes);
  if (content.length <= maxBytes * 4) return { stdout: content, vaulted: false };
  const lines = content.split("\n");
  const head = lines.slice(0, 40).join("\n");
  return {
    stdout: `${head}\n… ${lines.length} lines, ${content.length}B`,
    vaulted: false,
  };
}

export function receiptTableLine(issue: string, facts: unknown): string {
  const line = compactReceipt(facts);
  if (line.startsWith(`${issue} |`)) return line;
  if (/^\d+ \|/.test(line)) return line;
  return `${issue} | ${line}`;
}

export function issuesFromParams(params: Record<string, string>): string[] {
  const listed = parseIssueList(params.issues || params.issue || params.pr || params.number);
  return listed;
}
