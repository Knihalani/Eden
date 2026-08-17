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
