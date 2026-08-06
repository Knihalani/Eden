/**
 * Convenience `instrument()` helper for the TypeScript SDK.
 *
 * Enables universal HTTP capture (fetch patching) and returns `wrap*`
 * factory helpers for native framework instrumentation.
 */

import { installHttpCapture } from "./http-capture.js";
import {
  patchAllPrototypes,
  patchAllPrototypesAsync,
  type PrototypePatchResult,
} from "./prototype-instrument.js";
import { wrapAnthropic } from "./instrumentations/anthropic.js";
import { wrapCohere } from "./instrumentations/cohere.js";
import { wrapGroq } from "./instrumentations/groq.js";
import { wrapLangChain } from "./instrumentations/langchain.js";
import { wrapLlamaIndex } from "./instrumentations/llamaindex.js";
import { wrapMastra } from "./instrumentations/mastra.js";
import { wrapMistral } from "./instrumentations/mistral.js";
import { wrapOpenAI, wrapXai } from "./instrumentations/openai.js";
import { wrapBedrock, wrapGemini } from "./instrumentations/providers.js";
import { wrapVercelAI } from "./instrumentations/vercel-ai.js";
import {
  detectInstalledFrameworks,
  type AutoInstrumentResult,
} from "./detect-installed.js";
import type { TraceOptions } from "./types.js";

export interface InstrumentOptions extends TraceOptions {
  /**
   * When true, patch global fetch for LLM HTTP capture.
   * Default is false when callers use wrap* helpers (avoids double emit).
   * Pass ``httpCapture: true`` to opt in.
   */
  httpCapture?: boolean;
  /**
   * When true (the default), patch supported frameworks' client
   * classes at the prototype level so every instance constructed
   * AFTER `instrument()` runs is traced automatically — no `wrap*()`
   * call needed at each call site. Mirrors the Python SDK's
   * `eden.instrument()` one-liner UX. Currently covers OpenAI (and,
   * transitively, xAI/Grok — same client class) and Anthropic; see
   * `patched` on the return value for which frameworks actually got
   * patched in THIS process (a framework absent from the consuming
   * app's `node_modules` is silently skipped, not an error).
   *
   * The `wrap*()` factories keep working unchanged for callers who
   * prefer explicit per-instance wrapping, or for frameworks this
   * pass doesn't cover yet — this is additive, not a replacement.
   * Pass ``autoPatch: false`` to opt out entirely (e.g. if a caller
   * wants the old wrap*-only behavior).
   */
  autoPatch?: boolean;
}

export interface InstrumentResult {
  detected: AutoInstrumentResult;
  /**
   * Which frameworks got real prototype-level (class-level)
   * auto-instrumentation applied SYNCHRONOUSLY in THIS process (the
   * `require()`-reachable class — see `patchedAsync` below for the
   * `import()`-reachable one), i.e. every subsequently-constructed
   * client instance built from THAT class is now traced with zero
   * further code changes. Empty/`false` entries mean the package
   * wasn't found via `require()` (or `autoPatch: false` was passed) —
   * the `wrap*()` factories below still work for those.
   */
  patched: PrototypePatchResult;
  /**
   * Resolves once the ASYNC (dynamic `import()`) prototype-patch pass
   * finishes. `openai` and `@anthropic-ai/sdk` both ship separate CJS
   * and ESM builds that resolve to genuinely different class objects
   * (a dual-package hazard, verified empirically) — `patched` above
   * only covers the `require()`-reachable class, so a consuming app
   * that does `import OpenAI from "openai"` needs this pass instead.
   * Not awaited internally, so `instrument()` itself stays
   * synchronous; most callers can safely ignore this promise (the
   * patch still lands in the background before the app's first real
   * LLM call in virtually all real code paths). Await it directly if
   * you need certainty before constructing a client — e.g. a
   * serverless handler that imports+constructs immediately after
   * `instrument()` with no `await` of its own in between.
   */
  patchedAsync: Promise<PrototypePatchResult>;
  wrapOpenAI: typeof wrapOpenAI;
  wrapXai: typeof wrapXai;
  wrapAnthropic: typeof wrapAnthropic;
  wrapVercelAI: typeof wrapVercelAI;
  wrapLangChain: typeof wrapLangChain;
  wrapMastra: typeof wrapMastra;
  wrapBedrock: typeof wrapBedrock;
  wrapGemini: typeof wrapGemini;
  wrapLlamaIndex: typeof wrapLlamaIndex;
  wrapGroq: typeof wrapGroq;
  wrapCohere: typeof wrapCohere;
  wrapMistral: typeof wrapMistral;
}

export function instrument(opts: InstrumentOptions = {}): InstrumentResult {
  if (opts.httpCapture === true) {
    installHttpCapture(opts);
  }
  // Real one-liner UX (mirrors Python's `eden.instrument()`): patch
  // supported frameworks' client classes at the prototype level so
  // every instance constructed from here on is traced automatically,
  // with no `wrap*()` call needed at any call site. Opt out with
  // `autoPatch: false`. Never throws — missing/unexpected-shape
  // packages are reported `false` in `patched`, not an error.
  const autoPatchEnabled = opts.autoPatch !== false;
  const patched: PrototypePatchResult = autoPatchEnabled
    ? patchAllPrototypes(opts)
    : { openai: false, anthropic: false };
  // Fire-and-forget: covers native-ESM consumers the sync (CJS
  // `require`) pass above can't reach. See `patchedAsync`'s doc for
  // why this is a genuinely separate pass, not redundant with the
  // one above.
  const patchedAsync = autoPatchEnabled
    ? patchAllPrototypesAsync(opts)
    : Promise.resolve<PrototypePatchResult>({ openai: false, anthropic: false });
  return {
    detected: detectInstalledFrameworks(opts),
    patched,
    patchedAsync,
    wrapOpenAI,
    wrapXai,
    wrapAnthropic,
    wrapVercelAI,
    wrapLangChain,
    wrapMastra,
    wrapBedrock,
    wrapGemini,
    wrapLlamaIndex,
    wrapGroq,
    wrapCohere,
    wrapMistral,
  };
}
