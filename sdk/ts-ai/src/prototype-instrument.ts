/**
 * Prototype-level (class-level) auto-instrumentation.
 *
 * The existing `wrap*()` helpers under `src/instrumentations/` are
 * per-instance: they return a `Proxy` around a client the CALLER
 * constructed, so every call site needs `const client =
 * wrapOpenAI(new OpenAI())`. Python's `eden.instrument()` instead
 * monkey-patches the framework's class *once*, at import/init time —
 * every instance created afterwards, anywhere in the app, is traced
 * automatically with zero further code changes.
 *
 * This module gives the TS SDK the same class-level behavior for the
 * frameworks it can safely reach: it `require()`s the framework's
 * module once (Node CJS/ESM interop covers `openai` and
 * `@anthropic-ai/sdk` — both ship a `default` export that IS the
 * client class, so `mod.default ?? mod` gets the class either way)
 * and replaces the resource class's prototype method in place —
 * `OpenAI.Chat.Completions.prototype.create` and
 * `Anthropic.Messages.prototype.create` — with a wrapper that drives
 * the *exact same* instrumentation logic the per-instance `wrapOpenAI`
 * / `wrapAnthropic` Proxies use (`_instrumentedCreate`, imported from
 * each instrumentation module), so the captured span/event shape is
 * identical regardless of which mechanism produced it.
 *
 * No loader hook (`require-in-the-middle` / `import-in-the-middle`) is
 * used — but a plain `require()` alone is NOT enough, either:
 * `openai` and `@anthropic-ai/sdk` both ship a genuine **dual
 * package** (separate `./index.js` CJS build for the `"require"`
 * export condition and a separate `./index.mjs` ESM build for the
 * `"default"`/`import` condition — verified empirically under both
 * Node 22 and Bun: `require("openai") !== (await import("openai")).default`,
 * different `Chat` class objects, different prototypes entirely).
 * A consuming app that does `import OpenAI from "openai"` constructs
 * instances from a DIFFERENT class than the one `require("openai")`
 * would hand back, so patching only the CJS class's prototype would
 * silently miss every ESM-import consumer (a real, likely majority,
 * chunk of TypeScript apps). This module therefore patches BOTH:
 *   - `patchOpenAIPrototype` / `patchAnthropicPrototype` — synchronous,
 *     via `require()` (through the shared `_safeRequire` helper).
 *     Also covers the common case of a TS project compiled with
 *     `"module": "commonjs"`, where a source-level `import` is
 *     transpiled down to `require()`.
 *   - `patchOpenAIPrototypeESM` / `patchAnthropicPrototypeESM` —
 *     asynchronous, via dynamic `import()`, which resolves to the
 *     SAME cached module instance a real `import OpenAI from "openai"`
 *     elsewhere in the app resolves to (verified: dynamic and static
 *     `import` of the same specifier share one module-cache entry).
 * `instrument()` runs the sync (CJS) pass immediately — so its
 * return value's `patched` field is available synchronously, matching
 * the Python SDK's synchronous one-liner — and separately kicks off
 * the async (ESM) pass without awaiting it, exposed as
 * `patchedAsync` on the result for callers who want to `await` it
 * (e.g. a serverless cold-start that constructs its client
 * immediately after `instrument()`); real app code between
 * `instrument()` and the first LLM call almost always has an `await`
 * of its own before it, so in practice the ESM pass is done well
 * before the first real request.
 *
 * Every framework/module-format combination is loaded and patched
 * inside its own try/catch — a framework that isn't installed in the
 * consuming app (a `require`/`import` throw) or whose shape doesn't
 * match what we expect (defensive: SDKs can rename internals across
 * majors) is silently skipped, never thrown from `instrument()`.
 */

import { _safeRequire } from "./detect-installed.js";
import { _instrumentedCreate as openaiInstrumentedCreate } from "./instrumentations/openai.js";
import { _instrumentedCreate as anthropicInstrumentedCreate } from "./instrumentations/anthropic.js";
import type { TraceOptions } from "./types.js";

/** Result of a single `instrument()` call's prototype-patch pass. */
export interface PrototypePatchResult {
  openai: boolean;
  anthropic: boolean;
}

// Stamped on the REPLACEMENT function (not the original) so calling
// `patchAllPrototypes` twice — e.g. two `instrument()` calls in the
// same process — recognizes an already-patched prototype and no-ops
// instead of wrapping the wrapper.
const PATCH_MARKER = Symbol.for("@eden-ai/sdk.prototypePatched");

interface PatchRecord {
  target: Record<string, unknown>;
  prop: string;
  original: unknown;
}

// Every prototype method this module has patched, in patch order.
// Used by `_unpatchAllForTests` to restore the real SDK classes
// between test files so one test's global class-level patch can't
// leak into another test's fake-client assertions.
const _patchRecords: PatchRecord[] = [];

function _isMarked(fn: unknown): boolean {
  return (
    typeof fn === "function" &&
    (fn as unknown as { [k: symbol]: unknown })[PATCH_MARKER] === true
  );
}

/**
 * Patch `OpenAI.Chat.Completions.prototype.create` on the GIVEN
 * `OpenAI` class object (and therefore every
 * `client.chat.completions.create(...)` call on every instance of
 * THAT class constructed after this runs — including xAI's Grok,
 * which uses the identical `OpenAI` client class pointed at a
 * different `baseURL`). Shared by the sync (CJS `require`) and async
 * (dynamic `import()`) entry points below — see the module doc for
 * why both exist (dual CJS/ESM package builds resolve to genuinely
 * different class objects).
 */
function _applyOpenAIPatch(
  OpenAICls: { Chat?: { Completions?: { prototype?: Record<string, unknown> } } } | null | undefined,
  opts: TraceOptions,
): boolean {
  const proto = OpenAICls?.Chat?.Completions?.prototype;
  if (!proto || typeof proto.create !== "function") return false;
  if (_isMarked(proto.create)) return true;

  const original = proto.create as (...args: unknown[]) => unknown;
  const patched = function (this: unknown, ...args: unknown[]): unknown {
    // `this` is the `Completions` resource instance; the OpenAI
    // SDK stashes the owning client on `this._client`, which is
    // where `baseURL` lives — the only thing that distinguishes an
    // xAI (Grok) client from a real OpenAI client, since both use
    // the identical `OpenAI` class.
    const client = (this as { _client?: { baseURL?: unknown } } | undefined)?._client;
    const baseURL = typeof client?.baseURL === "string" ? client.baseURL : "";
    const provider = baseURL.includes("x.ai") ? "xai" : "openai";
    const bound = original.bind(this);
    return openaiInstrumentedCreate(bound, this, args, opts, provider);
  };
  (patched as unknown as { [k: symbol]: unknown })[PATCH_MARKER] = true;
  proto.create = patched;
  _patchRecords.push({ target: proto, prop: "create", original });
  return true;
}

/**
 * Patch `Anthropic.Messages.prototype.create` on the GIVEN
 * `Anthropic` class object — every `client.messages.create(...)`
 * call on every instance of THAT class constructed after this runs
 * is traced automatically. Shared by the sync/async entry points
 * below for the same dual-package reason as `_applyOpenAIPatch`.
 */
function _applyAnthropicPatch(
  AnthropicCls: { Messages?: { prototype?: Record<string, unknown> } } | null | undefined,
  opts: TraceOptions,
): boolean {
  const proto = AnthropicCls?.Messages?.prototype;
  if (!proto || typeof proto.create !== "function") return false;
  if (_isMarked(proto.create)) return true;

  const original = proto.create as (...args: unknown[]) => unknown;
  const patched = function (this: unknown, ...args: unknown[]): unknown {
    const bound = original.bind(this);
    return anthropicInstrumentedCreate(bound, this, args, opts);
  };
  (patched as unknown as { [k: symbol]: unknown })[PATCH_MARKER] = true;
  proto.create = patched;
  _patchRecords.push({ target: proto, prop: "create", original });
  return true;
}

/**
 * Synchronous pass, via `require()` (through `_safeRequire`, which
 * itself falls back to a synthesized `createRequire` under pure ESM).
 * Covers direct `require("openai")` consumers and TS projects
 * compiled with `"module": "commonjs"` (a source-level `import`
 * transpiles down to `require()`, landing on this same CJS class
 * object). Returns `true` if the `openai` package was found and
 * (already was, or now is) patched; `false` if the package isn't
 * installed or its shape didn't match what we expect.
 */
export function patchOpenAIPrototype(opts: TraceOptions = {}): boolean {
  try {
    const mod = _safeRequire("openai") as
      | { default?: unknown; Chat?: unknown }
      | null
      | undefined;
    if (!mod) return false;
    const OpenAICls = (mod.default ?? mod) as {
      Chat?: { Completions?: { prototype?: Record<string, unknown> } };
    };
    return _applyOpenAIPatch(OpenAICls, opts);
  } catch {
    // Package not installed, or its internals don't match the shape
    // we expect (defensive against future major-version reshuffles).
    return false;
  }
}

/**
 * Async pass, via dynamic `import("openai")` — resolves to the SAME
 * cached module instance a real `import OpenAI from "openai"`
 * elsewhere in the consuming app resolves to (verified: dynamic and
 * static `import` of one specifier share a single module-cache
 * entry), which is a genuinely DIFFERENT class object than the one
 * `require("openai")` returns for this package (dual CJS/ESM build).
 * Covers native-ESM consumers the sync pass above cannot reach.
 */
export async function patchOpenAIPrototypeESM(opts: TraceOptions = {}): Promise<boolean> {
  try {
    const mod = (await import("openai")) as { default?: unknown; Chat?: unknown };
    const OpenAICls = (mod.default ?? mod) as {
      Chat?: { Completions?: { prototype?: Record<string, unknown> } };
    };
    return _applyOpenAIPatch(OpenAICls, opts);
  } catch {
    return false;
  }
}

/**
 * Synchronous pass, via `require()`. See `patchOpenAIPrototype` doc
 * for what this covers. Returns `true` if the `@anthropic-ai/sdk`
 * package was found and (already was, or now is) patched; `false`
 * otherwise.
 */
export function patchAnthropicPrototype(opts: TraceOptions = {}): boolean {
  try {
    const mod = _safeRequire("@anthropic-ai/sdk") as
      | { default?: unknown; Anthropic?: unknown }
      | null
      | undefined;
    if (!mod) return false;
    const AnthropicCls = (mod.default ?? mod.Anthropic ?? mod) as {
      Messages?: { prototype?: Record<string, unknown> };
    };
    return _applyAnthropicPatch(AnthropicCls, opts);
  } catch {
    return false;
  }
}

/**
 * Async pass, via dynamic `import("@anthropic-ai/sdk")`. See
 * `patchOpenAIPrototypeESM` doc for why this exists (dual CJS/ESM
 * package build) — covers native-ESM consumers the sync pass above
 * cannot reach.
 */
export async function patchAnthropicPrototypeESM(opts: TraceOptions = {}): Promise<boolean> {
  try {
    const mod = (await import("@anthropic-ai/sdk")) as {
      default?: unknown;
      Anthropic?: unknown;
    };
    const AnthropicCls = (mod.default ?? mod.Anthropic ?? mod) as {
      Messages?: { prototype?: Record<string, unknown> };
    };
    return _applyAnthropicPatch(AnthropicCls, opts);
  } catch {
    return false;
  }
}

/**
 * Patch every framework this module knows how to class-level patch,
 * synchronously (CJS `require` pass only — see the module doc). Safe
 * to call more than once (each individual patch is idempotent) and
 * never throws — a framework that isn't installed, or whose
 * internals don't match, is just reported `false`.
 */
export function patchAllPrototypes(opts: TraceOptions = {}): PrototypePatchResult {
  return {
    openai: patchOpenAIPrototype(opts),
    anthropic: patchAnthropicPrototype(opts),
  };
}

/**
 * Patch every framework this module knows how to class-level patch,
 * asynchronously (dynamic `import()` pass — covers native-ESM
 * consumers `patchAllPrototypes`'s CJS `require` pass can't reach;
 * see the module doc for why both passes exist). Safe to call more
 * than once and never throws.
 */
export async function patchAllPrototypesAsync(
  opts: TraceOptions = {},
): Promise<PrototypePatchResult> {
  const [openai, anthropic] = await Promise.all([
    patchOpenAIPrototypeESM(opts),
    patchAnthropicPrototypeESM(opts),
  ]);
  return { openai, anthropic };
}

/**
 * Test-only: restore every prototype method this module has patched
 * back to the original, and forget the patch records. Exists so the
 * test suite can run `instrument()`'s prototype-patch pass in
 * isolation (without a real, permanently class-level-patched `OpenAI`
 * / `Anthropic` bleeding from one test file's process into another's,
 * since prototype patches are process-global mutable state, not
 * per-test-file state).
 */
export function _unpatchAllForTests(): void {
  while (_patchRecords.length > 0) {
    const rec = _patchRecords.pop();
    if (!rec) continue;
    rec.target[rec.prop] = rec.original;
  }
}
