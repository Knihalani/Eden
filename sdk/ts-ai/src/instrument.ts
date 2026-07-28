/**
 * Convenience `instrument()` helper for the TypeScript SDK.
 *
 * Enables universal HTTP capture (fetch patching) and returns `wrap*`
 * factory helpers for native framework instrumentation.
 */

import { installHttpCapture } from "./http-capture.js";
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
}

export interface InstrumentResult {
  detected: AutoInstrumentResult;
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
  return {
    detected: detectInstalledFrameworks(opts),
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
