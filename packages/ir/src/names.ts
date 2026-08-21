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
export const CHECK_VERBS = ["verify", "validate", "assert", "check", "confirm", "ensure"] as const;
export const CHECK_NAME = new RegExp(`^(${CHECK_VERBS.join("|")})([A-Z0-9_].*)?$`, "i");
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
  const head = nameWords(name)[0];
  return Boolean(head && (CHECK_VERBS as readonly string[]).includes(head));
}

/**
 * Does this name describe an operation that changes something?
 *
 * The check-name test used to short-circuit *before* the verb test, and
 * CHECK_NAME is unanchored — so any mutating tool whose name happens to
 * contain a check word was reported as a read. `delete_check_run`,
 * `update_check_run` and `create_check_suite` are all real GitHub operations
 * and all three came back false, which skipped the compiler's mutating-tool
 * guards (the Jaccard threshold, the 92% trap, the empty-args refusal) and
 * compiled a write in as an ordinary read. `confirm_and_delete` and
 * `send_verification_email` are the same shape.
 *
 * An explicit mutating verb at the front of the name is the stronger signal,
 * so it is tested first — and once it is, the check-name exclusion has nothing
 * left to do: a name that does not begin with a mutating verb already answers
 * false. It is gone rather than reordered.
 */
/** Split a tool name into words: snake, kebab, dotted and camel all count. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const isMutatingWord = (w: string): boolean => MUTATING_VERBS.includes(w as (typeof MUTATING_VERBS)[number]);

export function isMutating(name: string): boolean {
  const words = nameWords(name);
  // The first word is the verb and the rest are its object. That distinction
  // is the whole difference between `verifyWrite`, which reads back a write,
  // and `delete_check_run`, which deletes a check run — and getting it wrong
  // in either direction is expensive. CHECK_NAME used to short-circuit the
  // whole function, and being unanchored it caught the second case as well as
  // the first, so `delete_check_run`, `update_check_run` and
  // `create_check_suite` all reported as reads and skipped the compiler's
  // mutating-tool guards.
  const head = words[0];
  if (head && isMutatingWord(head)) return true;
  if (head && CHECK_NAME.test(head)) return false;
  // No verb at the head: fall back to any mutating word, so a name that leads
  // with a noun still gets recognised.
  return words.some(isMutatingWord);
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
