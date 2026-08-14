/**
 * Assistant thread boot — never invent a thread on a bare visit (R003/R028).
 */
export function shouldCreateThreadOnVisit(opts: {
  hasHandoffPins: boolean;
  hasPrompt: boolean;
  threadParam: string | null;
}): boolean {
  if (opts.hasHandoffPins) return true;
  if (opts.hasPrompt) return true;
  if (opts.threadParam === "thr_empty") return true;
  return false;
}
