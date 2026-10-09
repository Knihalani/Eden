/**
 * Delivery-point flags (EXECUTION X7): one per point, `off | shadow | on`, read from files on every event, so a file
 * edit is a kill switch from the next event (an environment variable is not: hooks inherit the environment Claude
 * Code started with).
 *
 * - **Sources, by precedence:** the environment (`EDEN_FLAG_DELIVER_SUBMIT`, …; `guard.ask` is `EDEN_POLICY_GUARD`),
 *   the repo file `<repo>/.eden/flags.json`, the user file `$EDEN_HOME/flags.json`, then the point's default. Both
 *   files map a flag name to its value: `{"deliver.submit": "shadow"}`.
 * - **Default** (no source sets the flag): what the point does today. UserPromptSubmit and SessionStart delivered
 *   before flags existed, so they stay `on` until a stage writes otherwise; the points not built yet are `shadow`,
 *   and `guard.ask` `off`.
 * - **Unknown values** (a source sets a value that is none of the three) resolve to `off`, or `shadow` for
 *   `deliver.submit`.
 * - **Circuit breaker:** `$EDEN_HOME/flags.auto.json` (`memory-breaker.ts`) forces an `on` point to `shadow` until
 *   its time passes. It never raises a point.
 * - **Lifecycle:** a release flag carries the date by which it is removed (a test fails once it passes); the kill
 *   switches (`guard.ask`, and the master `EDEN_MEMORY`, which `memory-consent.ts` reads) have none.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { memoryNow } from "./memory-clock";
import { gitPlace, mainCheckout } from "./memory-repo";

export type FlagMode = "off" | "shadow" | "on";

export const FLAG_MODES: readonly FlagMode[] = ["off", "shadow", "on"];

interface FlagSpec {
  env: string;
  default: FlagMode;
  unknown: FlagMode;
  /** A release flag's removal date (yyyy-mm-dd); none for a kill switch. */
  removeBy?: string;
}

const RELEASE_FLAGS_REMOVED_BY = "2027-06-30";

export const FLAGS = {
  "deliver.submit": {
    env: "EDEN_FLAG_DELIVER_SUBMIT",
    default: "on",
    unknown: "shadow",
    removeBy: RELEASE_FLAGS_REMOVED_BY,
  },
  "deliver.session_start": {
    env: "EDEN_FLAG_DELIVER_SESSION_START",
    default: "on",
    unknown: "off",
    removeBy: RELEASE_FLAGS_REMOVED_BY,
  },
  "deliver.subagent": {
    env: "EDEN_FLAG_DELIVER_SUBAGENT",
    default: "shadow",
    unknown: "off",
    removeBy: RELEASE_FLAGS_REMOVED_BY,
  },
  "deliver.batch": {
    env: "EDEN_FLAG_DELIVER_BATCH",
    default: "shadow",
    unknown: "off",
    removeBy: RELEASE_FLAGS_REMOVED_BY,
  },
  "deliver.failure": {
    env: "EDEN_FLAG_DELIVER_FAILURE",
    default: "shadow",
    unknown: "off",
    removeBy: RELEASE_FLAGS_REMOVED_BY,
  },
  "guard.context": {
    env: "EDEN_FLAG_GUARD_CONTEXT",
    default: "shadow",
    unknown: "off",
    removeBy: RELEASE_FLAGS_REMOVED_BY,
  },
  "guard.ask": { env: "EDEN_POLICY_GUARD", default: "off", unknown: "off" },
} as const satisfies Record<string, FlagSpec>;

export type Flag = keyof typeof FLAGS;

export const FLAG_NAMES = Object.keys(FLAGS) as Flag[];

/** Where a flag's mode came from. */
export type FlagSource = "env" | "repo" | "user" | "default" | "breaker";

export interface ResolvedFlag {
  mode: FlagMode;
  source: FlagSource;
  /** The value as a source wrote it, when it was none of the three modes. */
  unknown?: string;
}

export type FlagState = Record<Flag, ResolvedFlag>;

/** One forced point in `flags.auto.json` (written by `memory-breaker.ts`). */
export interface BreakerEntry {
  mode: "shadow";
  /** Epoch ms when it was forced, and until when it holds. */
  since: number;
  until: number;
  cause: string;
  /** Whether a SessionStart has told the user. */
  announced: boolean;
}

export type BreakerFile = Partial<Record<Flag, BreakerEntry>>;

export function edenHomeDir(): string {
  return process.env.EDEN_HOME || join(homedir(), ".eden");
}

export function userFlagsPath(home = edenHomeDir()): string {
  return join(home, "flags.json");
}

export function breakerPath(home = edenHomeDir()): string {
  return join(home, "flags.auto.json");
}

/**
 * The checkout whose `.eden/flags.json` applies to `cwd`: the main checkout of its repo, so every linked worktree
 * reads one repo file (D1 keys the store by the common git dir); a submodule is its own. No git process.
 */
export function repoTop(cwd: string | undefined): string | undefined {
  const place = gitPlace(cwd);
  return place && mainCheckout(place);
}

export function repoFlagsPath(top: string): string {
  return join(top, ".eden", "flags.json");
}

function readObject(path: string | undefined): Record<string, unknown> {
  if (!path) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseMode(raw: unknown): FlagMode | undefined {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  return FLAG_MODES.find((mode) => mode === value);
}

/** The breaker's forced points that still hold at `now`. */
export function readBreaker(path = breakerPath(), now = memoryNow()): BreakerFile {
  const out: BreakerFile = {};
  for (const [flag, raw] of Object.entries(readObject(path))) {
    const entry = raw as Partial<BreakerEntry> | null;
    if (!(flag in FLAGS) || !entry || typeof entry.until !== "number" || entry.until <= now) continue;
    out[flag as Flag] = {
      mode: "shadow",
      since: typeof entry.since === "number" ? entry.since : 0,
      until: entry.until,
      cause: typeof entry.cause === "string" ? entry.cause : "",
      announced: entry.announced === true,
    };
  }
  return out;
}

/** Every flag's mode for an event in `cwd` (see the header). Never throws: an unreadable file sets nothing. */
export function resolveFlags(cwd?: string, env: NodeJS.ProcessEnv = process.env): FlagState {
  const home = env.EDEN_HOME || join(homedir(), ".eden");
  const top = repoTop(cwd);
  const repoPath = top ? repoFlagsPath(top) : undefined;
  const layers: [FlagSource, Record<string, unknown>][] = [
    ["repo", readObject(repoPath)],
    ["user", readObject(userFlagsPath(home))],
  ];
  const breaker = readBreaker(breakerPath(home));
  const state = {} as FlagState;
  for (const flag of FLAG_NAMES) {
    const spec: FlagSpec = FLAGS[flag];
    const set: [FlagSource, unknown] | undefined =
      env[spec.env] !== undefined && env[spec.env] !== ""
        ? ["env", env[spec.env]]
        : layers.flatMap(([source, file]): [FlagSource, unknown][] => (flag in file ? [[source, file[flag]]] : []))[0];
    let resolved: ResolvedFlag = { mode: spec.default, source: "default" };
    if (set) {
      const mode = parseMode(set[1]);
      resolved = mode ? { mode, source: set[0] } : { mode: spec.unknown, source: set[0], unknown: String(set[1]) };
    }
    if (resolved.mode === "on" && breaker[flag]) resolved = { mode: "shadow", source: "breaker" };
    state[flag] = resolved;
  }
  return state;
}

/** The delivery point an event serves, or undefined for an event that delivers nothing (Stop, PostToolUse, …). */
export function pointOf(event: string): Flag | undefined {
  if (event === "UserPromptSubmit") return "deliver.submit";
  if (event === "SessionStart") return "deliver.session_start";
  return undefined;
}

/** Each flag's mode alone, for a wide event. */
export function flagModes(state: FlagState): Record<Flag, FlagMode> {
  return Object.fromEntries(FLAG_NAMES.map((flag) => [flag, state[flag].mode])) as Record<Flag, FlagMode>;
}
