/**
 * The `migrate` arm (A5 §4; EXECUTION §9, X12; A6 §4). The memory root starts as the pre-P0.5 stores of
 * `fixtures/legacy-v1.json`: a normal session, a session from a worktree of the same repo, one whose transcript is
 * gone (mapped through R-7's `~/.eden/migrate/session-map.json`), a corrupt last line, 5 secret shapes and a 2 KB
 * paste. Then:
 * - `--dry-run` reports every session mapped to the one repo and writes nothing;
 * - `--apply` twice is a byte no-op the second time;
 * - `--rollback` restores the old memory tree byte for byte;
 * - a crash after any step leaves the old state or the new one, never a mix;
 * - no planted secret is left in the new store (the read-only legacy tree and the backup keep the old bytes);
 * - legacy rows are episodes only: the legacy "Never merge PRs yourself" is never a pin or a guard;
 * - legacy facts from both worktrees reach a later session in the main checkout.
 *
 * The arm drives the entry point EXECUTION §9 names, with three details it fixes so a run can be checked:
 *
 *   eden memory migrate --dry-run --json   →  {"steps": [name…], "sessions": [{"session", "repo"}…], "unmappable": […]}
 *   eden memory migrate --apply | --rollback
 *   EDEN_MIGRATE_CRASH_AFTER=<step>         →  the --apply process exits abruptly right after that step
 *
 * Until a slice provides it, every check fails with the reason.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { listFiles } from "../harness/metrics";
import { Rng } from "../harness/rng";
import type { SessionPlace, SimWorld } from "../harness/session";
import type { WorldSpec } from "../harness/world";
import type { LegacyFixture } from "./fixtures/make-legacy-v1";
import { AUTH, DB, id, monorepo } from "./fixtures/world";
import { bash, check, Driver, jsonOut, metricsOf, needMet, type Arm, type ArmRun, type Check } from "./kit";
import { SHAPES } from "./secrets";

const FIXTURE = join(import.meta.dir, "fixtures", "legacy-v1.json");
const CHECKS = [
  "dry-run",
  "apply-idempotent",
  "rollback-identical",
  "crash-safe",
  "secret-bytes",
  "legacy-not-pinned",
  "mapped",
];

export interface MigrateReport {
  steps: string[];
  sessions: { session: string; repo: string | null }[];
  unmappable: string[];
}

export function readReport(value: unknown): MigrateReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { steps, sessions, unmappable } = value as Partial<MigrateReport>;
  const ok =
    Array.isArray(steps) &&
    steps.every((step) => typeof step === "string") &&
    Array.isArray(sessions) &&
    sessions.every((row) => typeof row?.session === "string") &&
    Array.isArray(unmappable);
  return ok ? { steps, sessions, unmappable } : undefined;
}

/** Fresh synthetic values for the fixture's secret placeholders. */
function legacySecrets(): Map<string, string> {
  const rng = new Rng(97);
  return new Map(SHAPES.map((shape) => [shape.name, shape.value(rng)]));
}

/** Writes the legacy stores, their transcripts' first lines and R-7's session map into the world's home. */
function plant(world: SimWorld, worktree: SessionPlace, fixture: LegacyFixture, secrets: Map<string, string>): void {
  const eden = join(world.home, ".eden");
  rmSync(eden, { recursive: true, force: true });
  for (const [path, text] of Object.entries(fixture.files)) {
    const filled = text
      .replace(/\{\{SECRET:([a-z-]+)\}\}/g, (_, shape: string) => secrets.get(shape)!)
      .replace(/\{\{SECRET_LOWER:([a-z-]+)\}\}/g, (_, shape: string) => secrets.get(shape)!.toLowerCase());
    mkdirSync(dirname(join(eden, "memory", path)), { recursive: true });
    writeFileSync(join(eden, "memory", path), filled);
  }
  const map: Record<string, string> = {};
  for (const session of fixture.sessions) {
    const place = session.place === "worktree" ? worktree : world.mainCheckout;
    map[session.id] = place.cwd;
    if (!session.transcript) continue;
    const path = world.transcriptPath(session.id, place.cwd);
    const transcript = world.transcript(path, session.id, undefined, place);
    transcript.userPrompt("legacy session", { promptId: session.id, permissionMode: "default" }, "typed");
    transcript.flush();
  }
  mkdirSync(join(eden, "migrate"), { recursive: true });
  writeFileSync(join(eden, "migrate", "session-map.json"), JSON.stringify(map, null, 2));
}

/** Every file under `dir` with its sha256, by relative path; `skip` drops logs and backups. */
function snapshot(dir: string, skip: (path: string) => boolean = () => false): Map<string, string> {
  return new Map(
    listFiles(dir)
      .map((path) => relative(dir, path))
      .filter((path) => !skip(path))
      .sort()
      .map((path) => [path, createHash("sha256").update(readFileSync(join(dir, path))).digest("hex")]),
  );
}

/** Wide events and backups may change between runs; the store may not. */
const LOGS_AND_BACKUPS = (path: string) => path.includes("hook.log.d/") || /\.tar(\.gz)?$/.test(path);

function same(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([path, hash]) => b.get(path) === hash);
}

function differences(a: Map<string, string>, b: Map<string, string>): string {
  const paths = [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path));
  return paths.length ? `${paths.length} files differ, e.g. ${paths.slice(0, 3).join(", ")}` : "identical";
}

export const migrate: Arm = {
  id: "migrate",
  flagged: false,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const worktree = world.addWorktree(".claude/worktrees/agent-x", "agent-x");
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as LegacyFixture;
    const secrets = legacySecrets();
    const eden = join(world.home, ".eden");
    const fresh = () => plant(world, worktree, fixture, secrets);
    fresh();
    const original = snapshot(join(eden, "memory"));
    const report = readReport(jsonOut(run.cli(world, ["memory", "migrate", "--dry-run", "--json"])));
    if (!report) {
      const missing = "`eden memory migrate --dry-run --json` gave no report in the contract's shape";
      return CHECKS.map((name) => check(name, false, missing));
    }
    return migrationChecks(run, world, spec, { fixture, secrets, eden, original, report, fresh });
  },
};

interface Migration {
  fixture: LegacyFixture;
  secrets: Map<string, string>;
  eden: string;
  original: Map<string, string>;
  report: MigrateReport;
  fresh: () => void;
}

async function migrationChecks(run: ArmRun, world: SimWorld, spec: WorldSpec, m: Migration): Promise<Check[]> {
  const memory = join(m.eden, "memory");
  const migrateCli = (flag: string, env: Record<string, string> = {}) =>
    run.cli(world, ["memory", "migrate", flag], "", env);
  const repos = new Set(m.report.sessions.map((row) => row.repo));
  const mappedAll = m.fixture.sessions.every((session) =>
    m.report.sessions.some((row) => row.session === session.id && row.repo !== null),
  );
  const dryRun = check(
    "dry-run",
    mappedAll && repos.size === 1 && same(m.original, snapshot(memory)),
    `${m.report.sessions.length} sessions in ${repos.size} repos; all mapped: ${mappedAll}; tree ${differences(m.original, snapshot(memory))}`,
  );

  migrateCli("--apply");
  const applied = snapshot(m.eden, LOGS_AND_BACKUPS);
  migrateCli("--apply");
  const again = snapshot(m.eden, LOGS_AND_BACKUPS);
  migrateCli("--rollback");
  const rolledBack = snapshot(memory);
  const crashes = m.report.steps.map((step) => {
    m.fresh();
    migrateCli("--apply", { EDEN_MIGRATE_CRASH_AFTER: step });
    const state = snapshot(m.eden, LOGS_AND_BACKUPS);
    const old = same(snapshot(memory), m.original) && ![...state.keys()].some((path) => path.startsWith("memory.legacy"));
    return { step, ok: old || same(state, applied) };
  });
  m.fresh();
  migrateCli("--apply");

  const values = [...m.secrets.values()].flatMap((value) => [value, value.toLowerCase()]);
  const newStore = listFiles(m.eden).filter((path) => !/memory\.legacy|\.tar(\.gz)?$/.test(relative(m.eden, path)));
  const leaks = newStore.filter((path) => values.some((value) => readFileSync(path, "utf8").includes(value)));

  const session = await Driver.start(world, spec);
  const start = world.deliveries.filter((delivery) => delivery.event === "SessionStart").map((d) => d.content);
  const db = await session.ask("what database do we use?", { needs: [id(DB, "")] });
  const auth = await session.ask("which auth provider do we use?", { needs: [id(AUTH, "")] });
  await session.turn("the PR is approved, wrap it up", { tools: [[bash("gh pr merge 42 --squash")]] });
  await session.end();
  const asks = world.log
    .filter((record) => record.event === "PreToolUse")
    .flatMap((record) => record.invocations)
    .filter((call) => call.outcome.permissionDecision === "ask");
  const pinned = start.filter((text) => /never merge prs yourself/i.test(text));
  const metrics = metricsOf(world, spec);
  const failedCrashes = crashes.filter((crash) => !crash.ok).map((crash) => crash.step);
  return [
    dryRun,
    check("apply-idempotent", same(applied, again), `second --apply: ${differences(applied, again)}`),
    check("rollback-identical", same(rolledBack, m.original), `after --rollback: ${differences(m.original, rolledBack)}`),
    check(
      "crash-safe",
      crashes.length > 0 && failedCrashes.length === 0,
      `${crashes.length} steps; a mixed state after: ${failedCrashes.join(", ") || "none"}`,
    ),
    check("secret-bytes", leaks.length === 0, `${leaks.length} new-store files hold a planted secret`),
    check(
      "legacy-not-pinned",
      pinned.length === 0 && asks.length === 0,
      `SessionStart packets with the legacy rule: ${pinned.length}; asks on gh pr merge: ${asks.length}`,
    ),
    check("mapped", needMet(metrics, db) && needMet(metrics, auth), `db ${needMet(metrics, db)}, auth (worktree) ${needMet(metrics, auth)}`),
  ];
}
