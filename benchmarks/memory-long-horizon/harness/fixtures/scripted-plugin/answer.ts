/**
 * Harness self-test plugin: answers each hook from a table, so a test knows every packet in advance.
 * SCRIPTED_ANSWERS names a JSON list of `{ event, when, context?, decision? }`. The first rule whose `event`
 * is the hook's and whose `when` occurs in the raw payload answers with that context and permission decision.
 * With no matching rule it prints nothing. It never writes a file.
 */
interface Rule {
  event: string;
  when: string;
  context?: string;
  decision?: "ask" | "allow" | "deny";
}

const raw = await Bun.stdin.text();
const event = (JSON.parse(raw) as { hook_event_name: string }).hook_event_name;
const rules = (await Bun.file(process.env.SCRIPTED_ANSWERS!).json()) as Rule[];
const rule = rules.find((candidate) => candidate.event === event && raw.includes(candidate.when));
if (rule) {
  const output: Record<string, string> = { hookEventName: event };
  if (rule.context !== undefined) output.additionalContext = rule.context;
  if (rule.decision !== undefined) output.permissionDecision = rule.decision;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
}
