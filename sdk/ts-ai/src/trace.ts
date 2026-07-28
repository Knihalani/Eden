/**
 * Eden TypeScript runtime SDK — `trace()` and `traceAgent()`.
 *
 * Mirrors the Python SDK's `trace_agent` decorator and `trace()`
 * context manager:
 *
 *   - `traceAgent(options)` — class-method decorator (TS equivalent of
 *     Python's `@trace_agent(...)`).
 *   - `trace(name, options?)` — returns a TraceController you can use
 *     as a context manager (`using` / `await using` / manual `.end()`)
 *     OR pass a callback to the legacy `traceFn` form. The controller
 *     mirrors Python's Span: `.setInput() / .setOutput() / .setTag() /
 *     .setStatus() / .end()`.
 *
 * Tracing never breaks the wrapped function. All errors from the
 * telemetry path are caught and logged at debug level.
 */

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { getDefaultClient } from "./client.js";
import { SOURCE_FORMATS, type TraceOptions } from "./types.js";

/**
 * Public trace context — same shape as the Python SDK's `Span` (the
 * Python SDK's `trace()` now yields a Span, not a TraceContext, so
 * the two SDKs are aligned).
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  /** Set by `.end()`. While the trace is open this is `null`. */
  endMs: number | null;
  /** Span name (used as `event_type` on the wire). */
  name: string;
  /** Tags added via `.setTag()`. */
  tags: string[];
  /** Input attached via `.setInput()`. */
  input: unknown;
  /** Output attached via `.setOutput()`. */
  output: unknown;
  /** Status attached via `.setStatus()`. */
  status: "ok" | "error" | "unset" | null;
  /** Error attached via `.setStatus("error", { error })`. */
  error: string | null;

  /** Mutate the trace — chainable. */
  setInput(value: unknown): TraceContext;
  setOutput(value: unknown): TraceContext;
  setTag(...tags: string[]): TraceContext;
  setStatus(
    status: "ok" | "error" | "unset",
    opts?: { error?: string },
  ): TraceContext;
  /** Mark the trace as errored with a thrown error. */
  recordError(err: unknown): TraceContext;
  /** Close the trace and emit the framework event. Idempotent. */
  end(opts?: { status?: "ok" | "error" | "unset"; error?: string }): void;
}

/**
 * Legacy form: `await trace("name", async (ctx) => { ... })`.
 * Kept for backwards compatibility — internally it just builds a
 * TraceController, runs the callback, then ends the trace.
 */
export async function trace<T>(
  name: string,
  fn: (ctx: TraceContext) => Promise<T>,
  opts?: TraceOptions,
): Promise<T>;
/**
 * Context-manager form (preferred):
 *   ```ts
 *   using t = trace("name");
 *   t.setInput({ q: "hi" });
 *   const out = doWork();
 *   t.setOutput(out).end();
 *   ```
 */
export function trace(name: string, opts?: TraceOptions): TraceContext;
export function trace<T>(
  name: string,
  fnOrOpts?: ((ctx: TraceContext) => Promise<T>) | TraceOptions,
  maybeOpts?: TraceOptions,
): unknown {
  // Legacy callback form: `await trace("name", async (ctx) => ...)`.
  if (typeof fnOrOpts === "function") {
    const opts = maybeOpts ?? {};
    const fn = fnOrOpts as (ctx: TraceContext) => Promise<T>;
    return _traceCallback(name, fn, opts);
  }
  // Context-manager form.
  return _traceControllerManual(name, fnOrOpts ?? {});
}

// ── Implementation ──────────────────────────────────────────────────

/** Imperative span handle returned by ``trace(name)`` (also used by docs). */
export class TraceController implements TraceContext {
  public readonly traceId: string;
  public readonly spanId: string;
  public readonly parentSpanId?: string;
  public readonly startMs: number;
  public endMs: number | null = null;
  public readonly name: string;
  public readonly tags: string[] = [];
  public input: unknown = undefined;
  public output: unknown = undefined;
  public status: "ok" | "error" | "unset" | null = null;
  public error: string | null = null;
  private readonly options: TraceOptions;
  private ended = false;
  // Set only by the imperative (context-manager) form -- see
  // ``_traceControllerManual``. Marks that this controller was
  // pushed onto ``_manualStack`` and must be popped on ``.end()``.
  // Not ``private`` -- ``_traceControllerManual`` (a module-level
  // function, not a class method) needs to set it.
  _onManualStack = false;

  constructor(name: string, options: TraceOptions, parent?: TraceContext) {
    this.name = name;
    this.options = options;
    this.startMs = Date.now();
    this.traceId = parent?.traceId ?? randomUUID().slice(0, 24);
    this.spanId = randomUUID().slice(0, 16);
    this.parentSpanId = parent?.spanId;
    // Pre-seed tags from the config + options.
    const client = getDefaultClient();
    const cfg = client.getConfig();
    this.tags.push(...(cfg.tags ?? []), ...(options.tags ?? []));
  }

  setInput(value: unknown): this {
    this.input = value;
    return this;
  }
  setOutput(value: unknown): this {
    this.output = value;
    return this;
  }
  setTag(...tags: string[]): this {
    for (const t of tags) {
      if (t && !this.tags.includes(t)) this.tags.push(t);
    }
    return this;
  }
  setStatus(
    status: "ok" | "error" | "unset",
    opts: { error?: string } = {},
  ): this {
    this.status = status;
    if (opts.error !== undefined) this.error = opts.error;
    return this;
  }
  recordError(err: unknown): this {
    this.status = "error";
    if (err instanceof Error) {
      // Match the Python SDK's ``repr(exc)`` shape so the
      // error_message split in ``finishTrace`` populates
      // both ``error_type`` and ``error_message`` on the
      // wire. (Python's repr: ``TypeError('boom')`` /
      // ``TypeError('boom', 'extra')`` -- we use the
      // ``ClassName: message`` form for parity.)
      this.error = `${err.constructor.name}: ${err.message}`;
    } else if (err === null) {
      this.error = "null";
    } else if (err === undefined) {
      this.error = "undefined";
    } else if (typeof err === "object") {
      // ``String({code: "X"})`` returns ``"[object Object]"``
      // and silently drops the payload. Try ``JSON.stringify``
      // first; fall back to the constructor name when the
      // value isn't serialisable (e.g. circular refs).
      try {
        const json = JSON.stringify(err);
        this.error = json === undefined ? Object.prototype.toString.call(err) : json;
      } catch {
        this.error = Object.prototype.toString.call(err);
      }
    } else {
      // Primitives (string, number, boolean, bigint, symbol)
      // stringify cleanly.
      this.error = String(err);
    }
    return this;
  }
  end(opts: { status?: "ok" | "error" | "unset"; error?: string } = {}): void {
    if (this.ended) return;
    this.ended = true;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.error !== undefined) this.error = opts.error;
    this.endMs = Date.now();
    finishTrace(this, this.options);
    // Pop from the manual stack. Only the imperative
    // (context-manager) form pushes onto it (see
    // ``_traceControllerManual``) -- the callback form /
    // ``@traceAgent`` decorator scope their span via
    // ``_activeTraceStorage.run()`` instead, which already restores
    // the previous ALS context synchronously on return.
    // ``findIndex``-then-splice lets nested contexts be popped in
    // the right order even if a parent is ended before its child
    // (defensive -- under normal flow the child ends first).
    if (this._onManualStack) {
      const idx = _manualStack.indexOf(this);
      if (idx >= 0) _manualStack.splice(idx, 1);
    }
  }
}

/**
 * Imperative (context-manager) form: ``trace(name)`` with no
 * callback. There is no bounded scope to wrap in
 * ``AsyncLocalStorage.run()``, so this keeps the pre-existing
 * push-now/pop-on-``end()`` array stack (``_manualStack``) rather
 * than `AsyncLocalStorage.enterWith()`. `enterWith()` looks like
 * the natural imperative primitive here, but it mutates the
 * ambient store for the CURRENTLY EXECUTING async resource going
 * forward -- in a long-running host process (notably the test
 * runner's own process) that can leak the entered context into
 * completely unrelated code that later reuses the same async
 * resource, corrupting state that has nothing to do with tracing.
 * ``_manualStack`` doesn't get AsyncLocalStorage's per-chain
 * isolation, but that matches this form's pre-existing behaviour
 * exactly -- the isolation fix for concurrent/interleaved traces
 * targets `trace(name, fn)` / `@traceAgent`, both of which use the
 * properly `.run()`-scoped path below.
 */
function _traceControllerManual(name: string, opts: TraceOptions): TraceContext {
  const controller = _newController(name, opts);
  controller._onManualStack = true;
  _manualStack.push(controller);
  return controller;
}

function _newController(name: string, opts: TraceOptions): TraceController {
  const parent = currentTrace();
  return new TraceController(name, opts, parent);
}

async function _traceCallback<T>(
  name: string,
  fn: (ctx: TraceContext) => Promise<T>,
  opts: TraceOptions,
): Promise<T> {
  const controller = _newController(name, opts);
  // Scope the callback's execution (and everything it awaits,
  // however deeply) in its own AsyncLocalStorage frame. This is
  // what makes two concurrently-running, interleaved
  // ``trace(name, fn)`` calls resolve their OWN correct parent
  // instead of racing to mutate one shared "current" pointer:
  // ``run()`` snapshots + restores the ambient context around
  // this call, and any code that awaits inside ``fn`` correctly
  // sees ``controller`` as `currentTrace()` regardless of what a
  // sibling call (invoked concurrently via `Promise.all`, say)
  // does to the ambient context afterward.
  return _activeTraceStorage.run(controller, async () => {
    let result: T;
    try {
      result = await fn(controller);
      if (controller.status === null) controller.status = "ok";
    } catch (err) {
      controller.recordError(err);
      throw err;
    } finally {
      controller.end();
    }
    return result;
  });
}

function finishTrace(
  ctx: TraceContext,
  options: TraceOptions,
): void {
  const client = getDefaultClient();
  const config = client.getConfig();
  const durationMs = (ctx.endMs ?? Date.now()) - ctx.startMs;
  const outcome =
    ctx.status === "error" ? "error" : ctx.status === "unset" ? "unset" : "success";
  // Split ``ctx.error`` into a constructor name + message. The legacy
  // shape the TS tests expect is ``error_type: "Error"`` with the
  // message dropped — split on the first ":" so callers that want the
  // class name get it cleanly while ``error`` keeps the full repr.
  let errorType: string | null = null;
  let errorMessage: string | null = null;
  if (ctx.error) {
    const colonIdx = ctx.error.indexOf(": ");
    if (colonIdx > 0) {
      errorType = ctx.error.slice(0, colonIdx);
      errorMessage = ctx.error.slice(colonIdx + 2);
    } else {
      errorType = ctx.error;
    }
  }
  try {
    client.emit({
      eventId: ctx.traceId,
      tenantId: config.orgId ?? "default",
      projectId: config.projectId,
      traceId: ctx.traceId,
      realm: config.realm,
      eventType: "agent.run",
      timestamp: new Date().toISOString(),
      sourceFormat: SOURCE_FORMATS.TRACE_AGENT,
      payload: {
        // ``function`` is the legacy field name (used by the TS tests
        // and the portal's trace agent view). Keep emitting it as an
        // alias for ``name`` so existing consumers don't break.
        function: ctx.name,
        name: ctx.name,
        status: outcome,
        duration_ms: durationMs,
        error_type: errorType,
        error_message: errorMessage,
        input: ctx.input,
        output: ctx.output,
        ...options.metadata,
      },
      metrics: { duration_ms: durationMs },
      tags: ctx.tags,
      attributes: {
        "eden.span_id": ctx.spanId,
        "eden.trace_name": ctx.name,
      },
      environmentId: options.environmentId,
      spanId: ctx.spanId,
      parentSpanId: ctx.parentSpanId,
      name: ctx.name,
      durationMs,
    });
  } catch (err) {
    if (config.debug) {
      // eslint-disable-next-line no-console
      console.debug("[eden-ai] trace emit failed", err);
    }
  }
}

// ── Active-trace context so nested traces (and LLM-call spans) correlate ──

// AsyncLocalStorage-backed active-trace context for the callback form
// (`trace(name, fn)`) and the `@traceAgent` decorator -- both scope
// their span with `_activeTraceStorage.run()` (never `enterWith()`,
// see `_traceControllerManual`'s docstring for why). Replaces a
// previous module-level array (`_activeContextStack`) that was
// shared by every concurrently-running execution with NO isolation
// whatsoever: two interleaved `trace()` calls (e.g. two overlapping
// requests handled on the same event loop) could push onto the SAME
// array, and whichever pushed last "won" as the parent for BOTH
// chains, silently mis-attributing spans across unrelated traces.
// `AsyncLocalStorage.run()` tracks the store per async-causality
// chain (the same mechanism `contextvars` uses in the Python SDK),
// so concurrent `.run()`-scoped chains each resolve their own
// correct parent.
const _activeTraceStorage = new AsyncLocalStorage<TraceContext | undefined>();

// Plain stack used ONLY by the imperative (context-manager) form --
// see `_traceControllerManual`. Same "shared array, no async-chain
// isolation" limitation the old `_activeContextStack` had; that
// limitation is accepted here (matches this form's pre-existing
// behaviour) because `AsyncLocalStorage.enterWith()` is not safe to
// use imperatively in this environment.
const _manualStack: TraceContext[] = [];

/**
 * The currently-active `trace()` / `traceAgent()` span, if any, for
 * the calling async-context chain. Every instrumentation's
 * `traceIdOrRandom()` (see `ids.ts`) reads this so an LLM call made
 * inside an outer span joins it on the wire instead of always
 * minting a brand-new, unrelated `traceId`. Checks the
 * `.run()`-scoped ALS store first (properly isolated per
 * async-causality chain); falls back to the manual stack's top
 * (shared, unisolated -- see `_manualStack`) so a `trace(name)`
 * context-manager span still counts as "active" for nested manual
 * spans and instrumentation calls made outside of any `.run()`
 * scope.
 */
export function currentTrace(): TraceContext | undefined {
  return _activeTraceStorage.getStore() ?? _manualStack[_manualStack.length - 1];
}

// ── traceAgent decorator ─────────────────────────────────────────────

/**
 * Build a wrapped method that emits one `agent.run` event per
 * invocation. The wire value MUST be ``"agent.run"`` to match
 * the gateway's SQL filter (``WHERE event_type = 'agent.run'``
 * in ``src/eden/llmops/promotion.py``). The previous
 * ``"agent_call"`` value silently dropped every TS-traced
 * agent run from the promotion / cost-savings roll-ups
 * because the filter never matched.
 */
function makeWrappedMethod(
  propertyKey: string,
  original: (...a: unknown[]) => unknown,
  options: TraceOptions,
): (...a: unknown[]) => unknown {
  return function (this: unknown, ...args: unknown[]): unknown {
    const controller = _newController(
      `${(this as { constructor?: { name?: string } })?.constructor?.name ?? "Anon"}.${propertyKey}`,
      options,
    );
    // Track ``status`` separately because ``recordError`` sets
    // it to ``"error"`` and we want to mirror that on the way
    // out (without going through ``controller.setStatus`` which
    // is for the *caller's* explicit status, not auto-error
    // detection). Using ``controller.recordError`` (rather than
    // hand-rolling ``controller.error = err.constructor.name``)
    // ensures the captured error string matches the
    // ``"${ClassName}: ${message}"`` shape that
    // ``finishTrace`` splits into ``error_type`` /
    // ``error_message`` on the wire. The previous code stored
    // only the class name -- so the SDK emitted
    // ``error_type: "TypeError"`` with ``error_message: null``
    // for every decorator-thrown exception, while the Python
    // SDK's ``@trace_agent`` and the TS callback-form
    // ``trace()`` both captured the full message. This was a
    // wire divergence: the TS decorator was the only path
    // silently dropping the error message.
    let status: "success" | "error" = "success";

    const finish = () => {
      controller.setStatus(status === "error" ? "error" : "ok");
      controller.end();
    };

    // Scope the wrapped method's execution in its own
    // AsyncLocalStorage frame -- same rationale as
    // `_traceCallback`: two concurrently-running invocations of a
    // `@traceAgent`-decorated method (e.g. handling two requests
    // interleaved on the event loop) must each resolve their OWN
    // controller as `currentTrace()`, not race to overwrite a
    // single shared "current" pointer.
    return _activeTraceStorage.run(controller, () => {
      try {
        const result = original.apply(this, args);
        if (result instanceof Promise) {
          return result
            .catch((err: unknown) => {
              status = "error";
              controller.recordError(err);
              throw err;
            })
            .finally(finish);
        }
        finish();
        return result;
      } catch (err) {
        status = "error";
        controller.recordError(err);
        finish();
        throw err;
      }
    });
  };
}

/**
 * Class-method decorator.
 *
 * ```ts
 * class MyAgent {
 *   @traceAgent({ tags: ["prod"] })
 *   async run(q: string) { ... }
 * }
 * ```
 */
export function traceAgent(options: TraceOptions = {}) {
  return function decorate<This, Args extends unknown[], R>(
    _target: (this: This, ...args: Args) => R,
    context: ClassMemberDecoratorContext,
  ): (this: This, ...args: Args) => R {
    const propertyKey = String(context.name);
    return function (this: This, ...args: Args): R {
      // Wrap at call time so each call gets a fresh TraceController.
      // (Class-member decorators don't have a clean way to bind `this`.)
      const fn = _target as unknown as (...a: unknown[]) => unknown;
      return makeWrappedMethod(propertyKey, fn, options).call(
        this,
        ...(args as unknown[]),
      ) as R;
    };
  };
}


// Re-export `configure` from the client module so callers can do
// `import { configure } from "@eden-ai/sdk"` without having to
// know which internal module owns it. Tests in this package import
// it directly from `../src/trace.js` for the same reason.
export { configure } from "./client.js";
