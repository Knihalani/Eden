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
  return _traceController(name, fnOrOpts ?? {});
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
    // Pop from the active-context stack. ``findIndex`` lets nested
    // contexts be popped in the right order even if a parent is
    // ended before its child (defensive — under normal flow the
    // child ends first). Without this pop the stack grows
    // unboundedly and ``_activeContext`` keeps returning the
    // deepest dead span as the new parent.
    const idx = _activeContextStack.indexOf(this);
    if (idx >= 0) _activeContextStack.splice(idx, 1);
  }
}

function _traceController(name: string, opts: TraceOptions): TraceContext {
  const parent = _activeContext();
  const controller = new TraceController(name, opts, parent);
  _activeContextStack.push(controller);
  return controller;
}

async function _traceCallback<T>(
  name: string,
  fn: (ctx: TraceContext) => Promise<T>,
  opts: TraceOptions,
): Promise<T> {
  const controller = _traceController(name, opts) as TraceController;
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

// ── Active-trace contextvar so nested traces correlate ───────────────

// Simple module-level stack for nested-trace correlation. Not safe
// across worker threads, but matches the Python SDK's behaviour
// (ContextVars in Python don't cross threads either).
const _activeContextStack: TraceContext[] = [];
function _activeContext(): TraceContext | undefined {
  return _activeContextStack[_activeContextStack.length - 1];
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
    const controller = _traceController(
      `${(this as { constructor?: { name?: string } })?.constructor?.name ?? "Anon"}.${propertyKey}`,
      options,
    ) as TraceController;
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
