export const MUTATING_VERBS = [
  "write",
  "create",
  "update",
  "delete",
  "send",
  "notify",
  "post",
  "put",
  "patch",
  "insert",
  "remove",
  "destroy",
  "drop",
  "publish",
  "upsert",
] as const;

export const MUTATING = new RegExp(`^(${MUTATING_VERBS.join("|")})([A-Z0-9_].*)?$`);
export const ISLAND_NAME = /draft|reply|generate|summarize|compose|llm|narrate|prose/i;
export const CHECK_NAME = /verify|validate|assert|check|confirm|ensure/i;
export const STRETCH_END = /^(notify|complete|finalize|done)$/i;
export const READ_NAME = /^(lookup|fetch|get|read|list|search|find|describe|show|head)/i;

/**
 * How often a *check* must appear across witnesses to be compiled in, as a
 * fraction. Deliberately below the bar for ordinary tools: the agent skipping
 * its own verify step some of the time is the unreliability Eden exists to fix,
 * so a check that shows up most of the time gets pinned into the program rather
 * than mined away.
 *
 * Shared so the two gates cannot drift: mine.ts decides whether the check makes
 * it into the mined sequence at all, and compile.ts decides whether to emit a
 * step for it. A stricter mine-side gate silently defeats the compile-side one.
 */
export const CHECK_MIN_SUPPORT = 0.7;

export function isCheckName(name: string): boolean {
  return CHECK_NAME.test(name);
}

export function isMutating(name: string): boolean {
  if (isCheckName(name)) return false;
  const lower = name.toLowerCase();
  for (const verb of MUTATING_VERBS) {
    if (lower === verb) return true;
    if (lower.startsWith(verb) && name.length > verb.length && /[A-Z0-9_]/.test(name[verb.length]!)) return true;
  }
  return false;
}

export function isIslandName(name: string): boolean {
  return ISLAND_NAME.test(name);
}

export function isStretchEnd(name: string): boolean {
  return STRETCH_END.test(name);
}

export function isReadName(name: string): boolean {
  return READ_NAME.test(name);
}

export function isBarrierName(name: string): boolean {
  return isMutating(name) || isCheckName(name);
}
