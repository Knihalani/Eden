/**
 * Precision-first need detection for silent Know inject. Not a tool.
 *
 * 100% recall on open language is impossible. This names a *typed* need
 * (identifier, technique, wrong-way substitute) or stays silent.
 * Coverage-over-silence: if a grounded query exists, emit it; gold quiet
 * prompts still have no typed parse and stay empty.
 *
 * Wrap inject passes `skipIdent` so the hot path never opens the catalog
 * scanner — frozen RFC/IANA/capital needles cannot ship a wrap card.
 */
import {
  findFilesNeed,
  implicitTechniqueTask,
  jsonWrongWay,
  jsonToolArgs,
  needlesFromText,
  pythonInstallNeed,
  repoSearchNeed,
  techniqueNeedleFromText,
  typescriptRunNeed,
} from "./needles";

export type NeedCall = { name: string; args: string };
export type NeedInput = {
  text: string;
  /** Function/tool names from the request `tools[]` (not descriptions/schemas). */
  tools?: string[];
  /** This-turn or last-assistant tool_calls. */
  calls?: NeedCall[];
};

export type NeedKind = "ident" | "technique" | "wrong" | "stale";
export type NeedHit = {
  silent: boolean;
  kind?: NeedKind;
  queries: string[];
  reasons: string[];
};

export type NeedOpts = {
  /** Skip RFC/IANA/capital ident scan. Wrap inject sets this. */
  skipIdent?: boolean;
};

const GREP = new Set(["grep", "ripgrep", "rg", "grep_search"]);
const LINE = new Set(["cat", "sed", "awk", "head", "tail", "cut", "perl"]);
const SHELL = new Set(["bash", "shell", "run_terminal_cmd", "terminal", "zsh"]);

/**
 * Agent still cites these numbers; inject the successor edge, not the dead title.
 * Hot map only — wrap inject must not open rfc-edges.bin (encoder sidecar).
 */
const STALE_RFC: Record<string, string> = {
  "793": "RFC 9293 obsoletes",
  "821": "RFC 5321 obsoletes",
  "822": "RFC 5322 obsoletes",
  "1738": "RFC 3986 obsoletes",
  "1808": "RFC 3986 obsoletes",
  "2068": "RFC 9110 obsoletes",
  "2246": "RFC 8446 obsoletes",
  "2396": "RFC 3986 obsoletes",
  "2460": "RFC 8200 obsoletes",
  "2616": "RFC 9110 obsoletes",
  "2617": "RFC 7617 obsoletes",
  "2732": "RFC 3986 obsoletes",
  "2818": "RFC 9110 obsoletes",
  "2821": "RFC 5321 obsoletes",
  "2822": "RFC 5322 obsoletes",
  "3280": "RFC 5280 obsoletes",
  "3501": "RFC 9051 obsoletes",
  "4122": "RFC 9562 obsoletes",
  "4346": "RFC 8446 obsoletes",
  "4627": "RFC 8259 obsoletes",
  "5246": "RFC 8446 obsoletes",
  "7158": "RFC 8259 obsoletes",
  "7159": "RFC 8259 obsoletes",
  "7230": "RFC 9110 obsoletes",
  "7231": "RFC 9110 obsoletes",
  "7232": "RFC 9110 obsoletes",
  "7233": "RFC 9110 obsoletes",
  "7234": "RFC 9110 obsoletes",
  "7235": "RFC 9110 obsoletes",
  "7538": "RFC 9110 obsoletes",
  "7540": "RFC 9113 obsoletes",
  "7615": "RFC 9110 obsoletes",
  "7694": "RFC 9110 obsoletes",
  "8740": "RFC 9113 obsoletes",
};

const STALE_DEST = new Set<string>();
for (const q of Object.values(STALE_RFC)) {
  const m = /^RFC\s+(\d{1,5})\b/i.exec(q);
  if (m) STALE_DEST.add(m[1]!);
}

export function isHotStaleRfc(n: string): boolean {
  return Object.prototype.hasOwnProperty.call(STALE_RFC, n);
}

export function hotStaleQuery(n: string): string | undefined {
  return STALE_RFC[n];
}

/** Current successor named by the hot stale map. Skip pack search for these. */
export function isHotSuccessorRfc(n: string): boolean {
  return STALE_DEST.has(n);
}

export function toolNameSet(tools?: string[]): Set<string> {
  const out = new Set<string>();
  for (const n of tools ?? []) {
    const t = n.trim().toLowerCase();
    if (t) out.add(t);
  }
  return out;
}

/** Holdout / gold quiet: imperative coding with no typed identifier. */
export function judgmentOnly(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 8) return !t;
  if (techniqueNeedleFromText(t)) return false;
  if (needlesFromText(t).length) return false;
  return /^(please\s+)?(refactor|rewrite|clean up|fix the types|add a log line)\b/i.test(t);
}

function grepish(name: string): boolean {
  const n = name.toLowerCase();
  return GREP.has(n) || LINE.has(n) || SHELL.has(n);
}

function staleRfcQueries(text: string): string[] {
  const out: string[] = [];
  const re = /\bRFC[\s#:-]*(\d{1,5})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const q = STALE_RFC[m[1]!];
    if (q && !out.includes(q)) out.push(q);
  }
  return out;
}

/**
 * Detect whether this request could use a Know card, and which queries to try.
 * Queries are ordered: wrong-way / technique before catalog, so jq beats IANA json.
 */
export function detectNeed(input: NeedInput, opts?: NeedOpts): NeedHit {
  const text = (input.text || "").slice(0, 16_000);
  const reasons: string[] = [];
  const queries: string[] = [];
  const add = (q: string, reason: string) => {
    if (!q || queries.some((x) => x.toLowerCase() === q.toLowerCase())) return;
    queries.push(q);
    reasons.push(reason);
  };

  if (!text.trim() && !input.calls?.length) {
    return { silent: true, queries: [], reasons: ["empty"] };
  }

  const calls = input.calls ?? [];

  for (const q of staleRfcQueries(text)) add(q, "stale");

  const wrongCall = calls.some((c) => grepish(c.name) && jsonToolArgs(c.args));
  if (wrongCall || jsonWrongWay(text)) {
    add("used for JSON", "wrong");
  }
  if (pythonInstallNeed(text)) {
    add("used for Python", "wrong");
  }
  if (typescriptRunNeed(text)) {
    add("used for TypeScript", "wrong");
  }
  if (findFilesNeed(text)) {
    add("used for files", "wrong");
  }
  if (repoSearchNeed(text)) {
    add("used for searching", "wrong");
    add("used for repo", "wrong");
  }

  const implicit = implicitTechniqueTask(text);
  if (implicit) add(`used for ${implicit}`, "technique");
  const tech = techniqueNeedleFromText(text);
  if (tech) add(tech, "technique");

  if (!opts?.skipIdent) {
    for (const q of needlesFromText(text)) add(q, "ident");
  }

  if (!queries.length) {
    if (opts?.skipIdent) return { silent: true, queries: [], reasons: ["no-parse"] };
    return { silent: true, queries: [], reasons: judgmentOnly(text) ? ["judgment"] : ["no-parse"] };
  }
  const kind: NeedKind = reasons.includes("stale")
    ? "stale"
    : reasons.includes("wrong")
      ? "wrong"
      : reasons.includes("technique")
        ? "technique"
        : "ident";
  return { silent: false, kind, queries, reasons };
}
