/**
 * M32.3 remain-silent **measure** (count only).
 *
 * Classify wrap inject packets as empty vs junk vs on-cue, then map JSONL
 * lines onto Harbor trials by timestamp windows. **Do not omit the packet** —
 * that gate is M38. Silent inject stays always-on this wave.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cueFor, MEMORY_MARK } from "../../src/index.ts";

export { MEMORY_MARK };

export const HERE = import.meta.dir;
export const INJECT_LOG_ENV = "EDEN_MEMORY_INJECT_LOG";
/** Same location as `injectLogPath` in run.ts (M32.1). */
export const INJECT_LOG_DIR = join(HERE, ".data");

/** Task-ish tokens for the locked TB 2.1 subset (openssl / regex-log). */
export const TB_TASK_TOKENS = new Set([
  "openssl",
  "cert",
  "certificate",
  "tls",
  "ssl",
  "regex",
  "log",
  "fingerprint",
]);

/** Leftover store identity — on an openssl/regex cue these are junk, not help. */
export const TB_LEFTOVER_TOKENS = new Set([
  "sqlite",
  "clerk",
  "postgres",
  "postgresql",
  "circleci",
  "diet",
]);

const STOP = new Set([
  "eden", "memory", "this", "that", "with", "from", "have", "been", "will", "your", "task",
  "please", "using", "into", "file", "files", "create", "created", "make", "made", "about",
  "they", "them", "then", "than", "when", "what", "which", "would", "could", "should",
  "must", "just", "also", "only", "some", "more", "most", "other", "after", "before",
  "command", "commands", "linux", "output", "description", "assistant", "environment",
  "current", "terminal", "script", "python", "simple", "internal", "following",
  "requirements", "ensure", "proper", "save", "valid", "details", "including", "checks",
  "company", "server", "directory", "store", "print", "prints", "verify", "write",
  "written", "provide", "provided", "given", "used", "uses", "user", "name", "type",
  "true", "false", "null", "json", "text", "line", "lines", "next", "step", "steps",
  "need", "needs", "needed", "want", "based", "state", "still", "done", "goal",
  "format", "structure", "response", "analysis", "plan", "duration", "exactly",
  "complete", "completed", "successful", "verification", "exists", "loaded",
  "self", "signed", "selfsigned", "notes", "note", "fact", "rule", "episode", "gist",
]);

export type InjectLogLine = {
  t: number;
  arm?: string;
  empty: boolean;
  n_notes: number;
  junk: boolean;
  cue: string;
  packet: string;
};

export type InjectClassification = {
  empty: boolean;
  junk: boolean;
  n_notes: number;
  cue: string;
  packet: string;
};

export type SilenceCount = {
  n_trials: number;
  empty: number;
  junk: number;
  on_cue: number;
  no_inject: number;
  n_injects: number;
};

export type TrialClass = "empty" | "junk" | "on_cue" | "no_inject";

export type CountSilenceOpts = {
  logPath: string;
  jobDir: string | null;
  tasks?: string[];
  /** When the JSONL mixes arms, keep only this arm. */
  arm?: string;
};

export type SilenceNotesOpts = {
  date: string;
  offJob: string | null;
  onJob: string | null;
  tasks?: string[];
  accuracy_pp?: number | null;
  offLog?: string;
  onLog?: string;
};

type TrialWindow = {
  trial: string;
  task: string;
  t0: number | null;
  t1: number | null;
};

export function defaultInjectLogPath(arm: "off" | "on"): string {
  return join(INJECT_LOG_DIR, `inject-${arm}.jsonl`);
}

/** Contentful tokens: task-ish shorts kept; leftover identity kept; boilerplate dropped. */
export function contentfulTokens(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const raw = text.toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2");
  for (const t of raw.split(/[^a-z0-9]+/)) {
    if (!t) continue;
    if (TB_TASK_TOKENS.has(t) || TB_LEFTOVER_TOKENS.has(t)) {
      out.add(t);
      continue;
    }
    if (t.length < 4) continue;
    if (STOP.has(t)) continue;
    if (t.startsWith("cert")) out.add("cert");
    out.add(t);
  }
  return out;
}

export function notesBody(packet: string): string {
  if (!packet) return "";
  const i = packet.indexOf(MEMORY_MARK);
  return i < 0 ? packet : packet.slice(i + MEMORY_MARK.length);
}

export function countNotes(packet: string): number {
  if (!packet.includes(MEMORY_MARK)) return 0;
  return notesBody(packet)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .length;
}

/**
 * junk = packet present AND notes do not share contentful tokens with this-turn cue.
 * Leftover sqlite/Clerk/postgres/CircleCI/diet on an openssl cue is junk.
 */
export function packetIsJunk(packet: string, cue: string): boolean {
  if (!packet.includes(MEMORY_MARK)) return false;
  const notes = contentfulTokens(notesBody(packet));
  const cueTok = contentfulTokens(cue);
  const sharedTask = [...notes].some((t) => TB_TASK_TOKENS.has(t) && cueTok.has(t));
  if (sharedTask) return false;
  const leftoverOnTaskCue =
    [...notes].some((t) => TB_LEFTOVER_TOKENS.has(t)) &&
    [...cueTok].some((t) => TB_TASK_TOKENS.has(t));
  if (leftoverOnTaskCue) return true;
  for (const t of notes) {
    if (cueTok.has(t) && !TB_LEFTOVER_TOKENS.has(t)) return false;
  }
  return true;
}

function asBody(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function walkMarkText(v: unknown, out: string[], depth = 0): void {
  if (out.length > 32 || depth > 6) return;
  if (typeof v === "string") {
    if (v.includes(MEMORY_MARK)) out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) walkMarkText(x, out, depth + 1);
    return;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["content", "text", "system", "systemInstruction", "system_instruction", "system_prompt", "systemPrompt"]) {
      if (k in o) walkMarkText(o[k], out, depth + 1);
    }
    if (Array.isArray(o.messages)) walkMarkText(o.messages, out, depth + 1);
    if (Array.isArray(o.contents)) walkMarkText(o.contents, out, depth + 1);
    if (Array.isArray(o.parts)) walkMarkText(o.parts, out, depth + 1);
  }
}

export function packetFromBody(body: unknown): string {
  const out: string[] = [];
  walkMarkText(body, out);
  return out.join("\n");
}

export function cueFromBody(body: unknown): string {
  const o = asBody(body);
  const list = Array.isArray(o.messages) ? o.messages : Array.isArray(o.contents) ? o.contents : [];
  try {
    return cueFor(list);
  } catch {
    return "";
  }
}

/**
 * empty = injected body has no MEMORY_MARK (packet omitted vs original).
 * junk = packet present and notes share no contentful tokens with the cue.
 */
export function classifyInject(opts: {
  original?: unknown;
  injected?: unknown;
  cue?: string;
  packet?: string;
}): InjectClassification {
  const packet = opts.packet ?? packetFromBody(opts.injected ?? opts.original ?? {});
  const cue = opts.cue ?? cueFromBody(opts.original ?? opts.injected ?? {});
  const empty = !packet.includes(MEMORY_MARK);
  const n_notes = empty ? 0 : countNotes(packet);
  const junk = empty ? false : packetIsJunk(packet, cue);
  return { empty, junk, n_notes, cue, packet };
}

export function classifyLogLine(line: InjectLogLine): InjectClassification {
  const classified = classifyInject({ cue: line.cue, packet: line.packet });
  if (line.packet || line.cue) return classified;
  return {
    empty: Boolean(line.empty),
    junk: Boolean(line.junk) && !line.empty,
    n_notes: Number(line.n_notes) || 0,
    cue: line.cue || "",
    packet: line.packet || "",
  };
}

/** Priority: on_cue > junk > empty. No mapped lines → no_inject (not empty-packet). */
export function classifyTrial(injects: InjectLogLine[]): TrialClass {
  if (!injects.length) return "no_inject";
  let anyOnCue = false;
  let anyJunk = false;
  let anyEmpty = false;
  for (const row of injects) {
    const c = classifyLogLine(row);
    if (c.empty) {
      anyEmpty = true;
      continue;
    }
    if (c.junk) anyJunk = true;
    else anyOnCue = true;
  }
  if (anyOnCue) return "on_cue";
  if (anyJunk) return "junk";
  if (anyEmpty) return "empty";
  return "empty";
}

export function parseInjectLog(logPath: string, arm?: string): InjectLogLine[] {
  if (!logPath || !existsSync(logPath)) return [];
  let raw = "";
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const out: InjectLogLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const j = JSON.parse(t) as Partial<InjectLogLine>;
      if (typeof j.t !== "number" || !Number.isFinite(j.t)) continue;
      if (arm && j.arm && j.arm !== arm) continue;
      const row: InjectLogLine = {
        t: j.t,
        empty: Boolean(j.empty),
        n_notes: Number(j.n_notes) || 0,
        junk: Boolean(j.junk),
        cue: typeof j.cue === "string" ? j.cue : "",
        packet: typeof j.packet === "string" ? j.packet : "",
      };
      if (typeof j.arm === "string" && j.arm) row.arm = j.arm;
      out.push(row);
    } catch {
      /* torn JSONL skipped */
    }
  }
  return out;
}

function parseTime(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : Math.round(v * 1000);
  if (typeof v !== "string" || !v.trim()) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function trajectoryWindow(dir: string): { t0: number; t1: number } | null {
  const paths = [join(dir, "agent", "trajectory.json"), join(dir, "trajectory.json")];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const j = readJson(p);
    const steps = Array.isArray(j?.steps) ? j!.steps : [];
    const times: number[] = [];
    for (const s of steps) {
      if (!s || typeof s !== "object") continue;
      const t = parseTime((s as { timestamp?: unknown }).timestamp);
      if (t != null) times.push(t);
    }
    if (!times.length) continue;
    return { t0: Math.min(...times), t1: Math.max(...times) };
  }
  return null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function trialWindowOf(dir: string): { t0: number | null; t1: number | null } {
  const result = readJson(join(dir, "result.json"));
  const ae = rec(result?.agent_execution);
  let t0 = parseTime(ae?.started_at) ?? parseTime(result?.started_at);
  let t1 = parseTime(ae?.finished_at) ?? parseTime(result?.finished_at);
  if (t0 == null || t1 == null) {
    const traj = trajectoryWindow(dir);
    if (traj) {
      t0 = t0 ?? traj.t0;
      t1 = t1 ?? traj.t1;
    }
  }
  if (t0 == null || t1 == null) {
    const cfg = readJson(join(dir, "config.json"));
    t0 = t0 ?? parseTime(cfg?.started_at);
    t1 = t1 ?? parseTime(cfg?.finished_at);
  }
  return { t0, t1 };
}

function taskMatch(task: string, trial: string, tasks?: string[]): boolean {
  if (!tasks?.length) return true;
  return tasks.some((want) => {
    const leaf = want.split("/").pop() || want;
    return (
      task === want ||
      task.endsWith(want) ||
      task.includes(leaf) ||
      trial.startsWith(leaf) ||
      trial.includes(leaf)
    );
  });
}

export function listTrialWindows(jobDir: string, tasks?: string[]): TrialWindow[] {
  if (!jobDir || !existsSync(jobDir)) return [];
  let kids: string[] = [];
  try {
    kids = readdirSync(jobDir)
      .map((n) => join(jobDir, n))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
  const out: TrialWindow[] = [];
  for (const dir of kids) {
    const result = readJson(join(dir, "result.json"));
    const trial = String(result?.trial_name ?? result?.trial_id ?? dir.split("/").pop() ?? "");
    const task = String(result?.task_name ?? result?.task ?? "");
    if (!trial) continue;
    if (!existsSync(join(dir, "result.json")) && !existsSync(join(dir, "config.json"))) continue;
    if (!taskMatch(task, trial, tasks)) continue;
    const w = trialWindowOf(dir);
    out.push({ trial, task, t0: w.t0, t1: w.t1 });
  }
  const dated = out.filter((x) => x.t0 != null).sort((a, b) => (a.t0 ?? 0) - (b.t0 ?? 0));
  for (let i = 0; i < dated.length; i++) {
    const cur = dated[i]!;
    if (cur.t1 != null) continue;
    const nxt = dated[i + 1];
    cur.t1 = nxt?.t0 != null ? nxt.t0 - 1 : (cur.t0 ?? 0) + 86_400_000;
  }
  return out;
}

const SKEW_MS = 2_000;

function inWindow(t: number, w: TrialWindow): boolean {
  if (w.t0 == null || w.t1 == null) return false;
  return t >= w.t0 - SKEW_MS && t <= w.t1 + SKEW_MS;
}

/**
 * Map wrap inject JSONL onto Harbor trials (concurrency 1).
 * A trial with no wrap injects (tmux died before first chat) is `no_inject`, not empty-packet.
 */
export function countSilence(opts: CountSilenceOpts): SilenceCount {
  const lines = parseInjectLog(opts.logPath, opts.arm);
  const windows = opts.jobDir ? listTrialWindows(opts.jobDir, opts.tasks) : [];
  const used = new Set<number>();
  const tallies: SilenceCount = {
    n_trials: windows.length,
    empty: 0,
    junk: 0,
    on_cue: 0,
    no_inject: 0,
    n_injects: lines.length,
  };
  if (!opts.jobDir) return tallies;
  for (const w of windows) {
    const mapped: InjectLogLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      const row = lines[i]!;
      if (!inWindow(row.t, w)) continue;
      mapped.push(row);
      used.add(i);
    }
    const cls = classifyTrial(mapped);
    tallies[cls]++;
  }
  return tallies;
}

function fmtCount(c: SilenceCount): string {
  return `| ${c.n_trials} | ${c.empty} | ${c.junk} | ${c.on_cue} | ${c.no_inject} | ${c.n_injects} |`;
}

/**
 * `## Remain-silent measure` block for RESULTS.md.
 * If always-on (on-arm) has junk>0 or lost Δ, this is **evidence for M38**, not a WIN.
 */
export function silenceNotes(opts: SilenceNotesOpts): string {
  try {
    const offLog = opts.offLog || defaultInjectLogPath("off");
    const onLog = opts.onLog || defaultInjectLogPath("on");
    const off = countSilence({ logPath: offLog, jobDir: opts.offJob, tasks: opts.tasks, arm: "off" });
    const on = countSilence({ logPath: onLog, jobDir: opts.onJob, tasks: opts.tasks, arm: "on" });
    const lines: string[] = [];
    lines.push("## Remain-silent measure");
    lines.push("");
    lines.push(
      `Dated ${opts.date}. Count of Harbor trials whose wrap inject packet was **empty** vs **junk** vs on-cue. Harbor trajectories do not contain \`${MEMORY_MARK.trim()}\` — counts come from wrap \`${INJECT_LOG_ENV}\` JSONL. **Do not implement the omit gate here** — that is M38. Silent inject stays always-on; this wave only measures.`,
    );
    lines.push("");
    lines.push("| arm | n_trials | empty | junk | on_cue | no_inject | n_injects |");
    lines.push("|---|---|---|---|---|---|---|");
    lines.push(`| off (EDEN_MEMORY=0) ${fmtCount(off)}`);
    lines.push(`| on (inject) ${fmtCount(on)}`);
    lines.push("");
    lines.push(
      "empty = no `Eden Memory:` packet (off-arm identity, or on-arm with nothing to inject). junk = packet present and notes share no contentful tokens with this-turn cue (leftover sqlite/Clerk/postgres/CircleCI/diet on an openssl cue). no_inject = trial had no wrap chat (tmux died before first inject) — not an empty packet.",
    );
    const lost = opts.accuracy_pp != null && opts.accuracy_pp < 0;
    if (on.junk > 0 || lost) {
      lines.push("");
      const bits: string[] = [];
      if (on.junk > 0) bits.push(`on-arm junk=${on.junk} (always-on packet was off-cue)`);
      if (lost) bits.push("always-on lost vs off (Δ accuracy negative)");
      lines.push(
        `${bits.join("; ")}. Always-on inject that cannot help **hurts**. This is **evidence for M38**, not a WIN.`,
      );
    }
    lines.push("");
    return lines.join("\n");
  } catch {
    return `## Remain-silent measure\n\nDated ${opts.date}. Count unavailable (fail-open). Omit gate is M38; not implemented here.\n`;
  }
}
