/**
 * Test-process-only clock skew for the flake-audit harness.
 *
 * Production code is unchanged. This module is loaded via `bun --preload`
 * solely during `scripts/flake-audit.sh` runs.
 *
 * Env:
 *   EDEN_FLAKE_CLOCK_OFFSET_MS  — constant offset applied to both clocks
 *                                 (may be negative). Default 0.
 *   EDEN_FLAKE_CLOCK_SCALE      — scale elapsed time since preload by this
 *                                 factor. Default 1.0.
 *
 * Both `Date.now` and `performance.now` are patched the same way so a test
 * that pins one clock origin against a literal "now" (the old guard-budget
 * pattern) fails unless both ends are controlled. Wall timers
 * (`setTimeout`, `Bun.sleep`, `AbortSignal.timeout`) stay on real time —
 * only the readable clocks move.
 */

const offsetMs = Number(process.env.EDEN_FLAKE_CLOCK_OFFSET_MS ?? "0");
const scale = Number(process.env.EDEN_FLAKE_CLOCK_SCALE ?? "1");
const safeOffset = Number.isFinite(offsetMs) ? offsetMs : 0;
const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

const realDateNow = Date.now.bind(Date);
const realPerfNow = performance.now.bind(performance);
const dateOrigin = realDateNow();
const perfOrigin = realPerfNow();

function skewedDate(): number {
  return dateOrigin + safeOffset + (realDateNow() - dateOrigin) * safeScale;
}

function skewedPerf(): number {
  return perfOrigin + safeOffset + (realPerfNow() - perfOrigin) * safeScale;
}

Date.now = skewedDate;
performance.now = skewedPerf;

// `new Date()` with no args should see the skewed clock. Constructing from
// an explicit value / string keeps the real Date semantics.
const OrigDate = Date;
function FlakeDate(this: Date | void, ...args: unknown[]): string | Date {
  if (new.target === undefined) {
    // Bare `Date()` → string, same as native.
    return OrigDate();
  }
  if (args.length === 0) {
    return Reflect.construct(OrigDate, [skewedDate()], new.target) as Date;
  }
  return Reflect.construct(OrigDate, args, new.target) as Date;
}
FlakeDate.parse = OrigDate.parse.bind(OrigDate);
FlakeDate.UTC = OrigDate.UTC.bind(OrigDate);
FlakeDate.now = skewedDate;
Object.defineProperty(FlakeDate, "prototype", {
  value: OrigDate.prototype,
  writable: false,
});
Object.setPrototypeOf(FlakeDate, OrigDate);
(globalThis as { Date: DateConstructor }).Date = FlakeDate as unknown as DateConstructor;

if (process.env.EDEN_FLAKE_CLOCK_VERBOSE === "1") {
  console.error(
    `[flake-clock] offset_ms=${safeOffset} scale=${safeScale} date.now=${Date.now()} perf.now=${performance.now()}`,
  );
}
