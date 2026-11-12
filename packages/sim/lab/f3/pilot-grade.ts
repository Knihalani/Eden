/**
 * F3 (D1125): the pilot's grading prompts (the harness's own `gradeMessages`) from the subagents' answers, and the
 * graded rows back. Sim data only.
 *
 *   bun packages/sim/lab/f3/pilot-grade.ts build .local/f3/pilot     # a*.out.txt → g*.in.jsonl
 *   bun packages/sim/lab/f3/pilot-grade.ts join .local/f3/pilot      # g*.out.txt → graded.jsonl
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gradeMessages, readVerdicts, type Task } from "../../src/lab/ab-common";

const [mode, dir] = [process.argv[2]!, process.argv[3]!];
const blocks = (file: string) => {
  const out = new Map<string, string>();
  const text = readFileSync(file, "utf8");
  for (const part of text.split(/^=== /m).slice(1)) {
    const nl = part.indexOf("\n");
    out.set(part.slice(0, nl).trim(), part.slice(nl + 1).trim());
  }
  return out;
};
const answers = new Map<string, string>();
for (const f of readdirSync(dir).filter((f) => /^a\d+\.out\.txt$/.test(f))) {
  for (const [k, v] of blocks(`${dir}/${f}`)) answers.set(k, v);
}
const tasks = readFileSync(`${dir}/tasks.jsonl`, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const gradeKey = (t: { prompt: string; variant: string; detail: string }) =>
  createHash("sha256").update(`${t.prompt}\u0000${t.variant}\u0000${t.detail}`).digest("hex").slice(0, 12);
// Grades already on file (`g*.out.txt`, e.g. carried over from an earlier pilot for the same prompt, variant and fact).
const graded = new Set<string>();
for (const f of readdirSync(dir).filter((f) => /^g\d+\.out\.txt$/.test(f))) {
  for (const k of blocks(`${dir}/${f}`).keys()) graded.add(k);
}
if (mode === "build") {
  const seen = new Map<string, { id: string; system: string; user: string; arm: string }>();
  let missing = 0;
  for (const t of tasks) {
    const answer = answers.get(t.prompt);
    if (answer === undefined) {
      missing++;
      continue;
    }
    const id = gradeKey(t);
    if (seen.has(id) || graded.has(id)) continue;
    const task = { kind: t.variant, text: t.request, must: [{ id: t.template, detail: t.detail }] } as unknown as Task;
    const [sys, user] = gradeMessages(task, answer);
    seen.set(id, { id, system: String(sys!.content), user: String(user!.content), arm: t.arm });
  }
  // Batches by the arm a grade first appears in, so no grader sees two arms' answers to one task.
  const byArm = new Map<string, { id: string; system: string; user: string }[]>();
  for (const g of seen.values()) byArm.set(g.arm, [...(byArm.get(g.arm) ?? []), g]);
  // New batches are numbered after any on file.
  let n =
    Math.max(
      -1,
      ...readdirSync(dir)
        .flatMap((f) => /^g(\d+)\.(in|out)\./.exec(f)?.[1] ?? [])
        .map(Number),
    ) + 1;
  for (const [, gs] of byArm) {
    for (let i = 0; i < gs.length; i += 30) {
      const name = `g${String(n++).padStart(2, "0")}`;
      writeFileSync(
        `${dir}/${name}.in.jsonl`,
        gs
          .slice(i, i + 30)
          .map(({ id, system, user }) => JSON.stringify({ id, system, user }))
          .join("\n") + "\n",
      );
    }
  }
  console.log(`${seen.size} new grades (${graded.size} on file); ${missing} arm-tasks without an answer`);
} else {
  const verdicts = new Map<string, boolean>();
  for (const f of readdirSync(dir).filter((f) => /^g\d+\.out\.txt$/.test(f))) {
    for (const [k, v] of blocks(`${dir}/${f}`)) verdicts.set(k, readVerdicts(v).get("1") === true);
  }
  const rows = tasks.map((t) => ({ ...t, raised: verdicts.get(gradeKey(t)) ?? null, answer: answers.get(t.prompt) }));
  writeFileSync(`${dir}/graded.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`${rows.filter((r) => r.raised !== null).length} of ${rows.length} graded`);
}
