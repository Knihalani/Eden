export function steerTemplate(toolName: string, whenToUse: string): string {
  return `Call Eden tool ${toolName} instead of this stretch. ${whenToUse}`.trim();
}

export type SteerDecision = { action: "allow" } | { action: "deny"; reason: string; tool: string };

export function matchPrefix(
  live: { name: string; seen: string[]; required_k: number }[],
  seenThisRun: string[],
  incoming: string,
): SteerDecision {
  const next = [...seenThisRun, incoming];
  for (const tool of live) {
    if (tool.seen.length === 0) continue;
    const need = Math.max(1, tool.required_k);
    const prefix = tool.seen.slice(0, need);
    if (prefix.length > next.length) continue;
    for (let start = 0; start <= next.length - prefix.length; start++) {
      if (prefix.every((p, i) => next[start + i] === p)) {
        return { action: "deny", reason: steerTemplate(tool.name, ""), tool: tool.name };
      }
    }
  }
  return { action: "allow" };
}
