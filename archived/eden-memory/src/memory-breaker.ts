/**
 * The circuit breaker (EXECUTION §5 "Fail-open contract"). A delivery point that exceeds its budget over its last 200
 * invocations (wide events) is forced from `on` to `shadow` for 24 h, through `$EDEN_HOME/flags.auto.json`. The
 * budget: unhandled exceptions ≤ 0.1% and budget aborts ≤ 0.5% of the 200, so one exception trips it, and two
 * aborts do. A rate only rises at an exception or an abort, so the hook checks only then.
 *
 * The next SessionStart tells the user once (`takeNotice`); `eden doctor` shows every forced point while it holds.
 * Turning a point back on early is a stage evaluation's call (`/next stages`), never the hook's.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { breakerPath, readBreaker, type BreakerEntry, type Flag, type FlagState } from "./memory-flags";
import { recentEvents } from "./memory-events";

export const BREAKER_WINDOW = 200;
export const BREAKER_BUDGET = { err: 0.001, aborted: 0.005 } as const;
export const BREAKER_HOLD_MS = 24 * 60 * 60 * 1000;

const POINT_NAMES: Partial<Record<Flag, string>> = {
  "deliver.submit": "UserPromptSubmit",
  "deliver.session_start": "SessionStart",
};

/** Why the point's last 200 invocations exceed the budget, or undefined when they do not. */
export function overBudget(root: string, point: Flag): string | undefined {
  const events = recentEvents(root, point, BREAKER_WINDOW);
  const errors = events.filter((event) => event.err).length;
  const aborts = events.filter((event) => event.aborted).length;
  const over: string[] = [];
  if (errors / BREAKER_WINDOW > BREAKER_BUDGET.err) over.push(`${errors} unhandled exception${errors > 1 ? "s" : ""}`);
  if (aborts / BREAKER_WINDOW > BREAKER_BUDGET.aborted) over.push(`${aborts} budget aborts`);
  return over.length ? `${over.join(" and ")} in its last ${BREAKER_WINDOW} invocations` : undefined;
}

function writeBreaker(path: string, entries: Partial<Record<Flag, BreakerEntry>>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * After an exception or an abort at an `on` point: forces the point to `shadow` when its budget is exceeded. Returns
 * the entry written, if any.
 */
export function tripIfOverBudget(
  root: string,
  point: Flag,
  flags: FlagState,
  now: number,
  path = breakerPath(),
): BreakerEntry | undefined {
  if (flags[point].mode !== "on") return undefined;
  const cause = overBudget(root, point);
  if (!cause) return undefined;
  const entry: BreakerEntry = { mode: "shadow", since: now, until: now + BREAKER_HOLD_MS, cause, announced: false };
  writeBreaker(path, { ...readBreaker(path, now), [point]: entry });
  return entry;
}

/** The user-facing line for a forced point. */
export function breakerLine(point: Flag, entry: BreakerEntry): string {
  const until = new Date(entry.until).toISOString().replace(/\.\d+Z$/, "Z");
  return `${POINT_NAMES[point] ?? point} delivery (${point}) is in shadow mode until ${until}: ${entry.cause}`;
}

/** The notice for points forced since the last SessionStart told the user, marking them told. */
export function takeNotice(now: number, path = breakerPath()): string | undefined {
  const entries = readBreaker(path, now);
  const fresh = (Object.entries(entries) as [Flag, BreakerEntry][]).filter(([, entry]) => !entry.announced);
  if (!fresh.length) return undefined;
  for (const [point] of fresh) entries[point] = { ...entries[point]!, announced: true };
  writeBreaker(path, entries);
  const lines = fresh.map(([point, entry]) => breakerLine(point, entry));
  return `Eden memory circuit breaker: ${lines.join("; ")}. See eden doctor.`;
}
