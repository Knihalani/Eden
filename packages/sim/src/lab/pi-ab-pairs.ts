import { pairedWith } from "./pi-conditions";

/** Keep root comparisons; add last-flag comparisons only when their exact baseline ran. */
export function reportPairs(
  conditions: readonly string[],
  initial: readonly (readonly [string, string])[] = [],
): [string, string][] {
  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  const present = new Set(conditions);
  const add = (a: string, b: string) => {
    const key = JSON.stringify([a, b]);
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push([a, b]);
  };
  for (const [a, b] of initial) add(a, b);
  for (const condition of conditions) {
    const root = pairedWith(condition);
    if (root) add(condition, root);
  }
  for (const condition of conditions) {
    const at = condition.lastIndexOf("+");
    if (at < 0) continue;
    const flag = condition.slice(at).match(/^\+[a-zA-Z]+(?=[~@]|$)/)?.[0];
    if (!flag) continue;
    const baseline = condition.slice(0, at) + condition.slice(at + flag.length);
    if (present.has(baseline)) add(condition, baseline);
  }
  return pairs;
}
