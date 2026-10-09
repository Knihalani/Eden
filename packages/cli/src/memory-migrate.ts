/**
 * `eden memory migrate` (EXECUTION §9, X12; A6 §4): the stores written before P0.5, one per Claude session, become
 * `legacy` episodes in the per-repo stores (D1).
 *
 *   eden memory migrate [--dry-run] [--json]   the plan, writing nothing: each session's repo, rows in and out
 *   eden memory migrate --apply [--json]       backup → stage → verify → swap
 *   eden memory migrate --rollback [--json]    the old tree back, keeping what was written since
 *   eden memory migrate --contract [--yes]     30 days after --apply: delete the legacy tree and the backups
 *
 * - **Mapping.** A session directory `<root>/<session>/` (a subagent's `<session>--<agent>/` with it) maps to a repo
 *   through the `cwd` R-7's snapshot (`$EDEN_HOME/migrate/session-map.json`) gives it, else through the first `cwd` of
 *   its transcript (`<claude config>/projects/<project>/<session>.jsonl`). The `cwd` is keyed as the hook keys it
 *   (`repoIdentity`). A session with neither, or whose directory is gone and was in no git repo, is unmappable and
 *   stays in the legacy tree only, as do the rows at the root (`(root)`), written with no session.
 * - **Rows.** Each row of a mapped session (its `memories.jsonl`, and its rows still pending) passes the store's
 *   gate (`scrubMemoryText`: D13's secrets, then identifiers) and loses what instructs (`withoutInstructions`, as
 *   any text the user did not type), then becomes an episode tagged `src:legacy` with the id `legacy:<hash>`: never a
 *   fact, rule, pin or slot (A6 §2.1). A superseded row, a corrupt line and a row left empty are not migrated. A row
 *   keeps its time; one written before rows had times takes its session's first transcript time.
 * - **Gists** stay in the legacy tree: a session gist is sleep's summary of rows that are migrated, and only
 *   SessionStart reads one, which never briefs legacy text (no pins, A6 §4).
 * - **Validity.** The root's `validity.jsonl` applied to every store before P0.5, so each repo receives it. Where a
 *   repo's legacy sessions gave one subject different values, the older values are logged `stale_for` (D31) from the
 *   newest one's time; with no time to order them, every value is, since a miss is better than a stale value (G2).
 * - **Apply.** A tar backup (0600) of the memory root under `$EDEN_HOME/migrate/`; a staged tree beside the root
 *   (`memory.migrate-stage`) with the per-repo layout (`repos/`, `windows/`, `hook.log.d/`) copied and the legacy
 *   rows appended; a check that every row is there once and reads back as a legacy episode; then two renames: the
 *   root to `memory.legacy-v1/` (files made read-only) and the stage to the root. A crash before the swap leaves the
 *   old tree as it was; a hook meeting the gap between the two renames writes nothing (`swapping`), and the next
 *   `--apply` finishes the swap. A second `--apply` changes nothing.
 * - **Rollback.** The legacy tree comes back; every file written or changed since the swap (the manifest lists the
 *   swapped tree's hashes) is carried over without its `legacy:` rows. With nothing written since,
 *   the restored tree is byte for byte the old one.
 *
 * `EDEN_MIGRATE_CRASH_AFTER=<step>` makes `--apply` exit abruptly right after that step (the A5 `migrate` arm).
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { memorySessionName, storeRows } from "../../../src/index";
import { withoutInstructions } from "../../../src/memory-authority";
import { memoryNow } from "../../../src/memory-clock";
import { edenHomeDir } from "../../../src/memory-flags";
import { pendingRows } from "../../../src/memory-ids";
import { isUntyped } from "../../../src/memory-provenance";
import {
  gitPlace,
  legacyTree,
  markStoreFormat,
  migrationStage,
  repoIdentity,
  repoStoreDir,
} from "../../../src/memory-repo";
import { legacySlot } from "../../../src/memory-residual";
import { scrubMemoryText } from "../../../src/memory-scrub";
import { secretHits } from "../../../src/memory-secrets";
import { recordSupersession } from "../../../src/memory-validity";
import { memoryRoot } from "./memory-hook";

export const STEPS = ["backup", "stage", "verify", "swap"] as const;
type Step = (typeof STEPS)[number];

/** The per-repo layout's entries at the root: never legacy, carried into the new tree as they are. */
const CURRENT_LAYOUT = new Set(["repos", "windows", "hook.log.d"]);
const LEGACY_TAG = "src:legacy";
/** How the plan names the root's own `memories.jsonl`. */
const ROOT_STORE = "(root)";
/** EXECUTION §9's verify: how many legacy rows are read back from the new tree. */
const READ_BACK = 50;
const CONTRACT_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

interface Paths {
  root: string;
  legacy: string;
  stage: string;
  migrate: string;
  sessionMap: string;
  projects: string;
}

function pathsOf(root = memoryRoot()): Paths {
  const migrate = join(edenHomeDir(), "migrate");
  return {
    root,
    legacy: legacyTree(root),
    stage: migrationStage(root),
    migrate,
    sessionMap: join(migrate, "session-map.json"),
    projects: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"),
  };
}

/** One legacy session directory, mapped or not. */
export interface SessionPlan {
  session: string;
  repo: string | null;
  via?: "session-map" | "transcript";
  why?: string;
}

/** A legacy row as the new store holds it. */
interface MigratedRow {
  id: string;
  text: string;
  kind: "episode";
  tags: string[];
  ep?: string;
  t?: number;
}

interface RepoPlan {
  rows: MigratedRow[];
  /** Slot values the repo's legacy sessions disagree on: each logged `stale_for` from `t`. */
  stale: { subject: string; value: string; t: number }[];
}

export interface Plan {
  steps: readonly Step[];
  sessions: SessionPlan[];
  unmappable: string[];
  rows: { in: number; out: number; corrupt: number; superseded: number; empty: number; redacted: number };
  stale: number;
  repos: Map<string, RepoPlan>;
}

/** The plan as `--dry-run --json` prints it (the `migrate` arm's contract, plus counts). */
function planJson(plan: Plan): Record<string, unknown> {
  return {
    steps: plan.steps,
    sessions: plan.sessions,
    unmappable: plan.unmappable,
    rows: plan.rows,
    stale: plan.stale,
    repos: [...plan.repos].map(([repo, { rows }]) => ({ repo, rows: rows.length })),
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function parsed(line: string): unknown[] {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
}

function lines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** The legacy session directories: every directory at the root that names a session. */
export function legacySessions(root: string): string[] {
  return subdirs(root).filter((name) => !CURRENT_LAYOUT.has(name) && memorySessionName(name) === name);
}

/** The session a directory belongs to: a subagent's `<session>--<agent>` belongs to `<session>`. */
function parentOf(name: string): string {
  return name.split("--")[0]!;
}

/** A transcript's first `cwd` and first time, read line by line. */
function transcriptStart(path: string): { cwd?: string; t?: number } {
  const out: { cwd?: string; t?: number } = {};
  for (const line of lines(path)) {
    try {
      const entry = JSON.parse(line) as { cwd?: unknown; timestamp?: unknown };
      if (!out.cwd && typeof entry.cwd === "string" && entry.cwd) out.cwd = entry.cwd;
      const t = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (out.t === undefined && Number.isFinite(t)) out.t = t;
      if (out.cwd && out.t !== undefined) break;
    } catch {}
  }
  return out;
}

function transcriptOf(projects: string, session: string): string | undefined {
  for (const project of subdirs(projects)) {
    const path = join(projects, project, `${session}.jsonl`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** Where a session ran and when it started, from R-7's snapshot or its transcript. */
interface SessionOrigin {
  cwd?: string;
  via?: "session-map" | "transcript";
  t?: number;
}

function originOf(paths: Paths, map: Record<string, unknown>, session: string): SessionOrigin {
  const transcript = transcriptOf(paths.projects, session);
  const start = transcript ? transcriptStart(transcript) : {};
  const mapped = map[session];
  if (typeof mapped === "string" && mapped) return { cwd: mapped, via: "session-map", t: start.t };
  return start.cwd ? { cwd: start.cwd, via: "transcript", t: start.t } : {};
}

/** The repo a session's `cwd` belongs to: none when the directory is gone and was in no git repo. */
function repoOfCwd(cwd: string): string | undefined {
  if (!gitPlace(cwd) && !existsSync(cwd)) return undefined;
  return repoIdentity(cwd)?.key;
}

/** A store line: a row with an id and a text, or an `[id, text]` pair; undefined when corrupt. */
function legacyRow(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    const [id, text] = value;
    return typeof id === "string" && typeof text === "string" ? { id, text, kind: "episode" } : undefined;
  }
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  return row && typeof row.id === "string" && typeof row.text === "string" ? row : undefined;
}

function finiteTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function legacyId(session: string, id: string, text: string): string {
  return `legacy:${createHash("sha256").update(`${session}\0${id}\0${text}`).digest("hex").slice(0, 24)}`;
}

/** A legacy text through the store's gate and without instructions (A6 §2.1, §2.3); empty when nothing is left. */
function sanitized(text: string, scrub: { session: string; cwd?: string }): string {
  return withoutInstructions(scrubMemoryText(text, scrub)).replace(/\s+/g, " ").trim();
}

function emptyRepo(): RepoPlan {
  return { rows: [], stale: [] };
}

/**
 * The slot values one repo's legacy rows disagree on (G2), each with the time it is stale from: every value but the
 * newest from the newest one's time; when some value has no time to order it, every value, from `now`.
 */
function staleValues(slots: { subject: string; value: string; t?: number }[], now: number): RepoPlan["stale"] {
  const bySubject = new Map<string, Map<string, { subject: string; value: string; t?: number }>>();
  for (const slot of slots) {
    const values = bySubject.get(slot.subject.toLowerCase()) ?? new Map();
    bySubject.set(slot.subject.toLowerCase(), values);
    const seen = values.get(slot.value.toLowerCase());
    const t = seen === undefined ? slot.t : Math.max(seen.t ?? -Infinity, slot.t ?? -Infinity);
    values.set(slot.value.toLowerCase(), { ...(seen ?? slot), t: Number.isFinite(t) ? t : undefined });
  }
  const stale: RepoPlan["stale"] = [];
  for (const values of bySubject.values()) {
    if (values.size < 2) continue;
    const timed = [...values.values()].sort((a, b) => (b.t ?? -Infinity) - (a.t ?? -Infinity));
    const ordered = timed.every((slot) => slot.t !== undefined) && timed[0]!.t! > timed[1]!.t!;
    const newest = ordered ? timed[0] : undefined;
    for (const slot of timed)
      if (slot !== newest) stale.push({ subject: slot.subject, value: slot.value, t: newest?.t ?? now });
  }
  return stale;
}

/** Reads every legacy store and decides, without writing, where each row goes. */
export function buildPlan(paths: Paths): Plan {
  const map = (readJson(paths.sessionMap) ?? {}) as Record<string, unknown>;
  const plan: Plan = {
    steps: STEPS,
    sessions: [],
    unmappable: [],
    rows: { in: 0, out: 0, corrupt: 0, superseded: 0, empty: 0, redacted: 0 },
    stale: 0,
    repos: new Map(),
  };
  const slots = new Map<string, { subject: string; value: string; t?: number }[]>();
  const pending = new Map<string, unknown[]>();
  for (const { store, row } of pendingRows(paths.root)) pending.set(store, [...(pending.get(store) ?? []), row]);
  for (const name of legacySessions(paths.root)) {
    const session = parentOf(name);
    const origin = originOf(paths, map, session);
    const repo = origin.cwd ? repoOfCwd(origin.cwd) : undefined;
    if (!repo || !origin.cwd) {
      const why = origin.cwd ? "its directory is gone and was in no git repo" : "no session-map entry or transcript";
      plan.sessions.push({ session: name, repo: null, why });
      plan.unmappable.push(name);
      continue;
    }
    plan.sessions.push({ session: name, repo, via: origin.via });
    const target = plan.repos.get(repo) ?? emptyRepo();
    plan.repos.set(repo, target);
    const scrub = { session, cwd: origin.cwd };
    const raw = [...lines(join(paths.root, name, "memories.jsonl")), ...(pending.get(name) ?? [])];
    for (const entry of raw) {
      plan.rows.in++;
      let row: Record<string, unknown> | undefined;
      try {
        row = legacyRow(typeof entry === "string" ? JSON.parse(entry) : entry);
      } catch {}
      if (!row) {
        plan.rows.corrupt++;
        continue;
      }
      if (row.invalid_at !== undefined || row.invalid_by !== undefined) {
        plan.rows.superseded++;
        continue;
      }
      const text = sanitized(String(row.text), scrub);
      if (!text) {
        plan.rows.empty++;
        continue;
      }
      if (secretHits(String(row.text)).length) plan.rows.redacted++;
      const t = finiteTime(row.t) ?? origin.t;
      // A store line without a kind is a fact (`toDisk` leaves the default out).
      const slot = legacySlot({ text: String(row.text), kind: typeof row.kind === "string" ? row.kind : "fact" });
      if (slot) slots.set(repo, [...(slots.get(repo) ?? []), { ...slot, t }]);
      target.rows.push({
        id: legacyId(name, String(row.id), String(row.text)),
        text,
        kind: "episode",
        tags: [LEGACY_TAG],
        ...(typeof row.ep === "string" ? { ep: row.ep } : {}),
        ...(t !== undefined ? { t } : {}),
      });
      plan.rows.out++;
    }
  }
  // The wrap and `eden memory import` wrote rows at the root when they had no session: no session, no repo.
  if (lines(join(paths.root, "memories.jsonl")).length) {
    plan.sessions.push({ session: ROOT_STORE, repo: null, why: "rows written without a session name no repo" });
    plan.unmappable.push(ROOT_STORE);
  }
  const now = memoryNow();
  for (const [repo, list] of slots) {
    const stale = staleValues(list, now);
    plan.repos.get(repo)!.stale.push(...stale);
    plan.stale += stale.length;
  }
  return plan;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function crashPoint(step: Step): void {
  if (process.env.EDEN_MIGRATE_CRASH_AFTER === step) process.exit(137);
}

/** The tar backup of the memory root, owner-only, named by its time (`--contract` reads its age from the name). */
function backup(paths: Paths): string {
  mkdirSync(paths.migrate, { recursive: true, mode: 0o700 });
  const target = join(paths.migrate, `memory-v1-${memoryNow()}.tar`);
  const partial = `${target}.partial`;
  const run = Bun.spawnSync(["tar", "-cf", partial, "-C", dirname(paths.root), basename(paths.root)], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) {
    rmSync(partial, { force: true });
    throw new Error(`backup failed: ${run.stderr.toString().trim()}`);
  }
  chmodSync(partial, 0o600);
  renameSync(partial, target);
  return target;
}

/** The highest seq a repo store's rows or counter holds. */
function lastSeq(dir: string): number {
  const counter = Number(lines(join(dir, "seq"))[0]);
  const rows = storeRows(join(dir, "memories.jsonl")).map((row) => row.seq ?? 0);
  return Math.max(Number.isSafeInteger(counter) ? counter : 0, 0, ...rows);
}

function appendLines(path: string, rows: readonly unknown[]): void {
  if (!rows.length) return;
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const joint = before && !before.endsWith("\n") ? "\n" : "";
  writeFileSync(path, before + joint + rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
}

/** The new tree: the per-repo layout as it is now, each repo's legacy rows and validity appended. */
function stage(paths: Paths, plan: Plan): void {
  rmSync(paths.stage, { recursive: true, force: true });
  mkdirSync(paths.stage, { recursive: true, mode: 0o700 });
  for (const name of CURRENT_LAYOUT)
    if (existsSync(join(paths.root, name)))
      cpSync(join(paths.root, name), join(paths.stage, name), { recursive: true, preserveTimestamps: true });
  const validity = lines(join(paths.root, "validity.jsonl"));
  for (const [repo, target] of plan.repos) {
    const dir = repoStoreDir(paths.stage, repo);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const first = lastSeq(dir) + 1;
    appendLines(
      join(dir, "memories.jsonl"),
      target.rows.map((row, at) => ({ ...row, seq: first + at })),
    );
    if (target.rows.length) writeFileSync(join(dir, "seq"), String(first + target.rows.length - 1), { mode: 0o600 });
    const have = new Set(lines(join(dir, "validity.jsonl")));
    appendLines(join(dir, "validity.jsonl"), validity.filter((line) => !have.has(line)).flatMap(parsed));
    for (const slot of target.stale) recordSupersession(dir, slot, slot.t);
    markStoreFormat(dir);
  }
}

/**
 * EXECUTION §9's verify: every planned legacy row is in its new store exactly once, and the first 50 read back
 * through the store's own reader as the legacy episode planned (same text, untyped, no pin), holding no secret.
 */
function verify(paths: Paths, plan: Plan): string[] {
  const problems: string[] = [];
  let read = 0;
  for (const [repo, target] of plan.repos) {
    const path = join(repoStoreDir(paths.stage, repo), "memories.jsonl");
    const ids = lines(path).flatMap((line) => {
      try {
        return [String((JSON.parse(line) as { id?: unknown }).id)];
      } catch {
        return [];
      }
    });
    const rows = new Map(storeRows(path).map((row) => [row.id, row]));
    for (const planned of target.rows) {
      const count = ids.filter((id) => id === planned.id).length;
      if (count !== 1) problems.push(`${repo}: ${planned.id} is there ${count} times`);
      if (read >= READ_BACK) continue;
      read++;
      const row = rows.get(planned.id);
      const ok =
        row?.text === planned.text &&
        row.kind === "episode" &&
        isUntyped(row) &&
        !row.tags?.includes("pin") &&
        !secretHits(row.text).length;
      if (!ok) problems.push(`${repo}: ${planned.id} does not read back as its legacy episode`);
    }
  }
  return problems;
}

/** What `--rollback` needs: the swapped tree's file hashes and the legacy files' modes, by relative path. */
interface Manifest {
  files: Record<string, string>;
  modes: Record<string, number>;
}

function manifestPath(paths: Paths): string {
  return join(paths.migrate, "applied-v1.json");
}

function writeManifest(paths: Paths): void {
  const manifest: Manifest = { files: {}, modes: {} };
  for (const path of filesUnder(paths.stage)) manifest.files[relative(paths.stage, path)] = sha256(path);
  for (const path of filesUnder(paths.root)) manifest.modes[relative(paths.root, path)] = statSync(path).mode & 0o777;
  writeFileSync(manifestPath(paths), JSON.stringify(manifest) + "\n", { mode: 0o600 });
}

/** The two renames, then the legacy tree's files read-only. */
function swap(paths: Paths): void {
  renameSync(paths.root, paths.legacy);
  finishSwap(paths);
}

function finishSwap(paths: Paths): void {
  renameSync(paths.stage, paths.root);
  for (const path of filesUnder(paths.legacy)) chmodSync(path, 0o400);
}

function say(json: boolean, value: Record<string, unknown>, text: string): void {
  console.log(json ? JSON.stringify(value) : text);
}

function apply(paths: Paths, json: boolean): number {
  if (existsSync(paths.legacy)) {
    if (!existsSync(paths.root) && existsSync(paths.stage)) {
      finishSwap(paths);
      say(json, { applied: true, resumed: true }, "migrate: finished an interrupted swap");
      return 0;
    }
    say(json, { applied: false, why: "already applied" }, `migrate: already applied (${paths.legacy} exists)`);
    return 0;
  }
  const plan = buildPlan(paths);
  if (!plan.sessions.length) {
    say(json, { applied: false, why: "no legacy stores" }, "migrate: no legacy stores to migrate");
    return 0;
  }
  backup(paths);
  crashPoint("backup");
  stage(paths, plan);
  crashPoint("stage");
  const problems = verify(paths, plan);
  if (problems.length) {
    rmSync(paths.stage, { recursive: true, force: true });
    say(json, { applied: false, problems }, `migrate: verify failed, nothing changed:\n  ${problems.join("\n  ")}`);
    return 1;
  }
  crashPoint("verify");
  writeManifest(paths);
  swap(paths);
  crashPoint("swap");
  say(
    json,
    { applied: true, ...planJson(plan) },
    `migrate: ${plan.rows.out} legacy rows in ${plan.repos.size} repos; ` + `the old tree is ${paths.legacy}`,
  );
  return 0;
}

/** A row file's lines without the rows the migration added. */
function withoutLegacy(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      try {
        const id = (JSON.parse(line) as { id?: unknown }).id;
        return !(typeof id === "string" && id.startsWith("legacy:"));
      } catch {
        return true;
      }
    })
    .join("\n");
}

function rollback(paths: Paths, json: boolean): number {
  if (!existsSync(paths.legacy)) {
    say(json, { rolledBack: false, why: "nothing applied" }, "migrate: nothing to roll back");
    return 0;
  }
  const manifest = (readJson(manifestPath(paths)) ?? { files: {}, modes: {} }) as Manifest;
  const restore = `${paths.root}.rollback-stage`;
  rmSync(restore, { recursive: true, force: true });
  cpSync(paths.legacy, restore, { recursive: true, preserveTimestamps: true });
  for (const path of filesUnder(restore)) chmodSync(path, manifest.modes[relative(restore, path)] ?? 0o600);
  let carried = 0;
  for (const path of filesUnder(paths.root)) {
    const rel = relative(paths.root, path);
    if (manifest.files[rel] === sha256(path)) continue;
    const target = join(restore, rel);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const text = readFileSync(path, "utf8");
    writeFileSync(target, /\.jsonl$/.test(rel) ? withoutLegacy(text) : text, { mode: statSync(path).mode & 0o777 });
    carried++;
  }
  const replaced = `${paths.root}.rolled-back`;
  rmSync(replaced, { recursive: true, force: true });
  renameSync(paths.root, replaced);
  renameSync(restore, paths.root);
  rmSync(replaced, { recursive: true, force: true });
  removeLegacy(paths);
  say(
    json,
    { rolledBack: true, carried },
    `migrate: rolled back; ${carried} files written since the swap kept, without legacy rows`,
  );
  return 0;
}

function removeLegacy(paths: Paths): void {
  for (const path of filesUnder(paths.legacy)) chmodSync(path, 0o600);
  rmSync(paths.legacy, { recursive: true, force: true });
  rmSync(manifestPath(paths), { force: true });
}

function backups(paths: Paths): { path: string; t: number }[] {
  try {
    return readdirSync(paths.migrate).flatMap((name) => {
      const t = Number(/^memory-v1-(\d+)\.tar$/.exec(name)?.[1]);
      return Number.isFinite(t) ? [{ path: join(paths.migrate, name), t }] : [];
    });
  } catch {
    return [];
  }
}

/** EXECUTION §9 step 6: at least 30 days after the newest backup, and only when the user confirms (`--yes`). */
function contract(paths: Paths, confirmed: boolean, json: boolean): number {
  const tars = backups(paths);
  const newest = Math.max(0, ...tars.map((tar) => tar.t));
  if (!existsSync(paths.legacy) && !tars.length) {
    say(json, { contracted: false, why: "nothing to delete" }, "migrate: nothing to delete");
    return 0;
  }
  const age = memoryNow() - newest;
  if (newest && age < CONTRACT_AFTER_MS) {
    const days = Math.ceil((CONTRACT_AFTER_MS - age) / 86_400_000);
    say(json, { contracted: false, why: "too soon", days }, `migrate: the backup is kept for ${days} more days`);
    return 1;
  }
  if (!confirmed) {
    const what = [paths.legacy, ...tars.map((tar) => tar.path)].filter((path) => existsSync(path));
    const list = what.join("\n  ");
    say(
      json,
      { contracted: false, why: "unconfirmed", would: what },
      `migrate: run again with --yes to delete:\n  ${list}`,
    );
    return 1;
  }
  removeLegacy(paths);
  for (const tar of tars) rmSync(tar.path, { force: true });
  say(json, { contracted: true }, "migrate: deleted the legacy tree and the backups");
  return 0;
}

function dryRun(paths: Paths, json: boolean): number {
  const plan = buildPlan(paths);
  if (json) console.log(JSON.stringify(planJson(plan)));
  else {
    console.log(`migrate (dry run): ${plan.sessions.length} legacy sessions, ${plan.unmappable.length} unmappable`);
    for (const row of plan.sessions)
      console.log(`  ${row.session} → ${row.repo ? `repos/${row.repo} (${row.via})` : `not migrated: ${row.why}`}`);
    const { rows } = plan;
    console.log(
      `  rows: ${rows.in} in, ${rows.out} out (${rows.corrupt} corrupt, ${rows.superseded} superseded, ` +
        `${rows.empty} empty after the gate; ${rows.redacted} with a secret redacted); ` +
        `${plan.stale} older slot values logged stale`,
    );
  }
  return 0;
}

export function memoryMigrateHelp(): string {
  return `usage: eden memory migrate [--dry-run] [--json]
       eden memory migrate --apply | --rollback [--json]
       eden memory migrate --contract [--yes]

Moves the memory stores written before per-repo memory (one per Claude session) into
the per-repo stores, as earlier-session notes. --dry-run (the default) writes nothing.
`;
}

export function memoryMigrateCli(args: readonly string[]): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(memoryMigrateHelp());
    return 0;
  }
  const json = args.includes("--json");
  const paths = pathsOf();
  try {
    if (args.includes("--apply")) return apply(paths, json);
    if (args.includes("--rollback")) return rollback(paths, json);
    if (args.includes("--contract")) return contract(paths, args.includes("--yes"), json);
    return dryRun(paths, json);
  } catch (err) {
    say(json, { error: (err as Error).message }, `migrate: ${(err as Error).message}`);
    return 1;
  }
}
