/**
 * The TypeScript gate from packages/redact, imported by relative path (the bench is outside the workspace), plus a
 * gitleaks-only variant that runs just the rules the Rust scanner ports, as `findings()` in secrets.ts does.
 */
import { secretHits, secretRules } from "../../../packages/redact/src/secrets";

export { secretHits };

/** Sorted ids of the gitleaks rules (not Eden's `eden-*` ones) that fire on `text`, as `secretHits` finds them. */
export function gitleaksHits(text: string): string[] {
  const lower = text.toLowerCase();
  return secretRules()
    .filter((rule) => !rule.id.startsWith("eden-"))
    .filter((rule) => !rule.keywords.length || rule.keywords.some((word) => lower.includes(word)))
    .filter((rule) => rule.spans(text).length > 0)
    .map((rule) => rule.id)
    .sort();
}

/** `secretHits` restricted to gitleaks rules, for comparing the full gate's answer with the Rust port. */
export const gitleaksOnly = (ids: string[]) => ids.filter((id) => !id.startsWith("eden-"));
