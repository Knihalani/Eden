/**
 * Framework detection helpers (shared by index + instrument).
 */

import type { TraceOptions } from "./types.js";

export interface AutoInstrumentResult {
  openai: boolean;
  anthropic: boolean;
  vercelAi: boolean;
  langchain: boolean;
  mastra: boolean;
}

function _safeRequire(name: string): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-eval
    const fn = (eval("require")) as NodeJS.Require;
    return fn(name);
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = (globalThis as any).process;
      if (!proc) return null;
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
      const getBuiltin = (proc as any).getBuiltinModule as
        | ((name: string) => { createRequire?: (url: string) => (id: string) => unknown } | undefined)
        | undefined;
      const m = typeof getBuiltin === "function" ? getBuiltin("module") : null;
      if (m && typeof m.createRequire === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const meta = (import.meta as any) ?? { url: `file://${proc.cwd()}/index.js` };
        return m.createRequire(meta.url)(name);
      }
      return null;
    } catch {
      return null;
    }
  }
}

export function detectInstalledFrameworks(
  _opts: TraceOptions = {},
): AutoInstrumentResult {
  const result: AutoInstrumentResult = {
    openai: false,
    anthropic: false,
    vercelAi: false,
    langchain: false,
    mastra: false,
  };
  try {
    if (_safeRequire("openai")) result.openai = true;
  } catch {
    // not installed
  }
  try {
    if (_safeRequire("@anthropic-ai/sdk")) result.anthropic = true;
  } catch {
    // not installed
  }
  try {
    if (_safeRequire("ai")) result.vercelAi = true;
  } catch {
    // not installed
  }
  try {
    if (_safeRequire("@langchain/core")) result.langchain = true;
  } catch {
    // not installed
  }
  try {
    if (_safeRequire("@mastra/core") || _safeRequire("mastra")) result.mastra = true;
  } catch {
    // not installed
  }
  void _opts;
  return result;
}

export function autoInstrument(opts: TraceOptions = {}): AutoInstrumentResult {
  return detectInstalledFrameworks(opts);
}
