/**
 * Convenience `instrument()` helper for the TypeScript SDK.
 *
 * Enables universal HTTP capture (fetch patching) and returns `wrap*`
 * factory helpers for native framework instrumentation.
 */

import { installHttpCapture } from "./http-capture.js";
import { wrapAnthropic } from "./instrumentations/anthropic.js";
import { wrapLangChain } from "./instrumentations/langchain.js";
import { wrapMastra } from "./instrumentations/mastra.js";
import { wrapOpenAI } from "./instrumentations/openai.js";
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
}

export interface InstrumentResult {
  detected: AutoInstrumentResult;
  wrapOpenAI: typeof wrapOpenAI;
  wrapAnthropic: typeof wrapAnthropic;
  wrapVercelAI: typeof wrapVercelAI;
  wrapLangChain: typeof wrapLangChain;
  wrapMastra: typeof wrapMastra;
}

export function instrument(opts: InstrumentOptions = {}): InstrumentResult {
  if (opts.httpCapture === true) {
    installHttpCapture(opts);
  }
  return {
    detected: detectInstalledFrameworks(opts),
    wrapOpenAI,
    wrapAnthropic,
    wrapVercelAI,
    wrapLangChain,
    wrapMastra,
  };
}
