/** Shared setup for the harness self-tests: temporary run directories and the probe plugin. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin } from "./runner";
import { SimWorld, type WorldOptions } from "./session";

/** Records every hook payload; answers as PROBE_MODE says (fixtures/probe-plugin/record.sh). */
export const PROBE_PLUGIN = join(import.meta.dir, "fixtures", "probe-plugin");

const made: string[] = [];

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  made.push(dir);
  return dir;
}

/** Removes every directory `tempDir` made; call from `afterAll`. */
export function removeTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface Recorded {
  pid: number;
  /** Exactly what the process read on stdin. */
  raw: string;
  payload: Record<string, unknown>;
  /** cwd, CLAUDE_PLUGIN_ROOT, CLAUDE_PROJECT_DIR, HOME, EDEN_HOME, EDEN_MEMORY_DIR, as the process saw them. */
  env: string[];
  /** The names of every environment variable the process saw, sorted. */
  envNames: string[];
  /** The transcript as it was when the hook ran (PROBE_SNAPSHOT=1). */
  transcript?: string;
}

export interface Probe {
  world: SimWorld;
  out: string;
  recorded(): Recorded[];
}

export function probeWorld(
  options: Partial<Omit<WorldOptions, "runDir" | "plugin">> & { mode?: string; snapshot?: boolean } = {},
): Probe {
  const { mode, snapshot, ...rest } = options;
  const runDir = tempDir("eden-harness");
  const out = join(runDir, "probe");
  mkdirSync(out);
  const env: Record<string, string> = { PROBE_OUT: out, PROBE_MODE: mode ?? "silent", ...rest.env };
  if (snapshot) env.PROBE_SNAPSHOT = "1";
  const world = new SimWorld({ seed: 7, ...rest, runDir, plugin: loadPlugin(PROBE_PLUGIN), env });
  return { world, out, recorded: () => readRecorded(out) };
}

function readRecorded(out: string): Recorded[] {
  return readdirSync(out)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const pid = Number(name.slice(0, -".json".length));
      const raw = readFileSync(join(out, name), "utf8");
      const snapshot = join(out, `${pid}.transcript`);
      return {
        pid,
        raw,
        payload: JSON.parse(raw) as Record<string, unknown>,
        env: readFileSync(join(out, `${pid}.env`), "utf8")
          .split("\n")
          .slice(0, 6),
        envNames: readFileSync(join(out, `${pid}.envnames`), "utf8")
          .split("\n")
          .filter(Boolean),
        transcript: existsSync(snapshot) ? readFileSync(snapshot, "utf8") : undefined,
      };
    });
}

/** Every line of a JSONL file, parsed. */
export function readLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
